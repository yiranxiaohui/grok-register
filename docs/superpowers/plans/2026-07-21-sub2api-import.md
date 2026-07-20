# 导入账号到 sub2api（第三远端后端） 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 grok-register 把注册好的 xAI 账号通过 sub2api 原生 `POST /api/v1/admin/grok/sso-to-oauth` 接口导入 sub2api，作为与 Grok2API/CPA 互斥的第三个远端后端。

**Architecture:** sub2api 侧零改动，只调它已有的 SSO 批量导入接口。grok-register 侧把现有 `remote_backend` 两两写死的互斥逻辑改成对"其余所有后端"通用循环；上传只用本地 `sso` 列（sub2api 自己做 SSO→OAuth 转换与探活）；本地账号级代理 `accounts.proxy_url` 先同步为 sub2api proxy 再逐账号按代理分组带 `proxy_id` 上传。

**Tech Stack:** Python 3（FastAPI + sqlite3 + urllib，无第三方 HTTP 库）、Pydantic v2 body、React + TypeScript（Vite）前端。

## Global Constraints

- **sub2api 零改动**：只调其已有接口，不改 `D:\Projects\sub2api` 任何文件。
- **认证**：只用管理员 API Key，请求头 `x-api-key: <api_key>`（不做用户名密码登录）。
- **HTTP 必须走 `store._urlopen`**（带 certifi TLS）；base_url 必须经 `_normalize_origin`（SSRF 防护 + 仅存 origin）。
- **上传只用 `sso` 列**：无 sso 的账号跳过并计入 `skipped_accounts`。
- **索引对齐**：sub2api `sso-to-oauth` 会对 tokens 去重且返回的 `index` 从 1 开始；本地必须先按 sso 去重再发，避免 index→email 错位。
- **`proxy_id` 是请求级参数**（整批共用）：账号级代理必须按 proxy 分组、分多次请求；每组内再按 **10 个 token 一块**分批。
- **手动上传 `require_probe=False`；自动上传 `require_probe=True`**（与 Grok2API/CPA 一致）。
- **配置掩码照抄 CPA**：`api_key` 存明文，`include_key=False` 时返回 `********`；保存收到全 `*` 或 `********` 则保留旧值。
- **后端优先级**（多个 ready/active 并存且无 pin 时）：`grok2api > cpa > sub2api`（保持现有行为兼容）。
- **测试运行环境**：本机 Git Bash 无可用 Python（WindowsApps 占位），且 Docker daemon 未运行。**每个 store/app 测试步骤先尝试 `python -m pytest`，若报 "Python was not found" 则记录"测试待容器验证"并继续**——与历史提交（如 6dd688c "测试待容器验证"）一致。前端 `npm run typecheck` 可在本机跑（node v26）。
- **提交署名**：commit message 结尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

## File Structure

- `src/register_lite_store.py`（修改）— 配置层、上传层、互斥逻辑、自动上传调度块。
- `src/register_lite_app.py`（修改）— 4 个 API 端点 + `Sub2ApiConfigBody`/`Sub2ApiUploadBody`。
- `src/tests/test_sub2api.py`（新建）— store + app 层单测。
- `web/src/components/settings/RemoteCards.tsx`（修改）— 下拉选项 + 第三张配置卡 + 三方互斥。
- `web/src/pages/AccountsView.tsx`（修改）— 「sub2api 导入」按钮 + `uploadSelectedSub2api`。

---

## Task 1: sub2api 配置层（归一化 / 掩码 / 读写）

**Files:**
- Modify: `src/register_lite_store.py`（在 `DEFAULT_CPA_CONFIG` 后加常量；在 CPA 三件套 `set_cpa_config` 后加 sub2api 三件套；`REMOTE_BACKENDS`、`normalize_remote_backend` 加别名）
- Test: `src/tests/test_sub2api.py`（新建）

**Interfaces:**
- Consumes: `_json_setting`、`_set_json_setting`、`_normalize_origin`、`_clamp_int`、`get_remote_backend`、`_mask_auto_by_remote_pin`、`_disable_other_backend_auto`（均已存在）。
- Produces:
  - `DEFAULT_SUB2API_CONFIG: dict`
  - `normalize_sub2api_config(raw: dict | None) -> dict`，键：`base_url, api_key, limit, sync_proxies, auto_upload_after_probe, auto_upload_after_relogin`
  - `get_sub2api_config(*, include_key: bool = True) -> dict`（`include_key=False` 时加 `api_key_set: bool` 且 `api_key="********"`）
  - `set_sub2api_config(patch: dict | None, *, replace: bool = False) -> dict`

- [ ] **Step 1: 写失败测试**

在新建 `src/tests/test_sub2api.py` 顶部放临时 DB 隔离头（照抄 `test_cpa_delete.py` 前 10 行），然后：

```python
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
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `python -m pytest src/tests/test_sub2api.py -q`（若报 "Python was not found" 记「测试待容器验证」并视为失败继续）
Expected: FAIL（`AttributeError: module has no attribute 'normalize_sub2api_config'`）

- [ ] **Step 3: 实现配置层**

在 `register_lite_store.py` 的 `DEFAULT_CPA_CONFIG = {...}` 块之后加：

```python
DEFAULT_SUB2API_CONFIG: dict[str, Any] = {
    "base_url": os.getenv("GROK_REGISTER_LITE_SUB2API_BASE_URL", ""),
    "api_key": os.getenv("GROK_REGISTER_LITE_SUB2API_API_KEY", ""),
    "limit": 1000,
    "sync_proxies": True,
    "auto_upload_after_probe": False,
    "auto_upload_after_relogin": False,
}
```

把 `REMOTE_BACKENDS = ("grok2api", "cpa")` 改为：

```python
REMOTE_BACKENDS = ("grok2api", "cpa", "sub2api")
```

在 `normalize_remote_backend` 里，`cpa` 别名分支之后加 sub2api 别名：

```python
    if text in {"s2a", "sub2", "sub_2api", "sub2_api", "subtoapi", "sub_to_api"}:
        text = "sub2api"
```

在 `set_cpa_config` 函数结束之后（`normalize_grok2api_config` 之前的空白处不合适——放到 `set_cpa_config` 之后、下一个 def 之前）加 sub2api 三件套：

```python
def normalize_sub2api_config(raw: dict[str, Any] | None) -> dict[str, Any]:
    src = {**DEFAULT_SUB2API_CONFIG, **(raw or {})}
    try:
        limit = int(src.get("limit") or 1000)
    except (TypeError, ValueError):
        limit = 1000
    limit = max(1, min(5000, limit))
    base_raw = str(src.get("base_url") or "").strip()
    try:
        base_url = _normalize_origin(base_raw) if base_raw else ""
    except ValueError:
        parsed = urllib.parse.urlsplit(base_raw)
        if parsed.scheme and parsed.netloc:
            base_url = _normalize_origin(
                urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
            )
        else:
            raise
    return {
        "base_url": base_url,
        "api_key": str(src.get("api_key") or ""),
        "limit": limit,
        "sync_proxies": bool(src.get("sync_proxies", True)),
        "auto_upload_after_probe": bool(src.get("auto_upload_after_probe")),
        "auto_upload_after_relogin": bool(src.get("auto_upload_after_relogin", False)),
    }


