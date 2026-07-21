"""stdlib assert 测试：导入账号到 sub2api（第三远端后端）。容器内运行，临时 DB 隔离。"""
import os, sys, tempfile, json, io
import urllib.error

_tmpdir = tempfile.mkdtemp(prefix="sub2api_test_")
os.environ["GROK_REGISTER_LITE_DATA_DIR"] = _tmpdir
os.environ["GROK_REGISTER_LITE_DB"] = os.path.join(_tmpdir, "test.sqlite3")
os.environ["GROK_REGISTER_LITE_OUTPUT_DIR"] = os.path.join(_tmpdir, "outputs")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import register_lite_store as store  # noqa: E402


# ---------- Task 1: 配置层 ----------

def test_sub2api_config_defaults():
    cfg = store.normalize_sub2api_config({})
    assert cfg["base_url"] == "", cfg
    assert cfg["api_key"] == "", cfg
    assert cfg["limit"] == 1000, cfg
    assert cfg["sync_proxies"] is True, cfg
    assert cfg["group_ids"] == [], cfg
    assert cfg["auto_upload_after_probe"] is False, cfg
    assert cfg["auto_upload_after_relogin"] is False, cfg


def test_sub2api_config_normalizes_limit_and_bools():
    cfg = store.normalize_sub2api_config({
        "base_url": "https://s2a.example/admin.html#/x",
        "api_key": "k",
        "limit": "99999",  # 钳制到 5000
        "sync_proxies": 0,
        "auto_upload_after_probe": 1,
    })
    assert cfg["base_url"] == "https://s2a.example", cfg
    assert cfg["limit"] == 5000, cfg
    assert cfg["sync_proxies"] is False, cfg
    assert cfg["auto_upload_after_probe"] is True, cfg


def test_sub2api_config_normalizes_group_ids():
    cfg = store.normalize_sub2api_config({
        "base_url": "https://s2a.example",
        "api_key": "k",
        "group_ids": ["3", 1, 1, 0, -2, "x", 5],
    })
    assert cfg["group_ids"] == [3, 1, 5], cfg
    cfg2 = store.normalize_sub2api_config({
        "base_url": "https://s2a.example",
        "api_key": "k",
        "group_ids": "7, 2;2 9",
    })
    assert cfg2["group_ids"] == [7, 2, 9], cfg2


def test_sub2api_config_mask_and_preserve_key():
    store.set_sub2api_config({"base_url": "https://s2a.example", "api_key": "secret"}, replace=True)
    masked = store.get_sub2api_config(include_key=False)
    assert masked["api_key"] == "********", masked
    assert masked["api_key_set"] is True, masked
    # 保存掩码值应保留旧 key
    store.set_sub2api_config({"base_url": "https://s2a.example", "api_key": "********"})
    assert store.get_sub2api_config(include_key=True)["api_key"] == "secret"


# ---------- Task 2: 三方互斥 ----------

def _reset_settings():
    with store._connect() as conn:
        conn.execute("DELETE FROM settings WHERE key IN ('remote_backend','grok2api_config','cpa_config','sub2api_config')")


def test_set_sub2api_backend_disables_others_auto():
    _reset_settings()
    store._set_json_setting("grok2api_config", store.normalize_grok2api_config({
        "base_url": "http://127.0.0.1:36214", "username": "u", "password": "p",
        "auto_upload_after_probe": True,
    }))
    store._set_json_setting("cpa_config", store.normalize_cpa_config({
        "base_url": "https://cpa.example", "management_key": "mk",
        "auto_upload_after_relogin": True,
    }))
    store.set_remote_backend("sub2api")
    g = store.normalize_grok2api_config(store._json_setting("grok2api_config"))
    c = store.normalize_cpa_config(store._json_setting("cpa_config"))
    assert g["auto_upload_after_probe"] is False, g
    assert c["auto_upload_after_relogin"] is False, c


def test_get_backend_sub2api_when_only_ready():
    _reset_settings()
    store._set_json_setting("sub2api_config", store.normalize_sub2api_config({
        "base_url": "https://s2a.example", "api_key": "k",
    }))
    assert store.get_remote_backend(resolve=True) == "sub2api"


def test_get_backend_priority_grok_over_sub2api():
    _reset_settings()
    store._set_json_setting("grok2api_config", store.normalize_grok2api_config({
        "base_url": "http://127.0.0.1:36214", "username": "u", "password": "p",
    }))
    store._set_json_setting("sub2api_config", store.normalize_sub2api_config({
        "base_url": "https://s2a.example", "api_key": "k",
    }))
    # 均 ready 无 pin，无 auto → grok2api 优先
    assert store.get_remote_backend(resolve=True) == "grok2api"


