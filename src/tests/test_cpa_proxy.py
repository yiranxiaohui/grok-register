"""stdlib assert 测试：账号代理携带进 CPA。容器内运行，临时 DB 隔离。"""
import os, sys, tempfile, json

# 用临时 DB，绝不碰生产库。必须在 import register_lite_store 之前设置。
_tmpdir = tempfile.mkdtemp(prefix="cpa_proxy_test_")
os.environ["GROK_REGISTER_LITE_DATA_DIR"] = _tmpdir
os.environ["GROK_REGISTER_LITE_DB"] = os.path.join(_tmpdir, "test.sqlite3")
os.environ["GROK_REGISTER_LITE_OUTPUT_DIR"] = os.path.join(_tmpdir, "outputs")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import register_lite_store as store  # noqa: E402

# 一个合法的最小 access_token（JWT 结构不必真实，import 只需要能解析 email）。
# import_auth_payload 从 payload 顶层的 email 取值，无需真 JWT。
def _payload(email, proxy):
    return {
        "key": "tok_" + email.replace("@", "_"),
        "email": email,
        "refresh_token": "rt_" + email,
        "proxy_url": proxy,
    }

def test_import_writes_proxy_url_column():
    store.init_db()
    email = "a@example.com"
    res = store.import_auth_payload(_payload(email, "http://u:p@1.2.3.4:8080"))
    assert res.get("ok"), res
    with store._connect() as conn:
        row = conn.execute("SELECT proxy_url FROM accounts WHERE email=?", (email,)).fetchone()
    assert row is not None
    assert row["proxy_url"] == "http://u:p@1.2.3.4:8080", row["proxy_url"]

def test_reimport_empty_proxy_preserves_existing():
    store.init_db()
    email = "b@example.com"
    store.import_auth_payload(_payload(email, "socks5://9.9.9.9:1080"))
    # 重导入传入空代理，应保留旧值
    store.import_auth_payload(_payload(email, ""))
    with store._connect() as conn:
        row = conn.execute("SELECT proxy_url FROM accounts WHERE email=?", (email,)).fetchone()
    assert row["proxy_url"] == "socks5://9.9.9.9:1080", row["proxy_url"]

def test_import_no_proxy_field_is_empty():
    store.init_db()
    email = "c@example.com"
    p = _payload(email, "")
    del p["proxy_url"]
    store.import_auth_payload(p)
    with store._connect() as conn:
        row = conn.execute("SELECT proxy_url FROM accounts WHERE email=?", (email,)).fetchone()
    assert (row["proxy_url"] or "") == "", row["proxy_url"]

if __name__ == "__main__":
    test_import_writes_proxy_url_column()
    test_reimport_empty_proxy_preserves_existing()
    test_import_no_proxy_field_is_empty()
    print("TASK1 OK")