def get_sub2api_config(*, include_key: bool = True) -> dict[str, Any]:
    cfg = _mask_auto_by_remote_pin(normalize_sub2api_config(_json_setting("sub2api_config") or {}), "sub2api")
    if include_key:
        return cfg
    public = dict(cfg)
    public["api_key_set"] = bool(public.get("api_key"))
    public["api_key"] = "********" if public.get("api_key") else ""
    return public


def set_sub2api_config(patch: dict[str, Any] | None, *, replace: bool = False) -> dict[str, Any]:
    base = {} if replace else (_json_setting("sub2api_config") or {})
    patch = dict(patch or {})
    key = str(patch.get("api_key") or "")
    if (not key.strip()) or set(key.strip()) == {"*"} or key.strip() == "********":
        if "api_key" in patch:
            if str(base.get("api_key") or "").strip():
                patch["api_key"] = base.get("api_key")
            else:
                patch.pop("api_key", None)
    merged = {**base, **patch}
    cfg = normalize_sub2api_config(merged)
    if not cfg["base_url"]:
        raise ValueError("sub2api 地址不能为空")
    if not str(cfg.get("api_key") or "").strip():
        raise ValueError("sub2api 管理员 API Key 不能为空（保存后刷新若显示 ****，请重新输入真实 Key 再保存）")
    _set_json_setting("sub2api_config", cfg)
    if cfg.get("auto_upload_after_probe") or cfg.get("auto_upload_after_relogin"):
        _disable_other_backend_auto("sub2api")
    elif get_remote_backend(resolve=False) == "" and cfg.get("base_url"):
        gcfg = normalize_grok2api_config(_json_setting("grok2api_config") or {})
        ccfg = normalize_cpa_config(_json_setting("cpa_config") or {})
        g_ready = bool(gcfg.get("base_url") and gcfg.get("username") and gcfg.get("password"))
        c_ready = bool(ccfg.get("base_url") and ccfg.get("management_key"))
        if not g_ready and not c_ready:
            _set_json_setting("remote_backend", "sub2api")
    return cfg
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `python -m pytest src/tests/test_sub2api.py -q`
Expected: PASS（3 passed）；若无 Python，记「测试待容器验证」

- [ ] **Step 5: 提交**

```bash
git add src/register_lite_store.py src/tests/test_sub2api.py
git commit -m "feat: sub2api 配置层（第三远端后端归一化/掩码/读写）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: 三方互斥（get/set_remote_backend + _disable_other_backend_auto）

**Files:**
- Modify: `src/register_lite_store.py:1969-2054`（`get_remote_backend`、`set_remote_backend`、`_disable_other_backend_auto` 三个函数体）
- Test: `src/tests/test_sub2api.py`（追加）

**Interfaces:**
- Consumes: `normalize_grok2api_config`、`normalize_cpa_config`、`normalize_sub2api_config`（Task 1 已加）、`_set_json_setting`、`_json_setting`。
- Produces: 改造后的三个函数行为——`set_remote_backend("sub2api")` 关掉 grok2api+cpa 的 auto；`get_remote_backend` 唯一 active/ready 者胜出，多者按 `grok2api > cpa > sub2api`。

- [ ] **Step 1: 写失败测试**

追加到 `src/tests/test_sub2api.py`：

```python
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
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `python -m pytest src/tests/test_sub2api.py -q`
Expected: FAIL（`test_get_backend_sub2api_when_only_ready` 等失败——旧 `get_remote_backend` 不认 sub2api）

- [ ] **Step 3: 改造三个函数**

将 `get_remote_backend`（`:1969`）的推断部分（从 `env_default` 之后到 return 结束）替换为通用三方逻辑：

```python
def get_remote_backend(*, resolve: bool = True) -> str:
    """Return the exclusive remote backend: grok2api | cpa | sub2api | ""."""
    stored = normalize_remote_backend(_json_setting("remote_backend"))
    if stored:
        return stored
    if not resolve:
        return normalize_remote_backend(DEFAULT_REMOTE_BACKEND)
    env_default = normalize_remote_backend(DEFAULT_REMOTE_BACKEND)
    if env_default:
        return env_default
    try:
        gcfg = normalize_grok2api_config(_json_setting("grok2api_config") or {})
    except Exception:
        gcfg = dict(DEFAULT_GROK2API_CONFIG)
    try:
        ccfg = normalize_cpa_config(_json_setting("cpa_config") or {})
    except Exception:
        ccfg = dict(DEFAULT_CPA_CONFIG)
    try:
        scfg = normalize_sub2api_config(_json_setting("sub2api_config") or {})
    except Exception:
        scfg = dict(DEFAULT_SUB2API_CONFIG)
    ready = {
        "grok2api": bool(gcfg.get("base_url") and gcfg.get("username") and gcfg.get("password")),
        "cpa": bool(ccfg.get("base_url") and ccfg.get("management_key")),
        "sub2api": bool(scfg.get("base_url") and scfg.get("api_key")),
    }
    auto = {
        "grok2api": bool(gcfg.get("auto_upload_after_probe") or gcfg.get("auto_upload_after_relogin")),
        "cpa": bool(ccfg.get("auto_upload_after_probe") or ccfg.get("auto_upload_after_relogin")),
        "sub2api": bool(scfg.get("auto_upload_after_probe") or scfg.get("auto_upload_after_relogin")),
    }
    order = ("grok2api", "cpa", "sub2api")
    active = [b for b in order if auto[b] and ready[b]]
    if len(active) == 1:
        return active[0]
    ready_list = [b for b in order if ready[b]]
    if len(ready_list) == 1:
        return ready_list[0]
    # 多者并存或全空：按优先级选第一个 active，否则第一个 ready。
    for b in order:
        if auto[b] and ready[b]:
            return b
    for b in order:
        if ready[b]:
            return b
    return ""
```

将 `set_remote_backend`（`:2016`）的互斥部分改为循环关其余后端：

```python
def set_remote_backend(backend: str | None) -> str:
    value = normalize_remote_backend(backend)
    if value and value not in REMOTE_BACKENDS:
        raise ValueError("远端对接只能是 grok2api / cpa / sub2api")
    _set_json_setting("remote_backend", value)
    if value:
        _disable_other_backend_auto(value)
    return value
```

将 `_disable_other_backend_auto`（`:2037`）改为通用循环：