def test_set_sub2api_config_auto_pins_backend():
    _reset_settings()
    store.set_sub2api_config({
        "base_url": "https://s2a.example", "api_key": "k",
        "auto_upload_after_probe": True,
    }, replace=True)
    assert store.get_remote_backend(resolve=False) == "sub2api"


# ---------- Task 3: HTTP 辅助 + 代理同步 ----------

class _FakeResp:
    def __init__(self, status, body):
        self.status = status
        self._body = body if isinstance(body, bytes) else json.dumps(body).encode()
    def read(self):
        return self._body
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


_S2A_CFG = {"base_url": "https://s2a.example", "api_key": "k", "sync_proxies": True}


def test_parse_proxy_socks_and_auth():
    p = store._sub2api_parse_proxy("socks5://user:pass@1.2.3.4:1080")
    assert p == {"protocol": "socks5", "host": "1.2.3.4", "port": 1080,
                 "username": "user", "password": "pass"}, p
    p2 = store._sub2api_parse_proxy("http://10.0.0.9:3128")
    assert p2["protocol"] == "http" and p2["port"] == 3128, p2
    assert p2["username"] == "" and p2["password"] == "", p2


def test_parse_proxy_socks_alias_and_invalid():
    assert store._sub2api_parse_proxy("socks://1.1.1.1:1080")["protocol"] == "socks5"
    assert store._sub2api_parse_proxy("") is None
    assert store._sub2api_parse_proxy("ftp://1.1.1.1:21") is None
    assert store._sub2api_parse_proxy("garbage") is None


def test_request_raises_on_code_nonzero():
    orig = store._urlopen
    store._urlopen = lambda req, *, timeout: _FakeResp(200, {"code": 1, "message": "bad key", "data": None})
    try:
        raised = False
        try:
            store._sub2api_request(_S2A_CFG, "GET", "/api/v1/admin/accounts")
        except RuntimeError as e:
            raised = True
            assert "bad key" in str(e), e
        assert raised
    finally:
        store._urlopen = orig


def test_ensure_proxy_reuses_existing():
    calls = []
    def fake(req, *, timeout):
        calls.append((req.get_method(), req.full_url))
        if req.get_method() == "GET":
            return _FakeResp(200, {"code": 0, "data": {"items": [
                {"id": 7, "protocol": "socks5", "host": "1.2.3.4", "port": 1080, "username": "user"}
            ]}})
        raise AssertionError("should not POST when match exists")
    orig = store._urlopen
    store._urlopen = fake
    try:
        cache = {}
        pid = store._sub2api_ensure_proxy(_S2A_CFG, "socks5://user:pass@1.2.3.4:1080", cache)
        assert pid == 7, pid
    finally:
        store._urlopen = orig


def test_ensure_proxy_creates_when_missing():
    def fake(req, *, timeout):
        if req.get_method() == "GET":
            return _FakeResp(200, {"code": 0, "data": {"items": []}})
        # POST create
        return _FakeResp(200, {"code": 0, "data": {"id": 42}})
    orig = store._urlopen
    store._urlopen = fake
    try:
        cache = {}
        pid = store._sub2api_ensure_proxy(_S2A_CFG, "http://10.0.0.9:3128", cache)
        assert pid == 42, pid
        # 缓存命中：第二次不再请求
        store._urlopen = lambda req, *, timeout: (_ for _ in ()).throw(AssertionError("cached"))
        pid2 = store._sub2api_ensure_proxy(_S2A_CFG, "http://10.0.0.9:3128", cache)
        assert pid2 == 42, pid2
    finally:
        store._urlopen = orig


def test_parse_proxy_bad_port_returns_none():
    assert store._sub2api_parse_proxy("socks5://host:abc") is None
    assert store._sub2api_parse_proxy("http://1.2.3.4:99999999999") is None  # port out of range also raises ValueError


def test_ensure_proxy_dedupe_ignores_absent_password_in_list():
    # list API omits password → still dedupe by host/port/user
    def fake(req, *, timeout):
        if req.get_method() == "GET":
            return _FakeResp(200, {"code": 0, "data": {"items": [
                {"id": 3, "protocol": "http", "host": "10.0.0.9", "port": 3128, "username": ""}
            ]}})
        raise AssertionError("should not create when host/port/user match")
    orig = store._urlopen
    store._urlopen = fake
    try:
        cache = {}
        pid = store._sub2api_ensure_proxy(_S2A_CFG, "http://10.0.0.9:3128", cache)
        assert pid == 3, pid
    finally:
        store._urlopen = orig


