# 删除 CPA 异常账号（手动 + 自动）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增"删除 CPA 异常账号"能力——对处于异常状态（reauth/401、quota_exhausted/429、permission_denied/403）的账号，调 CPA `DELETE /v0/management/auth-files?name=<file_name>` 删远端 auth，远端删成功才删本地（严格联动、带备份）；提供手动按钮与默认关闭的自动删除（跟随调度周期、每轮先拉后删、带限流）。

**Architecture:** 一个纯后端编排函数 `delete_cpa_abnormal(emails)` 是唯一真相源，手动 API 与自动调度共用它。它逐账号：查 `remote_accounts` 分类 → 非异常跳过 → 从 `raw_json` 取 `file_name`（不用 `remote_id`，后者可能是 `auth_index`）→ 调新增的 `_delete_cpa_auth_file_by_name`（404 当幂等成功）→ 远端成功的 email 汇总后一次性 `delete_accounts(..., backup=True)` 删本地。自动删除在 `evaluate_schedule_tick` 早期新增一段，独立开关 + 限流，`try` 包裹隔离，先 `sync_cpa_remote_status(mode="problems")` 再删。

**Tech Stack:** Python 3（FastAPI 后端）、SQLite（stdlib `sqlite3`）、urllib（stdlib）。前端 React（`web/`，bun + vite）编译进 `src/static/admin/assets/`。测试为 stdlib `assert` 脚本，在运行中的容器内用 `python` 执行（镜像无 pytest）。

## Global Constraints

- CPA 删除端点是 `DELETE /v0/management/auth-files?name=<file_name.json>`（query 参数，**非** path；认证头 `Authorization: Bearer <management_key>`）。响应：2xx 成功；404 = 远端本就没有（**当幂等成功**）；401/403/5xx/网络错 = 失败。
- 删除定位键**必须从 `remote_accounts.raw_json` 里取 `file_name`**，缺失时回退 `_auth_part_filename(email, cpa=True)`（产出 `xai-<email>.json`）。**绝不用 `remote_id`**（预分类分支里它优先是 `auth_index`，不是删除接口接受的键）。
- 可删异常状态集合固定为 `{"reauth", "quota_exhausted", "permission_denied"}`，手动与自动一致。healthy 及其它状态一律跳过。
- 严格联动：仅当 CPA 远端删成功（含 404）该 email 才进本地删除列表；失败则本地保留并逐条报告。
- 本地删除复用 `delete_accounts(emails, backup=True)`，不重复实现备份。
- CPA HTTP 请求复用已有 `_urlopen`（`register_lite_store.py:1255`）与 `_cpa_management_headers`（`:4017`）；不额外加 SSRF 校验（base_url 已在 `normalize_cpa_config` 经 `_normalize_origin` 校验，与现有上传/拉取一致）。
- 自动删除默认关闭（`auto_delete_abnormal: False`），限流 `auto_delete_min_interval_sec: 300`（秒）。`normalize_cpa_config` 的 return 是**显式白名单**，新字段必须加进 return 才不被丢弃。
- 自动删除仅在 CPA 是有效后端时跑：开关开 + `base_url`/`management_key` 完整 + 未被 pin 到 grok2api（`get_remote_backend(resolve=False)` 不为 `"grok2api"`）。
- 自动删除逻辑整段 `try` 包裹，任何失败只 `actions.append` 一条，绝不影响注册调度主流程。
- 宿主机无 Python。所有测试命令通过 `docker compose exec -T register-lite ...` 在容器内运行（工作目录 `/app`）。测试用临时 DB（`GROK_REGISTER_LITE_DB` 指向 `/tmp/xxx.sqlite3`）隔离，绝不碰生产库。
- 前端约束：改 `web/src/**` 后必须在 `web/` 下重新 build，产出 hash 化 assets 覆盖 `src/static/admin/assets/`；注意 `__ADMIN_BASE__` 注入约束（见 memory `grok-register-structure`）。

---

## File Structure

- `src/register_lite_store.py`（Modify）
  - `DEFAULT_CPA_CONFIG`（:142）— 加 `auto_delete_abnormal` + `auto_delete_min_interval_sec`
  - `normalize_cpa_config`（:2125）— return 白名单加两个新字段
  - `_delete_cpa_auth_file_by_name`（新增，放在 `_upload_cpa_auth_file` 之后，约 :4015）— CPA 删除 HTTP 层
  - `delete_cpa_abnormal`（新增，放在删除相关函数区，约 `delete_accounts` :5723 之后）— 核心编排
  - `_abnormal_emails_from_remote`（新增，同区）— 从 `remote_accounts` 取异常 email
  - `_cpa_auto_delete_enabled`（新增）— 自动删除开关判定
  - `evaluate_schedule_tick`（:982）— section 1 之后插入自动删除小节