```python
def _disable_other_backend_auto(backend: str) -> None:
    """When one backend enables auto-import, force ALL others off + pin switch."""
    backend = normalize_remote_backend(backend)
    if backend not in REMOTE_BACKENDS:
        return
    _set_json_setting("remote_backend", backend)
    if backend != "grok2api":
        gbase = dict(_json_setting("grok2api_config") or {})
        if gbase.get("auto_upload_after_probe") or gbase.get("auto_upload_after_relogin"):
            gbase["auto_upload_after_probe"] = False
            gbase["auto_upload_after_relogin"] = False
            _set_json_setting("grok2api_config", normalize_grok2api_config(gbase))
    if backend != "cpa":
        cbase = dict(_json_setting("cpa_config") or {})
        if cbase.get("auto_upload_after_probe") or cbase.get("auto_upload_after_relogin"):
            cbase["auto_upload_after_probe"] = False
            cbase["auto_upload_after_relogin"] = False
            _set_json_setting("cpa_config", normalize_cpa_config(cbase))
    if backend != "sub2api":
        sbase = dict(_json_setting("sub2api_config") or {})
        if sbase.get("auto_upload_after_probe") or sbase.get("auto_upload_after_relogin"):
            sbase["auto_upload_after_probe"] = False
            sbase["auto_upload_after_relogin"] = False
            _set_json_setting("sub2api_config", normalize_sub2api_config(sbase))
```

同时更新 `set_grok2api_config`（`:2099`）与 `set_cpa_config`（`:2179`）末尾的"首存 pin"分支——两者当前只检查对方一家 ready，需补上 sub2api：把 `set_grok2api_config` 的 `elif` 分支改为同时检查 cpa 与 sub2api 均未 ready 才 pin grok2api；`set_cpa_config` 同理检查 grok2api 与 sub2api。

`set_grok2api_config` 末尾 `elif` 改为：

```python
    elif get_remote_backend(resolve=False) == "" and cfg.get("base_url"):
        ccfg = normalize_cpa_config(_json_setting("cpa_config") or {})
        scfg = normalize_sub2api_config(_json_setting("sub2api_config") or {})
        c_ready = bool(ccfg.get("base_url") and ccfg.get("management_key"))
        s_ready = bool(scfg.get("base_url") and scfg.get("api_key"))
        if not c_ready and not s_ready:
            _set_json_setting("remote_backend", "grok2api")
```

`set_cpa_config` 末尾 `elif` 改为：

```python
    elif get_remote_backend(resolve=False) == "" and cfg.get("base_url"):
        gcfg = normalize_grok2api_config(_json_setting("grok2api_config") or {})
        scfg = normalize_sub2api_config(_json_setting("sub2api_config") or {})
        g_ready = bool(gcfg.get("base_url") and gcfg.get("username") and gcfg.get("password"))
        s_ready = bool(scfg.get("base_url") and scfg.get("api_key"))
        if not g_ready and not s_ready:
            _set_json_setting("remote_backend", "cpa")
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `python -m pytest src/tests/test_sub2api.py -q`
Expected: PASS（Task1+Task2 共 7 passed）；无 Python 则记「测试待容器验证」

- [ ] **Step 5: 提交**

```bash
git add src/register_lite_store.py src/tests/test_sub2api.py
git commit -m "feat: 远端后端互斥改为通用三方（grok2api/cpa/sub2api）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: sub2api HTTP 辅助 + 代理同步

**Files:**
- Modify: `src/register_lite_store.py`（在 `upload_cpa_auth_files` 附近、`sync_remote_status` 之后加）
- Test: `src/tests/test_sub2api.py`（追加）

**Interfaces:**
- Consumes: `_urlopen`、`urllib.request`、`urllib.parse`、`json`。**该文件没有 module-level logger**——沿用现有 `print(f"[register-lite] ...")` 模式记 warning（见 `:1540`/`:3946`）。
- Produces:
  - `_sub2api_request(cfg, method, path, body=None, *, timeout=45.0) -> Any`（返回响应 `data` 字段；HTTP≥400 或 `code!=0` 抛 `RuntimeError`）
  - `_sub2api_parse_proxy(proxy_url: str) -> dict | None`（返回 `{protocol, host, port, username, password}` 或 None）
  - `_sub2api_ensure_proxy(cfg, proxy_url, cache: dict) -> int | None`

- [ ] **Step 1: 写失败测试**

（`register_lite_store.py` 没有 module-level logger；warning 用 `print(f"[register-lite] ...")`，与 `:1540`/`:3946` 一致。下方测试不依赖日志。）

追加到 `src/tests/test_sub2api.py`：

```python
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
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `python -m pytest src/tests/test_sub2api.py -q -k "Task 3 or parse_proxy or request_raises or ensure_proxy"`
Expected: FAIL（`_sub2api_parse_proxy` 未定义）

- [ ] **Step 3: 实现 HTTP 辅助 + 代理同步**

在 `register_lite_store.py` 的 `sync_remote_status` 函数之后加（`data` 字段的 GET/POST 响应形状按 sub2api `{code,message,data}` 包装；列表接口返回 `data.items`）：

```python
def _sub2api_headers(cfg: dict[str, Any]) -> dict[str, str]:
    return {
        "x-api-key": str(cfg.get("api_key") or ""),
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def _sub2api_request(
    cfg: dict[str, Any],
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    *,
    timeout: float = 45.0,
) -> Any:
    """调用 sub2api admin 接口。HTTP≥400 或 code!=0 抛 RuntimeError，返回 data 字段。"""
    base = str(cfg.get("base_url") or "").rstrip("/")
    if not base:
        raise ValueError("sub2api 地址不能为空")
    url = base + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, headers=_sub2api_headers(cfg), method=method)
    try:
        with _urlopen(req, timeout=timeout) as resp:
            status = int(resp.status)
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        status = int(exc.code)
        raw = exc.read().decode("utf-8", errors="replace")
    if status >= 400:
        raise RuntimeError(f"sub2api 请求失败 HTTP {status}: {raw[:500]}")
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"sub2api 返回非 JSON: {raw[:200]}") from exc
    if isinstance(payload, dict) and payload.get("code") not in (0, None):
        msg = str(payload.get("message") or payload.get("code"))
        raise RuntimeError(f"sub2api 返回错误 code={payload.get('code')}: {msg}")
    return payload.get("data") if isinstance(payload, dict) else payload


def _sub2api_parse_proxy(proxy_url: str) -> dict[str, Any] | None:
    text = str(proxy_url or "").strip()
    if not text:
        return None
    try:
        parsed = urllib.parse.urlsplit(text)
    except ValueError:
        return None
    scheme = (parsed.scheme or "").lower()
    if scheme == "socks":
        scheme = "socks5"
    if scheme not in {"http", "https", "socks5", "socks5h"}:
        return None
    host = parsed.hostname or ""
    port = parsed.port or 0
    if not host or port <= 0:
        return None
    return {
        "protocol": scheme,
        "host": host,
        "port": int(port),
        "username": parsed.username or "",
        "password": parsed.password or "",
    }