def test_ensure_proxy_retries_list_after_transient_failure():
    # list GET 瞬时失败不应永久禁用查重：cache 未标记 loaded，后续不同代理的账号会重试拉取列表。
    calls = {"get": 0, "post": 0}
    def fake(req, *, timeout):
        if req.get_method() == "GET":
            calls["get"] += 1
            if calls["get"] == 1:
                raise RuntimeError("sub2api 请求失败 HTTP 500: transient")
            return _FakeResp(200, {"code": 0, "data": {"items": [
                {"id": 9, "protocol": "socks5", "host": "2.2.2.2", "port": 1080, "username": ""}
            ]}})
        calls["post"] += 1
        return _FakeResp(200, {"code": 0, "data": {"id": 100}})
    orig = store._urlopen
    store._urlopen = fake
    try:
        cache = {}
        # 账号 A：首次 GET 失败 → 未标记 loaded → 降级创建，返回占位 id 100。
        pid_a = store._sub2api_ensure_proxy(_S2A_CFG, "http://10.0.0.9:3128", cache)
        # 账号 B（不同代理）：因未标记 loaded 而重试 GET，这次成功并在列表中命中 → 返回 9（非再创建）。
        pid_b = store._sub2api_ensure_proxy(_S2A_CFG, "socks5://2.2.2.2:1080", cache)
        assert pid_a == 100, pid_a
        assert calls["get"] == 2, calls   # 第二个账号确实重试了 GET（未被首次失败永久禁用）
        assert pid_b == 9, pid_b          # 命中重试后的列表查重，而非再次创建
        assert calls["post"] == 1, calls  # 只有账号 A 创建过一次
    finally:
        store._urlopen = orig


# ---------- Task 4: 上传主流程 ----------

def _seed_account(email, sso, proxy_url="", status="active", probe_ok=True):
    store.init_db()
    now = 1_700_000_000.0
    probe = json.dumps({"ok": bool(probe_ok)})
    with store._connect() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO accounts
               (email, auth_key, sso, status, last_probe_json, proxy_url, created_at, updated_at, raw_json)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (email, "k_" + email, sso, status, probe, proxy_url, now, now, "{}"),
        )


def test_list_sub2api_sso_rows_dedup():
    _reset_settings()
    with store._connect() as conn:
        conn.execute("DELETE FROM accounts")
    _seed_account("a@ex.com", "SSO_A", "socks5://1.1.1.1:1080")
    _seed_account("b@ex.com", "SSO_A")   # 同 sso → 去重后只留一条
    _seed_account("c@ex.com", "SSO_C")
    rows = store.list_sub2api_sso_rows(emails=["a@ex.com", "b@ex.com", "c@ex.com"])
    ssos = sorted(r["sso"] for r in rows)
    assert ssos == ["SSO_A", "SSO_C"], ssos


def test_upload_sub2api_maps_index_to_email():
    _reset_settings()
    with store._connect() as conn:
        conn.execute("DELETE FROM accounts")
    _seed_account("a@ex.com", "SSO_A")
    _seed_account("c@ex.com", "SSO_C")
    store._set_json_setting("sub2api_config", store.normalize_sub2api_config({
        "base_url": "https://s2a.example", "api_key": "k", "sync_proxies": False,
    }))
    posts = []
    def fake(req, *, timeout):
        if req.get_method() == "POST" and "sso-to-oauth" in req.full_url:
            body = json.loads(req.data.decode())
            posts.append(body)
            # created index 从 1；失败 index 2
            return _FakeResp(200, {"code": 0, "data": {
                "created": [{"index": 1, "email": "a@ex.com"}],
                "failed": [{"index": 2, "error": "convert failed"}],
            }})
        raise AssertionError("unexpected " + req.full_url)
    orig = store._urlopen
    store._urlopen = fake
    try:
        res = store.upload_sub2api_sso(limit=10, emails=["a@ex.com", "c@ex.com"], require_probe=False)
    finally:
        store._urlopen = orig
    assert res["uploaded"] == 1, res
    assert res["failed"] == 1, res
    # 无代理同步 → 不带 proxy_id
    assert "proxy_id" not in posts[0], posts[0]
    assert "group_ids" not in posts[0], posts[0]
    # 成功 email 标记已导入
    with store._connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM remote_accounts WHERE provider='sub2api' AND lower(email)='a@ex.com'"
        ).fetchone()
    assert row is not None


