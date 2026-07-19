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


if __name__ == "__main__":
    test_config_defaults_auto_delete_off()
    test_config_normalizes_auto_delete()
    test_delete_http_2xx_ok()
    test_delete_http_uses_query_and_delete_method()
    test_delete_http_404_is_ok()
    test_delete_http_401_is_fail()
    test_delete_http_500_is_fail()
    print("ALL OK")
