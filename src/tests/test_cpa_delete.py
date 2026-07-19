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


if __name__ == "__main__":
    test_config_defaults_auto_delete_off()
    test_config_normalizes_auto_delete()
    print("ALL OK")