def _sub2api_ensure_proxy(cfg: dict[str, Any], proxy_url: str, cache: dict[str, Any]) -> int | None:
    """proxy_url → sub2api proxy_id。查重复用，未命中则创建。失败返回 None（降级直连）。"""
    parsed = _sub2api_parse_proxy(proxy_url)
    if not parsed:
        return None
    key = f"{parsed['protocol']}://{parsed['username']}@{parsed['host']}:{parsed['port']}"
    if "loaded" not in cache:
        cache["loaded"] = True
        cache["map"] = {}
        try:
            data = _sub2api_request(cfg, "GET", "/api/v1/admin/proxies/all")
            items = data.get("items") if isinstance(data, dict) else (data or [])
            for it in items or []:
                if not isinstance(it, dict):
                    continue
                k = f"{str(it.get('protocol') or '').lower()}://{it.get('username') or ''}@{it.get('host') or ''}:{it.get('port') or 0}"
                if it.get("id") is not None:
                    cache["map"][k] = int(it["id"])
        except Exception as exc:  # noqa: BLE001
            print(f"[register-lite] sub2api list proxies failed: {str(exc)[:200]}")
    if key in cache["map"]:
        return cache["map"][key]
    try:
        created = _sub2api_request(cfg, "POST", "/api/v1/admin/proxies", {
            "name": f"grok-register ({parsed['protocol']}://{parsed['host']}:{parsed['port']})",
            "protocol": parsed["protocol"],
            "host": parsed["host"],
            "port": parsed["port"],
            "username": parsed["username"],
            "password": parsed["password"],
        })
        pid = int(created["id"]) if isinstance(created, dict) and created.get("id") is not None else None
    except Exception as exc:  # noqa: BLE001
        print(f"[register-lite] sub2api create proxy failed: {str(exc)[:200]}")
        pid = None
    if pid is not None:
        cache["map"][key] = pid
    return pid
```

> warning 用 `print(f"[register-lite] ...")`——该文件无 module-level logger（见 `:1540`/`:3946`）。

- [ ] **Step 4: 运行测试，确认通过**

Run: `python -m pytest src/tests/test_sub2api.py -q`
Expected: PASS；无 Python 则记「测试待容器验证」

- [ ] **Step 5: 提交**

```bash
git add src/register_lite_store.py src/tests/test_sub2api.py
git commit -m "feat: sub2api HTTP 辅助 + 账号级代理同步（查重复用/创建/降级）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: sub2api 上传主流程 + 测试连接

**Files:**
- Modify: `src/register_lite_store.py`（在 Task 3 辅助之后加）
- Test: `src/tests/test_sub2api.py`（追加）

**Interfaces:**
- Consumes: `_verified_remote_import_emails`（`:4002`）、`_sub2api_request`、`_sub2api_ensure_proxy`（Task 3）、`mark_local_remote_imported`（`:3534`）、`_set_json_setting`、`init_db`、`_connect`。
- Produces:
  - `list_sub2api_sso_rows(limit: int = 1000, *, emails=None) -> list[dict]`（每项 `{email, sso, proxy_url}`，按 sso 去重）
  - `upload_sub2api_sso(config=None, *, limit=1000, emails=None, require_probe=True) -> dict`
  - `test_sub2api_remote(config=None) -> dict`（`{ok, base_url, grok_total}`）

- [ ] **Step 1: 写失败测试**

追加到 `src/tests/test_sub2api.py`：

```python
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
    # 成功 email 标记已导入
    with store._connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM remote_accounts WHERE provider='sub2api' AND lower(email)='a@ex.com'"
        ).fetchone()
    assert row is not None


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
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `python -m pytest src/tests/test_sub2api.py -q`
Expected: FAIL（`list_sub2api_sso_rows` 未定义）

- [ ] **Step 3: 实现上传主流程**

在 Task 3 辅助之后加：

```python
SUB2API_SSO_CHUNK = 10  # 每请求 token 数：服务端 3 并发做上游 SSO 转换，块小保响应快


def list_sub2api_sso_rows(limit: int = 1000, *, emails: list[str] | None = None) -> list[dict[str, Any]]:
    init_db()
    limit = max(1, min(5000, int(limit or 1000)))
    clean = sorted({str(e or "").strip().lower() for e in (emails or []) if str(e or "").strip()})
    where = ["sso IS NOT NULL", "sso != ''"]
    args: list[Any] = []
    if clean:
        where.append("lower(email) IN (" + ",".join("?" for _ in clean) + ")")
        args.extend(clean)
    with _connect() as conn:
        rows = conn.execute(
            "SELECT email, sso, proxy_url FROM accounts WHERE "
            + " AND ".join(where)
            + " ORDER BY updated_at DESC LIMIT ?",
            [*args, limit],
        ).fetchall()
    out: list[dict[str, Any]] = []
    seen_sso: set[str] = set()
    for row in rows:
        sso = str(row["sso"] or "").strip()
        if not sso or sso in seen_sso:
            continue
        seen_sso.add(sso)
        out.append({
            "email": str(row["email"] or ""),
            "sso": sso,
            "proxy_url": str(row["proxy_url"] or "").strip(),
        })
    return out


def upload_sub2api_sso(
    config: dict[str, Any] | None = None,
    *,
    limit: int = 1000,
    emails: list[str] | None = None,
    require_probe: bool = True,
) -> dict[str, Any]:
    cfg = normalize_sub2api_config(config or get_sub2api_config(include_key=True))
    if not cfg["base_url"]:
        raise ValueError("sub2api 地址不能为空")
    if not cfg["api_key"]:
        raise ValueError("sub2api 管理员 API Key 不能为空")
    approved, skipped = _verified_remote_import_emails(emails, limit=limit, require_probe=require_probe)
    approved_set = set(approved)
    rows = [r for r in list_sub2api_sso_rows(limit=limit, emails=approved) if r["email"].lower() in approved_set]
    # approved 里但无 sso 的账号：补进 skipped
    have_sso = {r["email"].lower() for r in rows}
    for email in approved:
        if email not in have_sso:
            skipped.append({"email": email, "reason": "本地无 SSO"})
    if not rows:
        return {
            "ok": False,
            "error": "没有可导入的 SSO" if not require_probe else "没有通过测活的 SSO 可导入",
            "total": 0, "uploaded": 0, "failed": 0,
            "skipped": len(skipped), "skipped_accounts": skipped[:100],
            "emails": [],
        }

    # 按 proxy_id 分组（sync_proxies 关闭或解析失败 → None 组）。
    proxy_cache: dict[str, Any] = {}
    groups: dict[Any, list[dict[str, Any]]] = {}
    for r in rows:
        pid = None
        if cfg["sync_proxies"] and r["proxy_url"]:
            pid = _sub2api_ensure_proxy(cfg, r["proxy_url"], proxy_cache)
        groups.setdefault(pid, []).append(r)

    uploaded = 0
    failed = 0
    ok_emails: list[str] = []
    fail_details: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []
    for pid, grp in groups.items():
        for i in range(0, len(grp), SUB2API_SSO_CHUNK):
            chunk = grp[i:i + SUB2API_SSO_CHUNK]
            body: dict[str, Any] = {"sso_tokens": [r["sso"] for r in chunk]}
            if pid is not None:
                body["proxy_id"] = pid
            try:
                data = _sub2api_request(cfg, "POST", "/api/v1/admin/grok/sso-to-oauth", body, timeout=120.0)
                created = (data.get("created") if isinstance(data, dict) else None) or []
                failed_items = (data.get("failed") if isinstance(data, dict) else None) or []
                for c in created:
                    idx = int(c.get("index") or 0)
                    if 1 <= idx <= len(chunk):
                        ok_emails.append(chunk[idx - 1]["email"])
                    uploaded += 1
                for f in failed_items:
                    idx = int(f.get("index") or 0)
                    em = chunk[idx - 1]["email"] if 1 <= idx <= len(chunk) else ""
                    fail_details.append({"email": em, "error": str(f.get("error") or "")[:200]})
                    failed += 1
                results.append({"proxy_id": pid, "tokens": len(chunk),
                                "created": len(created), "failed": len(failed_items),
                                "proxy_fallback": pid is None and bool(chunk[0]["proxy_url"]) if chunk else False})
            except Exception as exc:  # noqa: BLE001
                for r in chunk:
                    fail_details.append({"email": r["email"], "error": str(exc)[:200]})
                    failed += 1
                results.append({"proxy_id": pid, "tokens": len(chunk), "error": str(exc)[:200]})

    if ok_emails:
        try:
            mark_local_remote_imported(ok_emails, provider="sub2api", reason="manual_upload_sub2api" if not require_probe else "auto_upload_sub2api")
        except Exception:
            pass
    _set_json_setting("sub2api_last_upload", {
        "at": time.time(), "total": len(rows), "uploaded": uploaded, "failed": failed,
        "base_url": cfg["base_url"],
    })
    return {
        "ok": failed == 0 and uploaded > 0,
        "base_url": cfg["base_url"],
        "total": len(rows),
        "uploaded": uploaded,
        "failed": failed,
        "fail_details": fail_details[:100],
        "skipped": len(skipped),
        "skipped_accounts": skipped[:100],
        "results": results[:50],
        "emails": ok_emails,
    }


