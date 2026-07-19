"""stdlib assert 测试：删除 CPA 异常账号。容器内运行，临时 DB 隔离。"""
import os, sys, tempfile, json

_tmpdir = tempfile.mkdtemp(prefix="cpa_delete_test_")
os.environ["GROK_REGISTER_LITE_DATA_DIR"] = _tmpdir
os.environ["GROK_REGISTER_LITE_DB"] = os.path.join(_tmpdir, "test.sqlite3")
os.environ["GROK_REGISTER_LITE_OUTPUT_DIR"] = os.path.join(_tmpdir, "outputs")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import register_lite_store as store  # noqa: E402


# ---------- Task 1: 配置字段 ----------

def test_config_defaults_auto_delete_off():
    cfg = store.normalize_cpa_config({})
    assert cfg["auto_delete_abnormal"] is False, cfg
    assert cfg["auto_delete_min_interval_sec"] == 300, cfg


def test_config_normalizes_auto_delete():
    cfg = store.normalize_cpa_config({
        "auto_delete_abnormal": 1,
        "auto_delete_min_interval_sec": "45",  # 低于下限 60，钳制到 60
    })
    assert cfg["auto_delete_abnormal"] is True, cfg
    assert cfg["auto_delete_min_interval_sec"] == 60, cfg


# ---------- Task 2: CPA 删除 HTTP 层 ----------

import io
import urllib.error


class _FakeResp:
    def __init__(self, status, body=b"{}"):
        self.status = status
        self._body = body
    def read(self):
        return self._body
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


def _patch_urlopen(monkey_status=None, raise_http=None):
    """返回一个替换 store._urlopen 的函数；记录最后一次请求的 URL/method。"""
    calls = {}
    def fake(req, *, timeout):
        calls["url"] = req.full_url
        calls["method"] = req.get_method()
        if raise_http is not None:
            code, body = raise_http
            raise urllib.error.HTTPError(req.full_url, code, "err", {}, io.BytesIO(body))
        return _FakeResp(monkey_status)
    fake.calls = calls
    return fake


_CFG = {"base_url": "https://cpa.example", "management_key": "mk"}


def test_delete_http_2xx_ok():
    orig = store._urlopen
    store._urlopen = _patch_urlopen(monkey_status=200)
    try:
        r = store._delete_cpa_auth_file_by_name("xai-a@ex.com.json", _CFG)
    finally:
        store._urlopen = orig
    assert r["ok"] is True, r
    assert r["status"] == 200, r


def test_delete_http_uses_query_and_delete_method():
    orig = store._urlopen
    fake = _patch_urlopen(monkey_status=200)
    store._urlopen = fake
    try:
        store._delete_cpa_auth_file_by_name("xai-a@ex.com.json", _CFG)
    finally:
        store._urlopen = orig
    assert "/v0/management/auth-files?" in fake.calls["url"], fake.calls
    assert "name=xai-a" in fake.calls["url"], fake.calls
    assert fake.calls["method"] == "DELETE", fake.calls


def test_delete_http_404_is_ok():
    orig = store._urlopen
    store._urlopen = _patch_urlopen(raise_http=(404, b'{"error":"file not found"}'))
    try:
        r = store._delete_cpa_auth_file_by_name("missing.json", _CFG)
    finally:
        store._urlopen = orig
    assert r["ok"] is True, r
    assert r["status"] == 404, r


def test_delete_http_401_is_fail():
    orig = store._urlopen
    store._urlopen = _patch_urlopen(raise_http=(401, b'{"error":"bad key"}'))
    try:
        r = store._delete_cpa_auth_file_by_name("x.json", _CFG)
    finally:
        store._urlopen = orig
    assert r["ok"] is False, r
    assert r["status"] == 401, r
    assert "error" in r, r


def test_delete_http_500_is_fail():
    orig = store._urlopen
    store._urlopen = _patch_urlopen(raise_http=(500, b"boom"))
    try:
        r = store._delete_cpa_auth_file_by_name("x.json", _CFG)
    finally:
        store._urlopen = orig
    assert r["ok"] is False, r
    assert r["status"] == 500, r


# ---------- Task 3: 核心编排 delete_cpa_abnormal ----------

import time as _time


def _seed_account(email):
    """插一条最小 accounts 行（复用 import_auth_payload 保证列齐全）。"""
    store.init_db()
    store.import_auth_payload({
        "key": "tok_" + email.replace("@", "_"),
        "email": email,
        "refresh_token": "rt_" + email,
    })