- `src/register_lite_app.py`（Modify）
  - `DeleteCpaAbnormalBody`（新增，放在 `CpaUploadBody` :474 附近）
  - `POST /api/cpa/delete-abnormal` 路由（新增，放在 `upload_cpa` :2647 之后）
- `web/src/pages/AccountsView.tsx`（Modify）— `deleteCpaAbnormalSelected` 函数 + 按钮
- `web/src/components/settings/RemoteCards.tsx`（Modify）— 自动删除开关勾选框
- `web/src/lib/types.ts`（Modify，若有 CPA 配置类型）— 加两个字段
- `src/tests/test_cpa_delete.py`（Create）— stdlib assert 测试

---

## Task 1: CPA 配置加自动删除开关字段

**Files:**
- Modify: `src/register_lite_store.py`（`DEFAULT_CPA_CONFIG` :142；`normalize_cpa_config` :2147-2153 return 块）
- Modify: `src/tests/test_cpa_delete.py`（本任务创建）

**Interfaces:**
- Produces: `get_cpa_config(include_key=...)` 返回的 dict 新增两键：`auto_delete_abnormal: bool`、`auto_delete_min_interval_sec: int`（钳制 60..86400）。

- [ ] **Step 1: 写失败测试**

创建 `src/tests/test_cpa_delete.py`：

```python
"""stdlib assert 测试：删除 CPA 异常账号。容器内运行，临时 DB 隔离。"""
import os, sys, tempfile, json

_tmpdir = tempfile.mkdtemp(prefix="cpa_delete_test_")
os.environ["GROK_REGISTER_LITE_DATA_DIR"] = _tmpdir
os.environ["GROK_REGISTER_LITE_DB"] = os.path.join(_tmpdir, "test.sqlite3")
os.environ["GROK_REGISTER_LITE_OUTPUT_DIR"] = os.path.join(_tmpdir, "outputs")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import register_lite_store as store  # noqa: E402


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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `docker compose exec -T register-lite python tests/test_cpa_delete.py`
Expected: FAIL — `KeyError: 'auto_delete_abnormal'`（normalize 尚未产出该键）

- [ ] **Step 3: 加默认字段**

`src/register_lite_store.py` 的 `DEFAULT_CPA_CONFIG`（:142）改为：

```python
DEFAULT_CPA_CONFIG: dict[str, Any] = {
    "base_url": os.getenv("GROK_REGISTER_LITE_CPA_BASE_URL", ""),
    "management_key": os.getenv("GROK_REGISTER_LITE_CPA_MANAGEMENT_KEY", ""),
    "limit": 1000,
    "auto_upload_after_probe": False,
    "auto_upload_after_relogin": False,
    "auto_delete_abnormal": False,
    "auto_delete_min_interval_sec": 300,
}
```

- [ ] **Step 4: normalize return 白名单加字段**

`normalize_cpa_config`（:2147）的 return 块，在 `limit` 计算后先加钳制，再把两个字段加进 return dict：

在 `limit = max(1, min(5000, limit))` 之后（约 :2131）追加：

```python
    try:
        del_interval = int(src.get("auto_delete_min_interval_sec") or 300)
    except (TypeError, ValueError):
        del_interval = 300
    del_interval = max(60, min(86400, del_interval))
```

return dict（:2147-2153）改为：

```python
    return {
        "base_url": base_url,
        "management_key": str(src.get("management_key") or ""),
        "limit": limit,
        "auto_upload_after_probe": bool(src.get("auto_upload_after_probe")),
        "auto_upload_after_relogin": bool(src.get("auto_upload_after_relogin", False)),
        "auto_delete_abnormal": bool(src.get("auto_delete_abnormal")),
        "auto_delete_min_interval_sec": del_interval,
    }