def test_sub2api_remote(config: dict[str, Any] | None = None) -> dict[str, Any]:
    cfg = normalize_sub2api_config(config or get_sub2api_config(include_key=True))
    if not cfg["base_url"]:
        raise ValueError("sub2api 地址不能为空")
    if not cfg["api_key"]:
        raise ValueError("sub2api 管理员 API Key 不能为空")
    data = _sub2api_request(cfg, "GET", "/api/v1/admin/accounts?platform=grok&page_size=1", timeout=30.0)
    total = 0
    if isinstance(data, dict):
        total = int(data.get("total") or 0)
    return {"ok": True, "base_url": cfg["base_url"], "grok_total": total}
```

> `sub2api_last_upload.at` 用 `time.time()`（该文件已 `import time`）。

- [ ] **Step 4: 运行测试，确认通过**

Run: `python -m pytest src/tests/test_sub2api.py -q`
Expected: PASS；无 Python 则记「测试待容器验证」

- [ ] **Step 5: 提交**

```bash
git add src/register_lite_store.py src/tests/test_sub2api.py
git commit -m "feat: sub2api 上传主流程（按代理分组分块+index映射+测试连接）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: 自动上传接入调度（_upload_emails_to_remotes）

**Files:**
- Modify: `src/register_lite_store.py:2308-2389`（`_upload_emails_to_remotes` 的三块 skip 提示 + 新增 sub2api 块）
- Test: `src/tests/test_sub2api.py`（追加）

**Interfaces:**
- Consumes: `get_remote_backend`、`get_sub2api_config`、`upload_sub2api_sso`、`mark_local_remote_imported`。
- Produces: `_upload_emails_to_remotes(emails, mode=...)` 返回字典新增 `"sub2api"` 键；backend 互斥时 skip 记录相应更新。

- [ ] **Step 1: 写失败测试**

追加到 `src/tests/test_sub2api.py`：

```python
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
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `python -m pytest src/tests/test_sub2api.py -q -k auto_upload_routes`
Expected: FAIL（`out` 无 `"sub2api"` 键 / backend 断言失败）

- [ ] **Step 3: 接入调度块**

在 `_upload_emails_to_remotes`（`:2265`）里：

1. `out` 初始字典加 `"sub2api": None`（在 `"cpa": None,` 后）。
2. 现有 grok2api 块的 skip 提示 `"grok2api skipped: remote_backend=cpa"` 改为 `f"grok2api skipped: remote_backend={backend}"`；同理 cpa 块 `"cpa skipped: remote_backend=grok2api"` 改为 `f"cpa skipped: remote_backend={backend}"`。同时把两块的 `enabled` 判断 `(backend in {"", "grok2api"})` / `(backend in {"", "cpa"})` 保持不变（它们已排除对方，天然排除 sub2api）。
3. 在 cpa 块（`if backend == "grok2api": ... else: ...`）之后加 sub2api 块：

```python
    # sub2api (skipped when backend is grok2api or cpa)
    if backend in {"grok2api", "cpa"}:
        out["skipped"].append(f"sub2api skipped: remote_backend={backend}")
    else:
        try:
            scfg = get_sub2api_config(include_key=True)
            s_enabled = bool(scfg.get(flag_key)) and (backend in {"", "sub2api"})
            s_ready = bool(scfg.get("base_url") and scfg.get("api_key"))
            if s_enabled and s_ready:
                limit = max(len(clean), int(scfg.get("limit") or len(clean)))
                result = upload_sub2api_sso(scfg, limit=limit, emails=clean, require_probe=True)
                out["sub2api"] = result
                if not result.get("ok"):
                    out["ok"] = False
                else:
                    marked = result.get("emails") if isinstance(result.get("emails"), list) else clean
                    try:
                        mark_local_remote_imported(marked, provider="sub2api", reason=f"auto_upload_{skip_tag}")
                    except Exception:
                        pass
            elif s_enabled and not s_ready:
                out["sub2api"] = {"ok": False, "error": "sub2api 连接未配置完整"}
                out["ok"] = False
            else:
                out["skipped"].append(f"sub2api auto {skip_tag} off")
        except Exception as exc:  # noqa: BLE001
            out["sub2api"] = {"ok": False, "error": str(exc)[:300]}
            out["ok"] = False
```

> `flag_key`、`skip_tag`、`clean`、`backend` 均为函数内已有局部变量（`:2289-2306`）。

- [ ] **Step 4: 运行测试，确认通过**

Run: `python -m pytest src/tests/test_sub2api.py -q`
Expected: PASS（全部）；无 Python 则记「测试待容器验证」

- [ ] **Step 5: 提交**

```bash
git add src/register_lite_store.py src/tests/test_sub2api.py
git commit -m "feat: sub2api 接入测活/重登后自动上传调度

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: API 端点（register_lite_app.py）

**Files:**
- Modify: `src/register_lite_app.py`（`CpaUploadBody` 后加两个 Body；CPA 端点之后加 4 个路由）
- Test: `src/tests/test_sub2api.py`（追加 body/端点回归测试）