def test_upload_sub2api_sends_group_ids():
    _reset_settings()
    with store._connect() as conn:
        conn.execute("DELETE FROM accounts")
    _seed_account("g@ex.com", "SSO_G")
    store._set_json_setting("sub2api_config", store.normalize_sub2api_config({
        "base_url": "https://s2a.example", "api_key": "k", "sync_proxies": False,
        "group_ids": [11, 22],
    }))
    posts = []
    def fake(req, *, timeout):
        if req.get_method() == "POST" and "sso-to-oauth" in req.full_url:
            body = json.loads(req.data.decode())
            posts.append(body)
            return _FakeResp(200, {"code": 0, "data": {
                "created": [{"index": 1, "email": "g@ex.com"}],
                "failed": [],
            }})
        raise AssertionError("unexpected " + req.full_url)
    orig = store._urlopen
    store._urlopen = fake
    try:
        res = store.upload_sub2api_sso(limit=10, emails=["g@ex.com"], require_probe=False)
    finally:
        store._urlopen = orig
    assert res["uploaded"] == 1, res
    assert posts and posts[0].get("group_ids") == [11, 22], posts


def test_list_sub2api_groups_parses_items():
    store._urlopen = lambda req, *, timeout: _FakeResp(200, {"code": 0, "data": [
        {"id": 2, "name": "beta", "platform": "grok", "status": "active"},
        {"id": 1, "name": "grok-default", "platform": "grok", "status": "active"},
        {"id": 0, "name": "bad"},
    ]})
    try:
        groups = store.list_sub2api_groups({"base_url": "https://s2a.example", "api_key": "k"})
    finally:
        pass
    # sorted by name lower: beta, then grok-default
    assert [g["name"] for g in groups] == ["beta", "grok-default"], groups
    assert [g["id"] for g in groups] == [2, 1], groups


def test_set_sub2api_config_preserves_group_ids_on_none():
    _reset_settings()
    store.set_sub2api_config({
        "base_url": "https://s2a.example", "api_key": "secret", "group_ids": [9, 8],
    }, replace=True)
    store.set_sub2api_config({"base_url": "https://s2a.example", "api_key": "********", "group_ids": None})
    cfg = store.get_sub2api_config(include_key=True)
    assert cfg["group_ids"] == [9, 8], cfg


def test_upload_sub2api_groups_by_proxy():
    _reset_settings()
    with store._connect() as conn:
        conn.execute("DELETE FROM accounts")
    _seed_account("p1@ex.com", "SSO_P1", "socks5://1.1.1.1:1080")
    _seed_account("p2@ex.com", "SSO_P2", "socks5://1.1.1.1:1080")
    _seed_account("np@ex.com", "SSO_NP", "")
    store._set_json_setting("sub2api_config", store.normalize_sub2api_config({
        "base_url": "https://s2a.example", "api_key": "k", "sync_proxies": True,
    }))
    posts = []
    def fake(req, *, timeout):
        m, url = req.get_method(), req.full_url
        if m == "GET" and "proxies/all" in url:
            return _FakeResp(200, {"code": 0, "data": {"items": []}})
        if m == "POST" and url.endswith("/api/v1/admin/proxies"):
            return _FakeResp(200, {"code": 0, "data": {"id": 5}})
        if m == "POST" and "sso-to-oauth" in url:
            body = json.loads(req.data.decode())
            posts.append(body)
            created = [{"index": i + 1, "email": "x"} for i in range(len(body["sso_tokens"]))]
            return _FakeResp(200, {"code": 0, "data": {"created": created, "failed": []}})
        raise AssertionError("unexpected " + url)
    orig = store._urlopen
    store._urlopen = fake
    try:
        res = store.upload_sub2api_sso(limit=10, require_probe=False,
                                       emails=["p1@ex.com", "p2@ex.com", "np@ex.com"])
    finally:
        store._urlopen = orig
    # 两组请求：带 proxy_id=5 的一组（2 token）+ 无 proxy 的一组（1 token）
    with_pid = [p for p in posts if p.get("proxy_id") == 5]
    without_pid = [p for p in posts if "proxy_id" not in p]
    assert len(with_pid) == 1 and len(with_pid[0]["sso_tokens"]) == 2, posts
    assert len(without_pid) == 1 and len(without_pid[0]["sso_tokens"]) == 1, posts
    assert res["uploaded"] == 3, res