```

- [ ] **Step 5: 运行测试确认通过**

Run: `docker compose exec -T register-lite python tests/test_cpa_delete.py`
Expected: PASS — `ALL OK`

- [ ] **Step 6: 提交**

```bash
git add src/register_lite_store.py src/tests/test_cpa_delete.py
git commit -m "feat: CPA 配置加自动删除异常开关字段"
```

---

## Task 2: CPA 删除 HTTP 层 `_delete_cpa_auth_file_by_name`

**Files:**
- Modify: `src/register_lite_store.py`（新增函数，放在 `_upload_cpa_auth_file` :4013-4014 之后）
- Modify: `src/tests/test_cpa_delete.py`（追加测试）

**Interfaces:**
- Consumes: `_cpa_management_headers(cfg)`（:4017，返回带 Bearer 的 dict）、`_urlopen(req, timeout=...)`（:1255）。
- Produces: `_delete_cpa_auth_file_by_name(file_name: str, cfg: dict, *, timeout: float = 30.0) -> dict`，返回 `{"ok": bool, "status": int, "name": str, ...}`；2xx→ok True；404→ok True + `"note"`；其它→ok False + `"error"`。

- [ ] **Step 1: 写失败测试**

在 `test_cpa_delete.py` 的 `if __name__` 之前追加（mock `_urlopen`，用假 response/HTTPError 对象）：

```python
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
    assert store._urlopen is orig  # sanity


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
```

并把这些函数名加进 `if __name__ == "__main__"` runner：

```python
    test_delete_http_2xx_ok()
    test_delete_http_uses_query_and_delete_method()
    test_delete_http_404_is_ok()
    test_delete_http_401_is_fail()
    test_delete_http_500_is_fail()
```

- [ ] **Step 2: 运行测试确认失败**

Run: `docker compose exec -T register-lite python tests/test_cpa_delete.py`
Expected: FAIL — `AttributeError: module 'register_lite_store' has no attribute '_delete_cpa_auth_file_by_name'`

- [ ] **Step 3: 实现删除辅助**

`src/register_lite_store.py`，在 `_upload_cpa_auth_file`（:4013-4014）之后新增：

```python
def _delete_cpa_auth_file_by_name(
    file_name: str, cfg: dict[str, Any], *, timeout: float = 30.0
) -> dict[str, Any]:
    """DELETE /v0/management/auth-files?name=<file_name>.

    404 视为幂等成功（远端本就没有该 auth）。返回:
      成功: {"ok": True, "status": <int>, "name": file_name[, "note": ...]}
      失败: {"ok": False, "status": <int>, "name": file_name, "error": <str>}
    """
    name = str(file_name or "").strip()
    if not name:
        return {"ok": False, "status": 0, "name": name, "error": "空文件名"}
    endpoint = (
        cfg["base_url"].rstrip("/")
        + "/v0/management/auth-files?"
        + urllib.parse.urlencode({"name": name})
    )
    req = urllib.request.Request(
        endpoint, headers=_cpa_management_headers(cfg), method="DELETE"
    )
    try:
        with _urlopen(req, timeout=timeout) as resp:
            status = int(resp.status)
            resp.read()
    except urllib.error.HTTPError as exc:
        status = int(exc.code)
        body = exc.read().decode("utf-8", errors="replace")
        if status == 404:
            return {"ok": True, "status": 404, "name": name, "note": "远端本就不存在"}
        return {"ok": False, "status": status, "name": name, "error": body.strip()[:300]}
    except Exception as exc:  # noqa: BLE001 — 网络/超时等
        return {"ok": False, "status": 0, "name": name, "error": str(exc)[:300]}
    if 200 <= status < 300:
        return {"ok": True, "status": status, "name": name}
    if status == 404:
        return {"ok": True, "status": 404, "name": name, "note": "远端本就不存在"}
    return {"ok": False, "status": status, "name": name, "error": f"HTTP {status}"}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `docker compose exec -T register-lite python tests/test_cpa_delete.py`
Expected: PASS — `ALL OK`

- [ ] **Step 5: 提交**

```bash
git add src/register_lite_store.py src/tests/test_cpa_delete.py
git commit -m "feat: 新增 CPA auth 文件删除 HTTP 辅助（404 幂等）"
```

---

## Task 3: 核心编排 `delete_cpa_abnormal` + 异常 email 辅助

**Files:**
- Modify: `src/register_lite_store.py`（新增函数，放在 `discard_accounts` :5770-5772 之后）
- Modify: `src/tests/test_cpa_delete.py`（追加测试）

**Interfaces:**
- Consumes: `_delete_cpa_auth_file_by_name`（Task 2）、`get_cpa_config(include_key=True)`（:2156）、`_auth_part_filename(email, cpa=True)`（:3601）、`delete_accounts(emails, backup=True)`（:5723）、`_connect()`（:—，现有）。
- Produces:
  - `ABNORMAL_CPA_CLASSIFICATIONS: frozenset` = `{"reauth", "quota_exhausted", "permission_denied"}`（模块级常量）。
  - `delete_cpa_abnormal(emails: list[str], *, config: dict | None = None) -> dict` — 返回 `{"ok": bool, "deleted": int, "requested": int, "skipped": list[dict], "failed": list[dict], "backup_path": str}`。
  - `_abnormal_emails_from_remote() -> list[str]` — 从 `remote_accounts`(provider='cpa') 取分类属于 `ABNORMAL_CPA_CLASSIFICATIONS` 的去重 email 列表。