**Interfaces:**
- Consumes: `lite_store.get_sub2api_config/set_sub2api_config/normalize_sub2api_config/test_sub2api_remote/upload_sub2api_sso`、`_admin_path`、`_clean_emails`、`asyncio.to_thread`、`HTTPException`。
- Produces: `Sub2ApiConfigBody`、`Sub2ApiUploadBody`；路由 `GET/PUT /api/sub2api/config`、`POST /api/sub2api/test`、`POST /api/sub2api/upload`。

- [ ] **Step 1: 写失败测试**

追加到 `src/tests/test_sub2api.py`：

```python
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
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `python -m pytest src/tests/test_sub2api.py -q -k config_body_roundtrip`
Expected: FAIL（`ImportError: cannot import name 'Sub2ApiConfigBody'`）

- [ ] **Step 3: 实现 Body + 端点**

在 `register_lite_app.py` 的 `class CpaUploadBody` 之后加：

```python
class Sub2ApiConfigBody(BaseModel):
    base_url: str | None = None
    api_key: str | None = None
    limit: int | None = None
    sync_proxies: bool | None = None
    auto_upload_after_probe: bool | None = None
    auto_upload_after_relogin: bool | None = None


class Sub2ApiUploadBody(BaseModel):
    limit: int = 1000
    emails: list[str] | None = None
```

在 CPA 端点区块（`@app.post(_admin_path('api', 'cpa', 'delete-abnormal'))` 对应函数）之后加 4 个端点：

```python
@app.get(_admin_path('api', 'sub2api', 'config'))
async def get_sub2api_config():
    return {"ok": True, "config": lite_store.get_sub2api_config(include_key=True), "source": "sqlite"}


@app.put(_admin_path('api', 'sub2api', 'config'))
async def put_sub2api_config(body: Sub2ApiConfigBody):
    try:
        cfg = lite_store.set_sub2api_config(body.model_dump(exclude_none=False), replace=False)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    backend = lite_store.get_remote_backend(resolve=True)
    return {
        "ok": True,
        "config": cfg,
        "backend": backend,
        "message": "sub2api 配置已保存"
        + ("（已锁定远端对接=sub2api，Grok2API/CPA 自动导入已关闭）" if backend == "sub2api" else ""),
    }


@app.post(_admin_path('api', 'sub2api', 'test'))
async def test_sub2api(body: Sub2ApiConfigBody):
    cfg = lite_store.normalize_sub2api_config(body.model_dump(exclude_none=False))
    try:
        return await asyncio.to_thread(lite_store.test_sub2api_remote, cfg)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post(_admin_path('api', 'sub2api', 'upload'))
async def upload_sub2api(body: Sub2ApiUploadBody):
    limit = max(1, min(5000, int(body.limit or 1000)))
    emails = _clean_emails(body.emails)
    try:
        return await asyncio.to_thread(
            lite_store.upload_sub2api_sso,
            None,
            limit=limit,
            emails=emails,
            require_probe=False,
        )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(e)) from e
```

> `POST /api/sub2api/test` 用 `normalize_sub2api_config` 处理 body——若前端传掩码 `********` 且要求测已存 key，`normalize` 不做掩码保留。**改为**：test 端点若 `api_key` 为掩码则 fall back 到已存配置。实现时在 `test_sub2api` 里：

```python
async def test_sub2api(body: Sub2ApiConfigBody):
    raw = body.model_dump(exclude_none=False)
    key = str(raw.get("api_key") or "")
    if (not key.strip()) or set(key.strip()) == {"*"} or key.strip() == "********":
        stored = lite_store.get_sub2api_config(include_key=True)
        raw["api_key"] = stored.get("api_key") or ""
    cfg = lite_store.normalize_sub2api_config(raw)
    try:
        return await asyncio.to_thread(lite_store.test_sub2api_remote, cfg)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(e)) from e
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `python -m pytest src/tests/test_sub2api.py -q`
Expected: PASS（全部）；无 Python 则记「测试待容器验证」

- [ ] **Step 5: 提交**

```bash
git add src/register_lite_app.py src/tests/test_sub2api.py
git commit -m "feat: sub2api API 端点（config/test/upload）+ Pydantic body

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: 前端 — RemoteCards 第三张卡 + 三方互斥

**Files:**
- Modify: `web/src/components/settings/RemoteCards.tsx`
- Verify: `npm run typecheck`（本机 node 可跑）

**Interfaces:**
- Consumes: `adminUrl`、`api`、`renderLog`、`Badge`、`Terminal`、`useToast`（文件已 import）。
- Produces: 无对外接口，纯 UI。

- [ ] **Step 1: 扩展类型与状态**

- `type Backend = "" | "grok2api" | "cpa" | "sub2api";`
- 加接口：

```tsx
interface Sub2apiCfg {
  base_url?: string;
  api_key?: string;
  limit?: number;
  sync_proxies?: boolean;
  auto_upload_after_probe?: boolean;
  auto_upload_after_relogin?: boolean;
}
```

- 加状态（在 CPA 状态之后）：

```tsx
  const [s, setS] = useState<Sub2apiCfg>({ limit: 1000, sync_proxies: true });
  const [sProbe, setSProbe] = useState(false);
  const [sRelogin, setSRelogin] = useState(false);
  const [sStatus, setSStatus] = useState<{ text: string; kind: "" | "ok" | "warn" | "bad"; show: boolean }>({ text: "待机", kind: "", show: false });
  const [sLog, setSLog] = useState<unknown>(null);
```

- [ ] **Step 2: 三方互斥 enforceExclusive**

把 `enforceExclusive` 的 `source` 类型改为 `"grok2api" | "cpa" | "sub2api" | "load"`，并重写为通用三方（保持 `grok2api > cpa > sub2api` 优先）：

```tsx
  const enforceExclusive = useCallback(
    (source: "grok2api" | "cpa" | "sub2api" | "load",
     next?: { gp?: boolean; gr?: boolean; cp?: boolean; cr?: boolean; sp?: boolean; sr?: boolean }) => {
      const gOn = (next?.gp ?? gProbe) || (next?.gr ?? gRelogin);
      const cOn = (next?.cp ?? cProbe) || (next?.cr ?? cRelogin);
      const sOn = (next?.sp ?? sProbe) || (next?.sr ?? sRelogin);
      const clearG = () => { setGProbe(false); setGRelogin(false); };
      const clearC = () => { setCProbe(false); setCRelogin(false); };
      const clearS = () => { setSProbe(false); setSRelogin(false); };
      if (source === "grok2api" && gOn) { clearC(); clearS(); setBackend("grok2api"); return; }
      if (source === "cpa" && cOn) { clearG(); clearS(); setBackend("cpa"); return; }
      if (source === "sub2api" && sOn) { clearG(); clearC(); setBackend("sub2api"); return; }
      // load / 无明确来源：多者并存时按 pin 或优先级留一个
      const on = [["grok2api", gOn], ["cpa", cOn], ["sub2api", sOn]].filter(([, v]) => v).map(([k]) => k as Backend);
      if (on.length <= 1) {
        if (on.length === 1) setBackend(on[0]);
        return;
      }
      const pinned = backendRef.current;
      const keep = pinned && on.includes(pinned) ? pinned : on[0];
      if (keep !== "grok2api") clearG();
      if (keep !== "cpa") clearC();
      if (keep !== "sub2api") clearS();
      setBackend(keep);
    },
    [gProbe, gRelogin, cProbe, cRelogin, sProbe, sRelogin],
  );
