"""stdlib assert tests: CPA native auth-files remote status (no grok-inspection plugin)."""
import io
import json
import os
import sys
import tempfile
import urllib.error

_tmpdir = tempfile.mkdtemp(prefix="cpa_auth_files_test_")
os.environ["GROK_REGISTER_LITE_DATA_DIR"] = _tmpdir
os.environ["GROK_REGISTER_LITE_DB"] = os.path.join(_tmpdir, "test.sqlite3")
os.environ["GROK_REGISTER_LITE_OUTPUT_DIR"] = os.path.join(_tmpdir, "outputs")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import register_lite_store as store  # noqa: E402


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


def test_classify_active_healthy():
    r = store.classify_cpa_auth_file({
        "name": "xai-a@ex.com.json",
        "email": "a@ex.com",
        "type": "xai",
        "status": "active",
        "disabled": False,
        "unavailable": False,
    })
    assert r["classification"] == "healthy", r
    assert r["action"] == "keep", r
    assert r["http_status"] == 200, r
    assert r["file_name"] == "xai-a@ex.com.json", r
    assert r["email"] == "a@ex.com", r


def test_classify_error_unauthorized_reauth():
    r = store.classify_cpa_auth_file({
        "name": "xai-b@ex.com.json",
        "email": "b@ex.com",
        "type": "xai",
        "status": "error",
        "status_message": "unauthorized",
        "disabled": False,
    })
    assert r["classification"] == "reauth", r
    assert r["action"] == "relogin", r
    assert r["http_status"] == 401, r


def test_classify_unavailable_quota():
    r = store.classify_cpa_auth_file({
        "name": "xai-c@ex.com.json",
        "email": "c@ex.com",
        "provider": "xai",
        "status": "error",
        "status_message": "rate limit exceeded",
        "unavailable": True,
        "next_retry_after": "2099-01-01T00:00:00Z",
    })
    assert r["classification"] == "quota_exhausted", r
    assert r["action"] == "wait", r
    assert r["http_status"] == 429, r


def test_classify_disabled():
    r = store.classify_cpa_auth_file({
        "name": "xai-d@ex.com.json",
        "email": "d@ex.com",
        "status": "disabled",
        "disabled": True,
    })
    assert r["classification"] == "disabled", r
    assert r["action"] == "enable_or_ignore", r


def test_email_from_filename_when_missing():
    r = store.classify_cpa_auth_file({
        "name": "xai-user@example.com.json",
        "type": "xai",
        "status": "active",
    })
    assert r["email"] == "user@example.com", r
    assert r["file_name"] == "xai-user@example.com.json", r


def test_filename_not_used_as_email_without_at():
    r = store.classify_cpa_auth_file({
        "name": "some-auth-id.json",
        "status": "active",
    })
    assert r["email"] == "", r


def test_alias_classify_inspection_still_works():
    r = store.classify_cpa_inspection_result({
        "email": "e@ex.com",
        "classification": "healthy",
        "file_name": "xai-e@ex.com.json",
    })
    assert r["classification"] == "healthy", r


def test_fetch_auth_files_endpoint():
    calls = {}

    def fake(req, *, timeout):
        calls["url"] = req.full_url
        calls["method"] = req.get_method()
        body = json.dumps({
            "files": [
                {
                    "name": "xai-a@ex.com.json",
                    "email": "a@ex.com",
                    "type": "xai",
                    "status": "active",
                    "disabled": False,
                },
                {
                    "name": "claude-other.json",
                    "email": "other@ex.com",
                    "type": "claude",
                    "status": "error",
                    "status_message": "unauthorized",
                },
            ]
        }).encode("utf-8")
        return _FakeResp(200, body)

    orig = store._urlopen
    store._urlopen = fake
    try:
        payload = store.fetch_cpa_auth_files({
            "base_url": "https://cpa.example",
            "management_key": "mk",
        })
    finally:
        store._urlopen = orig

    assert calls["method"] == "GET", calls
    assert calls["url"].endswith("/v0/management/auth-files"), calls
    assert "plugins/grok-inspection" not in calls["url"], calls
    assert payload["total"] == 2, payload
    assert len(payload["files"]) == 2, payload


def test_sync_problems_skips_healthy_and_non_xai():
    def fake(req, *, timeout):
        body = json.dumps({
            "files": [
                {
                    "name": "xai-ok@ex.com.json",
                    "email": "ok@ex.com",
                    "type": "xai",
                    "status": "active",
                    "disabled": False,
                },
                {
                    "name": "xai-bad@ex.com.json",
                    "email": "bad@ex.com",
                    "type": "xai",
                    "status": "error",
                    "status_message": "unauthorized",
                },
                {
                    "name": "claude-x.json",
                    "email": "claude@ex.com",
                    "type": "claude",
                    "status": "error",
                    "status_message": "unauthorized",
                },
            ]
        }).encode("utf-8")
        return _FakeResp(200, body)

    orig = store._urlopen
    store._urlopen = fake
    try:
        summary = store.sync_cpa_remote_status(
            {"base_url": "https://cpa.example", "management_key": "mk"},
            mode="problems",
        )
    finally:
        store._urlopen = orig

    assert summary["ok"] is True, summary
    assert summary.get("source") == "auth-files", summary
    assert "plugin" not in summary or summary.get("plugin") != "grok-inspection", summary
    assert summary["counts"].get("skipped_healthy", 0) >= 1, summary
    assert summary["counts"].get("skipped_non_xai", 0) >= 1, summary
    assert summary["remote_total"] == 1, summary

    # file_name must be recoverable for delete path
    with store._connect() as conn:
        row = conn.execute(
            "SELECT classification, raw_json FROM remote_accounts WHERE provider='cpa' AND email=?",
            ("bad@ex.com",),
        ).fetchone()
    assert row is not None
    assert row["classification"] == "reauth"
    raw = json.loads(row["raw_json"])
    assert raw.get("file_name") == "xai-bad@ex.com.json" or raw.get("name") == "xai-bad@ex.com.json", raw


def test_test_cpa_remote_uses_auth_files():
    def fake(req, *, timeout):
        body = json.dumps({"files": [{"name": "xai-a@ex.com.json", "email": "a@ex.com", "type": "xai", "status": "active"}]}).encode()
        return _FakeResp(200, body)

    orig = store._urlopen
    store._urlopen = fake
    try:
        r = store.test_cpa_remote({"base_url": "https://cpa.example", "management_key": "mk"})
    finally:
        store._urlopen = orig
    assert r["ok"] is True, r
    assert r["source"] == "auth-files", r
    assert r["total"] == 1, r
    assert r["xai_total"] == 1, r


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in tests:
        try:
            fn()
            print("OK", fn.__name__)
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print("FAIL", fn.__name__, "->", exc)
    if failed:
        raise SystemExit(f"{failed} failed")
    print(f"all {len(tests)} passed")