- [ ] **Step 1: 写失败测试**

在 `test_cpa_delete.py` 追加。先加一个把测试账号 + remote_accounts 行插进临时库的辅助，再写行为测试：

```python
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
```

runner 追加：

```python
    test_abnormal_emails_from_remote_filters()
    test_delete_skips_healthy_no_cpa_call()
    test_delete_success_removes_local()
    test_delete_remote_fail_keeps_local()
    test_delete_file_name_fallback_when_missing()
    test_delete_empty_emails()
    test_delete_mixed_batch()
```

- [ ] **Step 2: 运行测试确认失败**

Run: `docker compose exec -T register-lite python tests/test_cpa_delete.py`
Expected: FAIL — `AttributeError: ... '_abnormal_emails_from_remote'`（或 `delete_cpa_abnormal`）

- [ ] **Step 3: 实现常量 + 两个函数**

`src/register_lite_store.py`，在 `discard_accounts`（:5770-5772）之后新增：

```python
ABNORMAL_CPA_CLASSIFICATIONS: frozenset[str] = frozenset(
    {"reauth", "quota_exhausted", "permission_denied"}
)


def _abnormal_emails_from_remote() -> list[str]:
    """从 remote_accounts(provider='cpa') 取异常分类的去重 email。"""
    init_db()
    marks = tuple(sorted(ABNORMAL_CPA_CLASSIFICATIONS))
    placeholders = ",".join("?" for _ in marks)
    with _connect() as conn:
        rows = conn.execute(
            f"""
            SELECT DISTINCT lower(email) AS email
            FROM remote_accounts
            WHERE provider = 'cpa'
              AND lower(classification) IN ({placeholders})
              AND email IS NOT NULL AND email != ''
            """,
            marks,
        ).fetchall()
    return [str(r["email"]) for r in rows if r["email"]]


def _cpa_file_name_for_email(conn, email: str) -> tuple[str, str]:
    """返回 (classification, file_name)。file_name 优先取 raw_json.file_name，
    缺失回退 _auth_part_filename(email, cpa=True)。classification 缺失返回 ''。"""
    row = conn.execute(
        """
        SELECT classification, raw_json
        FROM remote_accounts
        WHERE provider = 'cpa' AND lower(email) = ?
        ORDER BY seen_at DESC LIMIT 1
        """,
        (email.lower(),),
    ).fetchone()
    classification = str(row["classification"] or "").strip().lower() if row else ""
    file_name = ""
    if row and row["raw_json"]:
        try:
            raw = json.loads(row["raw_json"])
            file_name = str(raw.get("file_name") or "").strip()
        except Exception:  # noqa: BLE001
            file_name = ""
    if not file_name:
        file_name = _auth_part_filename(email, cpa=True)
    return classification, file_name


def delete_cpa_abnormal(
    emails: list[str], *, config: dict[str, Any] | None = None
) -> dict[str, Any]:
    """删 CPA 远端异常 auth + 严格联动删本地。

    仅处理分类属于 ABNORMAL_CPA_CLASSIFICATIONS 的账号；healthy/未知跳过。
    远端删成功（含 404 幂等）才删本地；失败则本地保留并报告。
    """
    clean: list[str] = []
    seen: set[str] = set()
    for email in emails or []:
        key = str(email or "").strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        clean.append(key)
    if not clean:
        return {"ok": False, "deleted": 0, "requested": 0,
                "skipped": [], "failed": [], "backup_path": ""}

    cfg = normalize_cpa_config(config or get_cpa_config(include_key=True))
    if not cfg.get("base_url") or not cfg.get("management_key"):
        return {"ok": False, "deleted": 0, "requested": len(clean),
                "skipped": [], "failed": [], "backup_path": "",
                "error": "CPA 连接未配置完整"}

    init_db()
    skipped: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    deletable: list[str] = []

    with _connect() as conn:
        resolved = {e: _cpa_file_name_for_email(conn, e) for e in clean}

    for email in clean:
        classification, file_name = resolved[email]
        if classification not in ABNORMAL_CPA_CLASSIFICATIONS:
            skipped.append({"email": email,
                            "reason": classification or "无 CPA 异常记录"})
            continue
        r = _delete_cpa_auth_file_by_name(file_name, cfg)
        if r.get("ok"):
            deletable.append(email)
        else:
            failed.append({"email": email, "file_name": file_name,
                           "status": r.get("status"), "error": r.get("error")})

    backup_path = ""
    deleted = 0
    if deletable:
        local = delete_accounts(deletable, backup=True)
        deleted = int(local.get("deleted") or 0)
        backup_path = str(local.get("backup_path") or "")

    return {
        "ok": True,
        "deleted": deleted,
        "requested": len(clean),
        "skipped": skipped,
        "failed": failed,
        "backup_path": backup_path,
    }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `docker compose exec -T register-lite python tests/test_cpa_delete.py`
Expected: PASS — `ALL OK`

- [ ] **Step 5: 提交**

```bash
git add src/register_lite_store.py src/tests/test_cpa_delete.py
git commit -m "feat: delete_cpa_abnormal 核心编排（严格联动删远端+本地）"
```

---

## Task 4: 手动入口 API 路由

**Files:**
- Modify: `src/register_lite_app.py`（`DeleteCpaAbnormalBody` 放在 `CpaUploadBody` :474 附近；路由放在 `upload_cpa` :2647-2659 之后）
- Modify: `src/tests/test_cpa_delete.py`（追加一个直连 store 的集成断言即可，路由本身走人工 smoke）

**Interfaces:**
- Consumes: `lite_store.delete_cpa_abnormal(emails)`（Task 3）、`_clean_emails`（:778）。
- Produces: `POST {ADMIN_BASE}/api/cpa/delete-abnormal`，body `{"emails": [...]}`，返回 `delete_cpa_abnormal` 的 dict。

- [ ] **Step 1: 加 body 模型**

`src/register_lite_app.py`，在 `CpaUploadBody`（:474）附近新增：

```python
class DeleteCpaAbnormalBody(BaseModel):
    emails: list[str] | None = None