```

- [ ] **Step 3: load/apply/payload/save/test for sub2api**

- 加 `applySub2api`（照 `applyCpa`，掩码字段是 `api_key`）：

```tsx
  const applySub2api = useCallback((cfg: Sub2apiCfg) => {
    cfg = cfg || {};
    setS({
      base_url: cfg.base_url || "",
      api_key: isMask(cfg.api_key || "") ? "" : cfg.api_key || "",
      limit: cfg.limit == null ? 1000 : cfg.limit,
      sync_proxies: cfg.sync_proxies !== false,
    });
    setSProbe(!!cfg.auto_upload_after_probe);
    setSRelogin(!!cfg.auto_upload_after_relogin);
  }, []);

  const loadSub2api = useCallback(async () => {
    const data = await api<{ config: Sub2apiCfg }>(adminUrl("api", "sub2api", "config"));
    applySub2api(data.config);
  }, [applySub2api]);
```

- `useEffect` 里加 `loadSub2api().catch(() => {});` 并把它加入依赖数组。
- `loadBackend` 与 `saveBackend` 里的三元 `b === "cpa" ? "CPA" : "Grok2API"` 改为帮助函数：

```tsx
  const backendLabel = (b: Backend) => b === "sub2api" ? "sub2api" : b === "cpa" ? "CPA" : b === "grok2api" ? "Grok2API" : "未锁定";
```

替换 `backendStatus` 文案里所有旧三元为 `backendLabel(b)`。`saveBackend` 里 `if (data.sub2api) applySub2api(data.sub2api);` —— 但 PUT remote-backend 返回体目前只含 grok2api/cpa。**改后端**：这一步只需前端不崩；`saveBackend` 末尾追加 `await loadSub2api().catch(() => {});`。

- 加 `sub2apiPayload` / `saveSub2api` / `testSub2api`：

```tsx
  const sub2apiPayload = () => {
    let key = s.api_key || "";
    if (isMask(key)) key = "";
    return {
      base_url: (s.base_url || "").trim(),
      api_key: key,
      limit: s.limit ?? 1000,
      sync_proxies: s.sync_proxies !== false,
      auto_upload_after_probe: sProbe,
      auto_upload_after_relogin: sRelogin,
    };
  };

  const saveSub2api = async () => {
    enforceExclusive("sub2api");
    setSStatus({ text: "保存中", kind: "warn", show: true });
    const data = await api<any>(adminUrl("api", "sub2api", "config"), { method: "PUT", body: JSON.stringify(sub2apiPayload()) });
    applySub2api(data.config);
    if (data.backend) setBackend(data.backend);
    setSStatus({ text: "已保存", kind: "ok", show: true });
    setSLog(data);
    toast(data.message || "sub2api 配置已保存");
    await loadGrok2api().catch(() => {});
    await loadCpa().catch(() => {});
    await loadBackend().catch(() => {});
  };

  const testSub2api = async () => {
    setSStatus({ text: "测试中", kind: "warn", show: true });
    const data = await api<any>(adminUrl("api", "sub2api", "test"), { method: "POST", body: JSON.stringify(sub2apiPayload()) });
    setSStatus({ text: data.ok ? "测试通过" : "测试失败", kind: data.ok ? "ok" : "bad", show: true });
    setSLog(data);
    toast(data.ok ? "sub2api 可用" + (data.grok_total != null ? " · grok " + data.grok_total : "") : data.error || data.message || "sub2api 测试失败");
  };
```

- 扩展 `run` 的 `which` 类型为 `"g" | "c" | "s" | "b"`，并在 setter/log 分支加 `s`：

```tsx
  const run = (fn: () => Promise<void>, which: "g" | "c" | "s" | "b") => {
    fn().catch((err) => {
      const setter = which === "g" ? setGStatus : which === "c" ? setCStatus : which === "s" ? setSStatus : setBackendStatus;
      setter({ text: "失败", kind: "bad", show: true });
      if (which === "g") setGLog((err as { payload?: unknown }).payload || (err as Error).message);
      if (which === "c") setCLog((err as { payload?: unknown }).payload || (err as Error).message);
      if (which === "s") setSLog((err as { payload?: unknown }).payload || (err as Error).message);
      toast((err as Error).message);
    });
  };
```

- [ ] **Step 4: JSX — 下拉选项 + 第三张卡**

- 远端下拉加：`<option value="sub2api">sub2api</option>`（在 cpa option 后）。
- 顶部说明文案 `Grok2API 与 CPA 二选一` 改为 `Grok2API / CPA / sub2api 三选一`。
- 在 CPA `card-block`（结尾 `</div>` 之后、`</>` 之前）加 sub2api 卡：

```tsx
      <div className="card-block" style={{ marginTop: 12 }}>
        <div className="section-head" style={{ padding: 0, border: 0, marginBottom: 10 }}>
          <div>
            <h3 className="section-title" style={{ fontSize: 14, margin: 0 }}>sub2api</h3>
          </div>
          <div className="header-checks">
            <label className="header-check">
              <input type="checkbox" checked={sProbe} onChange={(e) => { setSProbe(e.target.checked); enforceExclusive("sub2api", { sp: e.target.checked }); }} />
              注册测活通过后自动导入
            </label>
            <label className="header-check" title="重登批次结束后，仅同步测活通过的账号">
              <input type="checkbox" checked={sRelogin} onChange={(e) => { setSRelogin(e.target.checked); enforceExclusive("sub2api", { sr: e.target.checked }); }} />
              重登测活通过后自动导入
            </label>
            <label className="header-check" title="上传时把本地账号的代理同步到 sub2api 并逐账号关联">
              <input type="checkbox" checked={s.sync_proxies !== false} onChange={(e) => setS({ ...s, sync_proxies: e.target.checked })} />
              同步账号代理
            </label>
          </div>
          <div className="actions">
            <button className="btn" type="button" onClick={() => run(saveSub2api, "s")}>保存</button>
            <button className="btn" type="button" onClick={() => run(testSub2api, "s")}>测试</button>
          </div>
        </div>
        <div className="form-grid">
          <div className="span-2">
            <label htmlFor="sub2api_base_url">地址</label>
            <input id="sub2api_base_url" placeholder="https://sub2api.example 或 admin 完整链接" value={s.base_url || ""} onChange={(e) => setS({ ...s, base_url: e.target.value })} />
          </div>
          <div className="span-2">
            <label htmlFor="sub2api_api_key">管理员 API Key</label>
            <input id="sub2api_api_key" type="password" autoComplete="off" value={s.api_key || ""} onChange={(e) => setS({ ...s, api_key: e.target.value })} />
          </div>
          <div>
            <label htmlFor="sub2api_limit">上限</label>
            <input id="sub2api_limit" type="number" min={1} max={5000} value={s.limit ?? 1000} onChange={(e) => setS({ ...s, limit: Number(e.target.value) })} />
          </div>
        </div>
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>通过 sub2api 原生 <code>/admin/grok/sso-to-oauth</code> 导入：只上传本地 SSO，转换与探活由 sub2api 完成。需先在 sub2api 后台开启管理员 API Key。</p>
        {sStatus.show && <Badge kind={sStatus.kind}>{sStatus.text}</Badge>}
        {sLog != null && <Terminal content={renderLog("sub2api-log", sLog)} />}
      </div>