def test_test_sub2api_remote_returns_total():
    store._urlopen = lambda req, *, timeout: _FakeResp(200, {"code": 0, "data": {"total": 12, "items": []}})
    try:
        res = store.test_sub2api_remote({"base_url": "https://s2a.example", "api_key": "k"})
    finally:
        pass
    assert res["ok"] is True and res["grok_total"] == 12, res


# ---------- Task 5: 自动上传调度 ----------

def test_auto_upload_routes_to_sub2api_when_pinned():
    _reset_settings()
    with store._connect() as conn:
        conn.execute("DELETE FROM accounts")
        conn.execute("DELETE FROM remote_accounts")
    _seed_account("auto@ex.com", "SSO_AUTO", status="active", probe_ok=True)
    store._set_json_setting("sub2api_config", store.normalize_sub2api_config({
        "base_url": "https://s2a.example", "api_key": "k", "sync_proxies": False,
        "auto_upload_after_probe": True,
    }))
    store.set_remote_backend("sub2api")
    def fake(req, *, timeout):
        if "sso-to-oauth" in req.full_url:
            return _FakeResp(200, {"code": 0, "data": {"created": [{"index": 1, "email": "auto@ex.com"}], "failed": []}})
        raise AssertionError("unexpected " + req.full_url)
    orig = store._urlopen
    store._urlopen = fake
    try:
        out = store._upload_emails_to_remotes(["auto@ex.com"], mode="probe")
    finally:
        store._urlopen = orig
    assert out["backend"] == "sub2api", out
    assert out["sub2api"] and out["sub2api"].get("uploaded") == 1, out
    # grok2api / cpa 被 skip
    assert any("grok2api" in s for s in out["skipped"]), out
    assert any("cpa" in s for s in out["skipped"]), out


def test_sync_accounts_after_probe_reaches_sub2api():
    """回归测试（Fix pass）：_chunked_sync_accounts 的门禁此前只检查
    grok2api/cpa 的 auto_upload_after_probe，sub2api 永远走不到
    _upload_emails_to_remotes。这里走生产入口 sync_accounts_after_probe，
    而不是直接调用 _upload_emails_to_remotes，证明门禁修复后 sub2api
    真的被触达。"""
    _reset_settings()
    with store._connect() as conn:
        conn.execute("DELETE FROM accounts")
        conn.execute("DELETE FROM remote_accounts")
    _seed_account("prod@ex.com", "SSO_PROD", status="active", probe_ok=True)
    store._set_json_setting("sub2api_config", store.normalize_sub2api_config({
        "base_url": "https://s2a.example", "api_key": "k", "sync_proxies": False,
        "auto_upload_after_probe": True,
    }))
    store.set_remote_backend("sub2api")
    def fake(req, *, timeout):
        if "sso-to-oauth" in req.full_url:
            return _FakeResp(200, {"code": 0, "data": {"created": [{"index": 1, "email": "prod@ex.com"}], "failed": []}})
        raise AssertionError("unexpected " + req.full_url)
    orig = store._urlopen
    store._urlopen = fake
    try:
        res = store.sync_accounts_after_probe(["prod@ex.com"], batch_size=1)
    finally:
        store._urlopen = orig
    # Production path must actually invoke sub2api now (previously it short-circuited
    # at the _chunked_sync_accounts gate before ever calling _upload_emails_to_remotes).
    assert res.get("uploaded", 0) >= 1, res
    assert res.get("batches") and res["batches"][0].get("ok"), res
    # The remote_accounts row is only written by mark_local_remote_imported on a
    # real successful sub2api upload — the strongest proof sub2api was reached.
    with store._connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM remote_accounts WHERE provider='sub2api' AND lower(email)='prod@ex.com'"
        ).fetchone()
    assert row is not None, "sub2api not reached through production sync_accounts_after_probe"


# ---------- Task 6: API body ----------

def test_sub2api_config_body_roundtrip():
    _reset_settings()
    from register_lite_app import Sub2ApiConfigBody
    body = Sub2ApiConfigBody(
        base_url="https://s2a.example", api_key="k", limit=1000,
        sync_proxies=True, auto_upload_after_probe=True, auto_upload_after_relogin=False,
    )
    dumped = body.model_dump(exclude_none=False)
    cfg = store.set_sub2api_config(dumped, replace=True)
    assert cfg["auto_upload_after_probe"] is True, cfg
    assert cfg["sync_proxies"] is True, cfg
    loaded = store.get_sub2api_config(include_key=True)
    assert loaded["base_url"] == "https://s2a.example", loaded