```

- [ ] **Step 2: 加路由**

在 `upload_cpa`（:2647-2659）之后新增：

```python
@app.post(_admin_path('api', 'cpa', 'delete-abnormal'))
async def delete_cpa_abnormal(body: DeleteCpaAbnormalBody):
    """删除选中账号在 CPA 上的异常 auth，并严格联动删本地（带备份）。

    仅处理异常状态（reauth/quota_exhausted/permission_denied），健康账号跳过。
    """
    try:
        return await asyncio.to_thread(
            lite_store.delete_cpa_abnormal,
            _clean_emails(body.emails),
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(e)) from e
```

- [ ] **Step 3: 语法/导入自检**

Run: `docker compose exec -T register-lite python -c "import register_lite_app; print('import ok')"`
Expected: `import ok`（无 SyntaxError / NameError；确认 `_admin_path`、`asyncio`、`lite_store`、`_clean_emails`、`HTTPException` 均已在文件顶部导入——它们被现有路由使用，已存在）

- [ ] **Step 4: 端到端 smoke（空 body 走校验路径）**

Run:
```bash
docker compose exec -T register-lite python -c "
import asyncio, register_lite_app as app
b = app.DeleteCpaAbnormalBody(emails=[])
print(asyncio.run(app.delete_cpa_abnormal(b)))
"
```
Expected: 打印含 `'ok': False` 和 `'deleted': 0` 的 dict（空 emails 被 `delete_cpa_abnormal` 拒绝，不抛异常）

- [ ] **Step 5: 提交**

```bash
git add src/register_lite_app.py
git commit -m "feat: POST /api/cpa/delete-abnormal 手动删除入口"
```

---

## Task 5: 自动删除接入调度 tick

**Files:**
- Modify: `src/register_lite_store.py`（新增 `_cpa_auto_delete_enabled` + `_maybe_auto_delete_cpa_abnormal`；`evaluate_schedule_tick` :1047 后插入调用）
- Modify: `src/tests/test_cpa_delete.py`（追加测试）

**Interfaces:**
- Consumes: `get_cpa_config(include_key=True)`、`get_remote_backend(resolve=False)`（:—，现有）、`get_schedule_runtime()`/`set_schedule_runtime()`（:291）、`sync_cpa_remote_status(mode="problems")`（:4093）、`_abnormal_emails_from_remote()`（Task 3）、`delete_cpa_abnormal(...)`（Task 3）。
- Produces:
  - `_cpa_auto_delete_enabled() -> bool` — 开关开 + CPA 配置完整 + 未被 pin 到 grok2api。
  - `_maybe_auto_delete_cpa_abnormal(now: float, actions: list) -> None` — 限流判定 + 拉取 + 删除，全程 try 隔离，只 append action。

- [ ] **Step 1: 写失败测试**

在 `test_cpa_delete.py` 追加（用 monkeypatch 存根 sync/config，验证开关与限流）：

```python
def test_auto_delete_disabled_by_default(monkey=None):
    # 默认配置 auto_delete_abnormal=False → enabled 应为 False
    orig_cfg = store.get_cpa_config
    store.get_cpa_config = lambda *a, **k: store.normalize_cpa_config(
        {"base_url": "https://cpa.example", "management_key": "mk",
         "auto_delete_abnormal": False}
    )
    orig_backend = store.get_remote_backend
    store.get_remote_backend = lambda *a, **k: "cpa"
    try:
        assert store._cpa_auto_delete_enabled() is False
    finally:
        store.get_cpa_config = orig_cfg
        store.get_remote_backend = orig_backend