```

- [ ] **Step 5: typecheck + 提交**

Run: `cd web && npm run typecheck`
Expected: 无 TS 报错

```bash
git add web/src/components/settings/RemoteCards.tsx
git commit -m "feat(web): 远端对接设置加 sub2api 第三张卡 + 三方互斥

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 8: 前端 — 账号页「sub2api 导入」按钮

**Files:**
- Modify: `web/src/pages/AccountsView.tsx`（加 `uploadSelectedSub2api` + 按钮）
- Verify: `npm run typecheck`

**Interfaces:**
- Consumes: `selectedEmails`、`toast`、`setStatusBadge`、`op`、`setLogData`、`api`、`adminUrl`、`toChineseText`、`refresh`（`uploadSelectedCpa` 已用同款）。
- Produces: 无对外接口。

- [ ] **Step 1: 加 uploadSelectedSub2api**

在 `uploadSelectedCpa` 之后加（照抄结构，字段对齐 `upload_sub2api_sso` 返回体）：

```tsx
  const uploadSelectedSub2api = async () => {
    const emails = selectedEmails();
    if (!emails.length) {
      toast("先选择账号");
      return;
    }
    setStatusBadge({ text: "sub2api 导入中：0 / " + emails.length, kind: "warn" });
    op.show("sub2api 导入日志", "准备导入 " + emails.length + " 个选中账号...\n只上传本地 SSO，转换与探活由 sub2api 完成。");
    const data = await api<any>(adminUrl("api", "sub2api", "upload"), {
      method: "POST",
      body: JSON.stringify({ limit: emails.length, emails }),
    });
    setLogData(data);
    const uploaded = data.uploaded || 0;
    const failed = data.failed || 0;
    const skipped = data.skipped || 0;
    let detail = "";
    if (Array.isArray(data.fail_details) && data.fail_details.length) {
      detail = "\n失败明细：\n" + data.fail_details.slice(0, 20).map((f: any) => `  ${f.email || "?"}: ${toChineseText(f.error || "")}`).join("\n");
    }
    op.update("sub2api 导入完成\n成功：" + uploaded + "\n失败：" + failed + "\n跳过：" + skipped + (data.error ? "\n错误：" + toChineseText(data.error) : "") + detail);
    setStatusBadge({ text: "sub2api：成功 " + uploaded + "，失败 " + failed, kind: data.ok ? "ok" : "warn" });
    toast("sub2api 已处理：" + uploaded);
    await refresh();
  };
```

- [ ] **Step 2: 加按钮**

在 CPA 导入按钮（`<button ... onClick={() => run(uploadSelectedCpa)}>CPA 导入</button>`）之后加：

```tsx
            <button className="btn" type="button" onClick={() => run(uploadSelectedSub2api)}>sub2api 导入</button>
```

> `run` 是 AccountsView 局部包装器（`grep -n "const run =" web/src/pages/AccountsView.tsx` 确认签名；若它接受单参 `fn`，直接传）。

- [ ] **Step 3: typecheck**

Run: `cd web && npm run typecheck`
Expected: 无 TS 报错

- [ ] **Step 4: 提交**

```bash
git add web/src/pages/AccountsView.tsx
git commit -m "feat(web): 账号页加 sub2api 导入按钮

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 9: README 功能概览补充 + 全量验证

**Files:**
- Modify: `README.md`（功能概览段落补一句 sub2api 导入）
- Verify: 前端 build + 全测试

**Interfaces:** 无。

- [ ] **Step 1: README 补充**

Run: `grep -n "CPA\|远端\|导入" README.md | head`
在功能概览里 CPA/Grok2API 相关句子旁补一句（保持现有中文语气）：

> - 远端对接支持第三方 **sub2api**：通过其原生 `sso-to-oauth` 接口导入账号（仅上传本地 SSO，转换/探活由 sub2api 完成），与 Grok2API / CPA 三选一互斥；支持账号级代理同步、测活/重登后自动上传、手动批量导入。

- [ ] **Step 2: 前端全量 build**

Run: `cd web && npm run build`
Expected: build 成功，无 TS 错误

- [ ] **Step 3: 后端全量测试**

Run: `python -m pytest src/tests -q`
Expected: 全部 PASS；若无本机 Python，在容器内跑 `docker compose run --rm ... pytest src/tests`（照历史做法），或标注「测试待容器验证」并人工确认下述冒烟点：
- 设置页保存 sub2api 配置后锁定 backend=sub2api，Grok2API/CPA 自动导入被清空
- 账号页选中账号点「sub2api 导入」，日志显示 成功/失败/跳过

- [ ] **Step 4: 提交**

```bash
git add README.md
git commit -m "docs: README 功能概览补充 sub2api 远端导入

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review 结论

**Spec coverage：**
- 配置层（掩码/环境变量/sync_proxies）→ Task 1 ✓
- 三方互斥（get/set/disable + 首存 pin）→ Task 2 ✓
- HTTP 辅助 + 代理解析/查重/创建/降级 → Task 3 ✓
- 上传主流程（资格筛选/去重/按代理分组/10 块/index 映射/标已导入/无 sso 跳过）→ Task 4 ✓
- test_sub2api_remote → Task 4 ✓
- 自动上传调度块 → Task 5 ✓
- 4 个 API 端点 + 掩码 test 回退 → Task 6 ✓
- 前端配置卡 + 三方互斥 → Task 7 ✓
- 账号页导入按钮 → Task 8 ✓
- 错误处理（code!=0/块级失败不废整批/代理降级/无 sso）→ Task 3/4 覆盖 ✓
- 测试（归一化/掩码/互斥/proxy 解析/分组/index 映射/块失败）→ Task 1-6 各步 ✓

**类型一致性：** `normalize_sub2api_config`/`get_sub2api_config`/`set_sub2api_config`/`upload_sub2api_sso`/`test_sub2api_remote`/`_sub2api_request`/`_sub2api_ensure_proxy`/`_sub2api_parse_proxy`/`list_sub2api_sso_rows` 在定义（Task 1/3/4）与调用（Task 5/6）间签名一致；前端 `Backend` 联合类型、`enforceExclusive` source、`run` which 全程扩到 sub2api。

**待实现时确认的一个点（已在步骤内标注）：**
1. `sub2api_last_upload.at` 用 `time.time()`（文件已 import time）— Task 4 Step 3 已注明。`register_lite_store.py` 无 module-level logger，warning 一律用 `print(f"[register-lite] ...")` — Task 3 已改。
