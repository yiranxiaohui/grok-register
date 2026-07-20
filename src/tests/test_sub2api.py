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