def test_auto_delete_enabled_when_on_and_cpa_backend():
    orig_cfg = store.get_cpa_config
    store.get_cpa_config = lambda *a, **k: store.normalize_cpa_config(
        {"base_url": "https://cpa.example", "management_key": "mk",
         "auto_delete_abnormal": True}
    )
    orig_backend = store.get_remote_backend
    store.get_remote_backend = lambda *a, **k: "cpa"
    try:
        assert store._cpa_auto_delete_enabled() is True
    finally:
        store.get_cpa_config = orig_cfg
        store.get_remote_backend = orig_backend


def test_auto_delete_off_when_backend_pinned_grok2api():
    orig_cfg = store.get_cpa_config
    store.get_cpa_config = lambda *a, **k: store.normalize_cpa_config(
        {"base_url": "https://cpa.example", "management_key": "mk",
         "auto_delete_abnormal": True}
    )
    orig_backend = store.get_remote_backend
    store.get_remote_backend = lambda *a, **k: "grok2api"
    try:
        assert store._cpa_auto_delete_enabled() is False
    finally:
        store.get_cpa_config = orig_cfg
        store.get_remote_backend = orig_backend


def test_auto_delete_respects_min_interval():
    store.init_db()
    # 开启 + cpa backend
    orig_cfg = store.get_cpa_config
    store.get_cpa_config = lambda *a, **k: store.normalize_cpa_config(
        {"base_url": "https://cpa.example", "management_key": "mk",
         "auto_delete_abnormal": True, "auto_delete_min_interval_sec": 300}
    )
    orig_backend = store.get_remote_backend
    store.get_remote_backend = lambda *a, **k: "cpa"
    # 记录 sync 是否被调用
    called = {"sync": 0}
    orig_sync = store.sync_cpa_remote_status
    store.sync_cpa_remote_status = lambda *a, **k: called.__setitem__("sync", called["sync"] + 1) or {}
    store.set_schedule_runtime({"last_cpa_auto_delete_at": _time.time()})  # 刚删过
    try:
        actions = []
        store._maybe_auto_delete_cpa_abnormal(_time.time(), actions)
        assert called["sync"] == 0, "未到最小间隔不应拉取"
    finally:
        store.get_cpa_config = orig_cfg
        store.get_remote_backend = orig_backend
        store.sync_cpa_remote_status = orig_sync
```

runner 追加：

```python
    test_auto_delete_disabled_by_default()
    test_auto_delete_enabled_when_on_and_cpa_backend()
    test_auto_delete_off_when_backend_pinned_grok2api()
    test_auto_delete_respects_min_interval()
```

- [ ] **Step 2: 运行测试确认失败**

Run: `docker compose exec -T register-lite python tests/test_cpa_delete.py`
Expected: FAIL — `AttributeError: ... '_cpa_auto_delete_enabled'`

- [ ] **Step 3: 实现开关判定 + 限流执行**

`src/register_lite_store.py`，在 `delete_cpa_abnormal` 之后新增：

```python
def _cpa_auto_delete_enabled() -> bool:
    """自动删除是否应运行：开关开 + CPA 配置完整 + 未被 pin 到 grok2api。"""
    try:
        cfg = get_cpa_config(include_key=True)
    except Exception:  # noqa: BLE001
        return False
    if not bool(cfg.get("auto_delete_abnormal")):
        return False
    if not cfg.get("base_url") or not cfg.get("management_key"):
        return False
    try:
        if get_remote_backend(resolve=False) == "grok2api":
            return False
    except Exception:  # noqa: BLE001
        pass
    return True


def _maybe_auto_delete_cpa_abnormal(now: float, actions: list[dict[str, Any]]) -> None:
    """调度 tick 调用：限流 → 拉最新 CPA 异常 → 严格联动删。全程隔离，只 append action。"""
    if not _cpa_auto_delete_enabled():
        return
    try:
        cfg = get_cpa_config(include_key=True)
        min_interval = int(cfg.get("auto_delete_min_interval_sec") or 300)
        rt = get_schedule_runtime()
        last = float(rt.get("last_cpa_auto_delete_at") or 0)
        if last > 0 and (now - last) < min_interval:
            return
        set_schedule_runtime({"last_cpa_auto_delete_at": now})
        sync_cpa_remote_status(mode="problems")
        emails = _abnormal_emails_from_remote()
        if not emails:
            actions.append({"type": "cpa_auto_delete", "deleted": 0, "checked": 0})
            return
        res = delete_cpa_abnormal(emails, config=cfg)
        actions.append({
            "type": "cpa_auto_delete",
            "deleted": int(res.get("deleted") or 0),
            "checked": len(emails),
            "skipped": len(res.get("skipped") or []),
            "failed": len(res.get("failed") or []),
        })
    except Exception as exc:  # noqa: BLE001
        actions.append({"type": "cpa_auto_delete_error", "error": str(exc)[:200]})
