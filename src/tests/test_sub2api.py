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