def _seed_remote(email, classification, file_name=None):
    """插一条 remote_accounts(provider='cpa') 行，raw_json 里含 file_name。"""
    store.init_db()
    raw = {"email": email, "classification": classification}
    if file_name is not None:
        raw["file_name"] = file_name
    with store._connect() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO remote_accounts
              (provider, remote_id, email, classification, http_status, action,
               reason, auth_status, disabled, model, raw_json, seen_at)
            VALUES ('cpa', ?, ?, ?, NULL, '', '', '', NULL, '', ?, ?)
            """,
            (email, email, classification, json.dumps(raw), _time.time()),
        )


def _account_exists(email):
    with store._connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM accounts WHERE lower(email)=?", (email.lower(),)
        ).fetchone()
    return row is not None


_CFG_FULL = {"base_url": "https://cpa.example", "management_key": "mk"}


def test_abnormal_emails_from_remote_filters():
    _seed_remote("bad1@ex.com", "reauth")
    _seed_remote("bad2@ex.com", "quota_exhausted")
    _seed_remote("bad3@ex.com", "permission_denied")
    _seed_remote("good@ex.com", "healthy")
    got = set(store._abnormal_emails_from_remote())
    assert "bad1@ex.com" in got and "bad2@ex.com" in got and "bad3@ex.com" in got, got
    assert "good@ex.com" not in got, got


def test_delete_skips_healthy_no_cpa_call():
    _seed_account("keep@ex.com")
    _seed_remote("keep@ex.com", "healthy")
    orig = store._urlopen
    called = {"n": 0}
    def fake(req, *, timeout):
        called["n"] += 1
        return _FakeResp(200)
    store._urlopen = fake
    try:
        r = store.delete_cpa_abnormal(["keep@ex.com"], config=_CFG_FULL)
    finally:
        store._urlopen = orig
    assert called["n"] == 0, "healthy 不应调用 CPA"
    assert r["deleted"] == 0, r
    assert len(r["skipped"]) == 1, r
    assert _account_exists("keep@ex.com"), "healthy 本地应保留"


def test_delete_success_removes_local():
    _seed_account("bad@ex.com")
    _seed_remote("bad@ex.com", "reauth", file_name="xai-bad@ex.com.json")
    orig = store._urlopen
    fake = _patch_urlopen(monkey_status=200)
    store._urlopen = fake
    try:
        r = store.delete_cpa_abnormal(["bad@ex.com"], config=_CFG_FULL)
    finally:
        store._urlopen = orig
    assert "name=xai-bad" in fake.calls["url"], fake.calls  # 用了 raw_json.file_name
    assert r["deleted"] == 1, r
    assert not _account_exists("bad@ex.com"), "远端删成功后本地应被删"


def test_delete_remote_fail_keeps_local():
    _seed_account("bad2@ex.com")
    _seed_remote("bad2@ex.com", "reauth", file_name="xai-bad2@ex.com.json")
    orig = store._urlopen
    store._urlopen = _patch_urlopen(raise_http=(401, b"bad key"))
    try:
        r = store.delete_cpa_abnormal(["bad2@ex.com"], config=_CFG_FULL)
    finally:
        store._urlopen = orig
    assert r["deleted"] == 0, r
    assert len(r["failed"]) == 1, r
    assert _account_exists("bad2@ex.com"), "远端删失败本地必须保留（严格联动）"


def test_delete_file_name_fallback_when_missing():
    _seed_account("nofn@ex.com")
    _seed_remote("nofn@ex.com", "quota_exhausted")  # 无 file_name
    orig = store._urlopen
    fake = _patch_urlopen(monkey_status=200)
    store._urlopen = fake
    try:
        r = store.delete_cpa_abnormal(["nofn@ex.com"], config=_CFG_FULL)
    finally:
        store._urlopen = orig
    # 回退到 _auth_part_filename(email, cpa=True) = xai-<email>.json
    assert "name=xai-nofn" in fake.calls["url"], fake.calls
    assert r["deleted"] == 1, r


def test_delete_empty_emails():
    r = store.delete_cpa_abnormal([], config=_CFG_FULL)
    assert r["ok"] is False, r
    assert r["deleted"] == 0, r


def test_delete_mixed_batch():
    _seed_account("m_ok@ex.com"); _seed_remote("m_ok@ex.com", "reauth", file_name="xai-m_ok@ex.com.json")
    _seed_account("m_skip@ex.com"); _seed_remote("m_skip@ex.com", "healthy")
    _seed_account("m_fail@ex.com"); _seed_remote("m_fail@ex.com", "permission_denied", file_name="xai-m_fail@ex.com.json")
    orig = store._urlopen
    def fake(req, *, timeout):
        if "m_fail" in req.full_url:
            raise urllib.error.HTTPError(req.full_url, 500, "err", {}, io.BytesIO(b"boom"))
        return _FakeResp(200)
    store._urlopen = fake
    try:
        r = store.delete_cpa_abnormal(
            ["m_ok@ex.com", "m_skip@ex.com", "m_fail@ex.com"], config=_CFG_FULL
        )
    finally:
        store._urlopen = orig
    assert r["deleted"] == 1, r
    assert len(r["skipped"]) == 1, r
    assert len(r["failed"]) == 1, r
    assert not _account_exists("m_ok@ex.com")
    assert _account_exists("m_skip@ex.com")
    assert _account_exists("m_fail@ex.com")


if __name__ == "__main__":
    test_config_defaults_auto_delete_off()
    test_config_normalizes_auto_delete()
    test_delete_http_2xx_ok()
    test_delete_http_uses_query_and_delete_method()
    test_delete_http_404_is_ok()
    test_delete_http_401_is_fail()
    test_delete_http_500_is_fail()
    test_abnormal_emails_from_remote_filters()
    test_delete_skips_healthy_no_cpa_call()
    test_delete_success_removes_local()
    test_delete_remote_fail_keeps_local()
    test_delete_file_name_fallback_when_missing()
    test_delete_empty_emails()
    test_delete_mixed_batch()
    print("ALL OK")