```

- [ ] **Step 4: 接入 tick**

`evaluate_schedule_tick` 里，在 section 1（关批次，:1047 附近，section 2「System resource guard」注释之前）插入：

```python
    # 1.5) CPA 自动删除异常（独立于注册调度：即使 disabled/窗口外也照跑）。
    _maybe_auto_delete_cpa_abnormal(now, actions)
```

（放在这里的原因：它必须在所有 early-return 之前执行，且独立于「是否自动注册」——自动删 CPA 异常是独立运维动作。）

- [ ] **Step 5: 运行测试确认通过**

Run: `docker compose exec -T register-lite python tests/test_cpa_delete.py`
Expected: PASS — `ALL OK`

- [ ] **Step 6: tick 冒烟（确认接入不炸调度）**

Run:
```bash
docker compose exec -T register-lite python -c "
import register_lite_store as s
out = s.evaluate_schedule_tick(start_fn=None, force=False)
print('tick ok, skipped=', out.get('skipped'))
"
```
Expected: 打印 `tick ok, skipped= no_start_fn`（自动删除段因默认开关关闭而静默跳过，不影响 tick 返回）

- [ ] **Step 7: 提交**

```bash
git add src/register_lite_store.py src/tests/test_cpa_delete.py
git commit -m "feat: 自动删除 CPA 异常接入调度 tick（默认关+限流+隔离）"
```

---

## Task 6: 前端删除按钮

**Files:**
- Modify: `web/src/pages/AccountsView.tsx`（新增 `deleteCpaAbnormalSelected`，参照 `deleteSelected` :438-455；按钮加在「删除选中」:664 旁）

**Interfaces:**
- Consumes: `api`、`adminUrl`、`selectedEmails`、`setStatusBadge`、`setLogData`、`setSelected`、`toast`、`refresh`、`run`（均为 AccountsView 内现有）。
- Produces: 无（纯 UI）。

- [ ] **Step 1: 加删除函数**

`web/src/pages/AccountsView.tsx`，在 `deleteSelected`（:438-455）之后新增：

```ts
  const deleteCpaAbnormalSelected = async () => {
    const emails = selectedEmails();
    if (!emails.length) {
      toast("先选择账号");
      return;
    }
    if (!confirm("删除选中账号在 CPA 上的异常 auth 并清理本地？\n只处理异常状态（需重登/额度用尽/权限拒绝），健康账号会跳过。删除前自动备份。")) return;
    setStatusBadge({ text: "删除 CPA 异常中", kind: "warn" });
    const data = await api<any>(adminUrl("api", "cpa", "delete-abnormal"), {
      method: "POST",
      body: JSON.stringify({ emails }),
    });
    setLogData(data);
    const deleted = data.deleted || 0;
    const skipped = (data.skipped && data.skipped.length) || 0;
    const failed = (data.failed && data.failed.length) || 0;
    setStatusBadge({ text: `CPA 异常删除：成功 ${deleted}，跳过 ${skipped}，失败 ${failed}`, kind: data.ok ? "ok" : "warn" });
    setSelected(new Set());
    toast("已删除 CPA 异常：" + deleted);
    await refresh();
  };
```

- [ ] **Step 2: 加按钮**

在「删除选中」按钮（:664）之后新增：

```tsx
            <button className="btn danger" type="button" onClick={() => run(deleteCpaAbnormalSelected)}>删除 CPA 异常</button>
```

- [ ] **Step 3: 类型检查**

Run: `cd web && bun run tsc --noEmit` （若 `package.json` 无该脚本，用 `cd web && npx tsc --noEmit -p tsconfig.app.json`）
Expected: 无类型错误（`deleteCpaAbnormalSelected` 引用的符号均已存在）

- [ ] **Step 4: 构建前端**

Run: `cd web && bun run build`
Expected: 构建成功，产出写入 `src/static/admin/assets/`（vite 配置的 outDir）。确认 `src/static/admin/assets/` 下 `accounts-*.js` hash 变化。

- [ ] **Step 5: 提交**

```bash
git add web/src/pages/AccountsView.tsx src/static/admin/
git commit -m "feat: 账号页新增「删除 CPA 异常」按钮"
```

---

## Task 7: 前端自动删除开关

**Files:**
- Modify: `web/src/components/settings/RemoteCards.tsx`（CPA 配置卡片加勾选框）
- Modify: `web/src/lib/types.ts`（若有 CPA 配置类型，加两个字段）

**Interfaces:**
- Consumes: RemoteCards 现有的 CPA 配置读写机制（`auto_upload_after_probe` 等勾选框的同款模式）。
- Produces: 无。

- [ ] **Step 1: 定位现有 CPA 配置勾选框模式**

Run: `cd web && grep -n "auto_upload_after_probe\|auto_upload_after_relogin" src/components/settings/RemoteCards.tsx src/lib/types.ts`
Expected: 找到 CPA 配置里现有布尔勾选框的 JSX 与类型定义位置，作为新开关的复制模板。

- [ ] **Step 2: 类型加字段**

若 `types.ts` 有 CPA 配置 interface（如 `CpaConfig`），在其中加：

```ts
  auto_delete_abnormal?: boolean;
  auto_delete_min_interval_sec?: number;
```

（若无独立 CPA 配置类型、用的是 inline/any，则跳过本步——Step 1 的 grep 结果决定。）

- [ ] **Step 3: 加勾选框**

在 CPA 配置卡片里，仿照 `auto_upload_after_probe` 勾选框，新增一个绑定 `auto_delete_abnormal` 的勾选框，label：

```tsx
自动删除异常账号（需重登 / 额度用尽 / 权限拒绝）
```

并在其下加一行风险提示小字（仿现有提示样式）：

```tsx
开启后调度每轮会先拉取 CPA 异常状态再自动删除（远端+本地，带备份）。额度用尽类账号 24h 后会自行恢复，请谨慎开启。默认关闭。
```

保存走 CPA 配置现有的 PUT 通道（`api/cpa/config`），因 Task 1 已让 `normalize_cpa_config` 透传该字段，无需改保存逻辑。

- [ ] **Step 4: 类型检查 + 构建**

Run: `cd web && npx tsc --noEmit -p tsconfig.app.json && bun run build`
Expected: 无类型错误；构建成功，assets 更新。

- [ ] **Step 5: 端到端验证开关落库**

先在 UI 保存不方便，直接验证配置读写透传：
Run:
```bash
docker compose exec -T register-lite python -c "
import register_lite_store as s
s.set_cpa_config({'base_url':'https://cpa.example','management_key':'mk','auto_delete_abnormal':True}, replace=False)
print(s.get_cpa_config(include_key=False).get('auto_delete_abnormal'))
"
```
Expected: `True`（确认 set/get 透传新字段；随后可手动改回 False 或清理测试库）

- [ ] **Step 6: 提交**

```bash
git add web/src/components/settings/RemoteCards.tsx web/src/lib/types.ts src/static/admin/
git commit -m "feat: CPA 配置加「自动删除异常」开关（默认关）"
```

---

## Task 8: 全量回归 + 文档收尾

**Files:**
- Modify: `src/README.md`（若有 API/功能清单，补一行删除接口说明——先 grep 确认有无该清单）

- [ ] **Step 1: 跑全部后端测试**

Run:
```bash
docker compose exec -T register-lite python tests/test_cpa_delete.py
docker compose exec -T register-lite python tests/test_cpa_proxy.py
```
Expected: 两个都 `ALL OK`（确认新功能未回归代理携带功能）

- [ ] **Step 2: 确认 README 是否需要补充**

Run: `grep -n "cpa\|CPA\|delete-abnormal\|删除" src/README.md`
Expected: 若 README 有 CPA 接口/功能清单，补一行 `POST /api/cpa/delete-abnormal — 删除选中账号的 CPA 异常 auth + 本地记录`；若无相关清单，跳过。

- [ ] **Step 3: 提交（如有 README 改动）**

```bash
git add src/README.md
git commit -m "docs: 补充 CPA 异常删除接口说明"
```

- [ ] **Step 4: 更新 memory**

在 `C:\Users\xiaohui\.claude\projects\D--Projects-grok-register\memory\` 新增 `cpa-delete-abnormal.md`（type: project），记录：删除接口 `DELETE /v0/management/auth-files?name=<file_name>`、定位键从 `raw_json.file_name` 取（非 remote_id）、`delete_cpa_abnormal` 手动/自动共用、自动删除挂在 `evaluate_schedule_tick` section 1.5 默认关。并在 `MEMORY.md` 加一行索引。链接 `[[cpa-account-proxy]]`。
