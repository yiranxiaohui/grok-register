# 导入账号到 sub2api（第三远端后端） — 设计文档

日期：2026-07-21
状态：已通过设计评审，待写实现计划

## 背景

grok-register 目前支持两个远端后端：Grok2API（用户名密码登录 + auth 文件/网页 SSO 导入）与 CPA（management key + 原生 auth-files）。两者通过 `remote_backend` 互斥开关调度：测活/重登通过后自动上传只走锁定的那一侧。

现在需要把注册好的 xAI 账号导入第三方项目 sub2api（`D:\Projects\sub2api`，Go + Gin 的 AI API 网关）。sub2api 已内建完整的 Grok 平台支持，**本设计对 sub2api 零改动**。

## 目标

- sub2api 成为第三个远端后端，加入 `remote_backend` 互斥体系。
- 设置页新增 sub2api 配置卡：地址、管理员 API Key、上限、代理同步开关、测活/重登后自动上传勾选、测试连接。
- 账号页新增「sub2api 导入」手动批量上传按钮（不要求测活通过，与另两家一致）。
- 测活/重登后自动上传接入现有 `_upload_emails_to_remotes` 调度。
- 本地账号级代理（`accounts.proxy_url`）同步到 sub2api 并逐账号关联。

### 非目标（YAGNI）

- 不做远端状态同步（拉 sub2api 账号列表归类到 `remote_accounts`）、不做删除异常账号——后续需要再加。
- 不改 sub2api 任何代码。
- 不支持用户名密码登录 sub2api——只用管理员 API Key（`x-api-key` 头）。

## 关键事实：sub2api 接口（已核实）

均在 `/api/v1/admin/` 前缀下，认证中间件 `admin_auth.go` 支持 `x-api-key: <admin-api-key>` 头（需在 sub2api 后台先开启管理员 API Key）。响应统一 `{code, message, data}`，`code=0` 为成功。

- **SSO 批量导入**：`POST /api/v1/admin/grok/sso-to-oauth`（`grok_oauth_handler.go:306`）
  - 请求：`{"sso_tokens": ["...", ...], "proxy_id": <int64|省略>, "group_ids": [<id>, ...]|省略}`；`group_ids` 来自设置页预配置，空则 sub2api 自动绑 `grok-default`。
  - 服务端行为：3 并发（`grokSSOImportConcurrency=3`）逐 token 调 x.ai 做 SSO→OAuth Build token 转换（走 `proxy_id` 指定的代理），创建 Grok OAuth 账号，自动绑 `grok-default` 分组，调度导入探针（`scheduleGrokImportProbe`）。
  - 响应 `data`：`{"created": [{index, name, email, account}], "failed": [{index, error}]}`；**index 从 1 开始**，对应请求 tokens 顺序。
  - ⚠️ `normalizeSSOImportTokens` 会按逗号/换行拆分并**去重**——若请求里有重复 token，索引会错位。因此本地必须先按 sso 去重再发。
  - ⚠️ `proxy_id` 是**请求级**参数（整批共用），不是 token 级——账号级代理必须按代理分组、分多次请求。
- **代理列表**：`GET /api/v1/admin/proxies/all`（返回全部 active 代理，含 protocol/host/port/username）。
- **代理创建**：`POST /api/v1/admin/proxies`，`{name, protocol(http|https|socks5|socks5h), host, port, username, password}`（`proxy_handler.go:29`）。
- **连通性测试用**：`GET /api/v1/admin/accounts?platform=grok&page_size=1`，分页响应含 `data.total`。

## 现状关键点（本项目侧）

- `REMOTE_BACKENDS = ("grok2api", "cpa")`（`register_lite_store.py:124`）；互斥逻辑在 `get_remote_backend` 推断、`set_remote_backend`、`_disable_other_backend_auto`、`_mask_auto_by_remote_pin` 四处，全部是两两写死，需改成对"其余所有后端"循环。
- 自动上传调度 `_upload_emails_to_remotes`（`:2265`）按后端逐块判断 `enabled/ready` 并上传，加 sub2api 块即可让测活/重登自动上传生效；成功后 `mark_local_remote_imported(provider=...)` 写「已导入」缓存。
- 手动上传资格 `_verified_remote_import_emails(require_probe=False)`（`:4002`）已返回含 `sso` 列的行——sub2api 上传只需要 `email/sso/proxy_url`，新增专用查询函数。
- 账号表已有 `proxy_url` 列（`socks5://user:pass@host:port` 等完整 URL），CPA 上传时已注入 auth JSON 顶层，sub2api 侧需解析成结构化字段。
- 配置掩码模式照抄 CPA：`api_key` 存库，读取时 `include_key=False` 返回 `********`，保存时收到全 `*` 则保留旧值。
- 前端 `RemoteCards.tsx` 的互斥联动（`enforceExclusive`）、`AccountsView.tsx` 的手动导入按钮（`uploadSelectedCpa` 模式）均有现成参照。

## 详细设计

### 组件 1：配置层（register_lite_store.py）

```python
DEFAULT_SUB2API_CONFIG = {
    "base_url": os.getenv("GROK_REGISTER_LITE_SUB2API_BASE_URL", ""),
    "api_key": os.getenv("GROK_REGISTER_LITE_SUB2API_API_KEY", ""),
    "limit": 1000,
    "sync_proxies": True,          # 关掉则全部不带 proxy_id 上传
    "auto_upload_after_probe": False,
    "auto_upload_after_relogin": False,
}
```

`normalize_sub2api_config` / `get_sub2api_config(include_key)` / `set_sub2api_config`：照抄 CPA 三件套，`ready = base_url and api_key`。`normalize_remote_backend` 别名加 `{"s2a", "sub2", "sub_2api", "sub2api"}`。

互斥改造：
- `get_remote_backend`：三方各算 `ready/auto_active`；唯一 active 者胜出，否则唯一 ready 者胜出，多个并存按 `grok2api > cpa > sub2api` 优先（保持现有行为兼容）。
- `set_remote_backend(value)` / `_disable_other_backend_auto(backend)`：循环关掉除锁定侧外**所有**后端的两个 auto 勾选。
- `_mask_auto_by_remote_pin(cfg, side)`：逻辑不变（pin 且 pin≠side 则展示为关），天然支持第三方。
- `set_sub2api_config` 保存时若勾了 auto → `_disable_other_backend_auto("sub2api")`；未勾且无 pin 且另两家未配置 → pin 为 sub2api（对齐另两家的首存 pin 行为）。

### 组件 2：上传层（register_lite_store.py）

**`list_sub2api_sso_rows(limit, emails)`** — 查询 `email, sso, proxy_url`，`sso` 非空，按 email 过滤，`updated_at DESC`，**按 sso 去重**（防 sub2api 侧去重导致索引错位）。

**`_sub2api_request(cfg, method, path, body=None, timeout=...)`** — 统一 HTTP 辅助：`x-api-key` 头 + JSON 编解码，走 `_urlopen`；HTTP ≥400 或 `code != 0` 抛 `RuntimeError`（含截断 body），返回 `data` 字段。

**`_sub2api_ensure_proxy(cfg, proxy_url, cache)`** — proxy_url → sub2api proxy_id：
1. `urllib.parse.urlsplit` 解析 scheme/host/port/user/pass；scheme 归一（`socks`→`socks5`；`http/https/socks5/socks5h` 之外返回 None）。
2. 首次调用 `GET /admin/proxies/all` 填充 cache；按 protocol+host+port+username 匹配（大小写不敏感协议）。
3. 未命中则 `POST /admin/proxies` 创建，命名 `grok-register (<protocol>://<host>:<port>)`，加入 cache。
4. 解析失败/创建失败返回 None 并记 warning（**降级为不带 proxy_id 上传，不阻断**）。

**`upload_sub2api_sso(config=None, *, limit, emails=None, require_probe=True)`** — 主流程：
1. `_verified_remote_import_emails` 筛资格（语义与另两家一致）→ `list_sub2api_sso_rows` 取行。
2. `sync_proxies` 开启时逐行解析 proxy_id；按 proxy_id（含 None）分组。
3. 每组内按 **10 个 token 一块**（服务端 3 并发做上游 SSO 转换，块小保响应快），逐块 `POST /admin/grok/sso-to-oauth`，超时 120s。
4. 块结果按 `index-1` 映射回本块 email 列表；汇总 `created/failed` 明细。
5. 有成功则 `mark_local_remote_imported(成功 emails, provider="sub2api", reason=...)`；写 `sub2api_last_upload` 设置项。
6. 返回 `{ok, base_url, total, uploaded, failed, skipped, skipped_accounts, results[:50], emails}`——字段形状对齐 CPA，前端日志渲染可复用。

**`test_sub2api_remote(config)`** — `GET /admin/accounts?platform=grok&page_size=1`，返回 `{ok, base_url, grok_total}`。

**`_upload_emails_to_remotes`**：加 sub2api 块（骨架同 CPA 块）：`backend in {"", "sub2api"}` 且 auto 勾选且 ready → `upload_sub2api_sso(require_probe=True)`；其余 backend 值时 skip 记录。三块的互斥 skip 提示语相应更新。

### 组件 3：API 端点（register_lite_app.py）

- `GET /api/sub2api/config` → `{ok, config}`（含明文 key，对齐 CPA 现状）
- `PUT /api/sub2api/config`（`Sub2ApiConfigBody`：base_url/api_key/limit/sync_proxies/两 auto 勾选，全 Optional）→ 保存 + 返回 backend 锁定提示
- `POST /api/sub2api/test` → `test_sub2api_remote`
- `POST /api/sub2api/upload`（`{emails, limit}`）→ `upload_sub2api_sso(require_probe=False)`

### 组件 4：前端（web/src）

- `RemoteCards.tsx`：
  - `type Backend = "" | "grok2api" | "cpa" | "sub2api"`；下拉加 `sub2api` 选项。
  - 新增 Sub2API 卡：地址、API Key（password input，回显 `********`）、上限、代理同步 checkbox、两个自动上传 checkbox、保存/测试按钮 + Terminal 日志。
  - `enforceExclusive` 扩为三方：任一侧勾 auto → 其余两侧勾选清零并 pin。
- `AccountsView.tsx`：操作栏加「sub2api 导入」按钮，`uploadSelectedSub2api` 照抄 `uploadSelectedCpa`（选中 emails → POST upload → OperationDialog 展示 uploaded/failed/skipped + 逐条错误）。

### 错误处理

- sub2api 不可达 / 401（key 错）/ `code!=0`：`RuntimeError` 带截断响应体，端点层转 HTTP 400，前端 toast + 日志展示。
- 单块上传失败（网络/5xx）：该块所有 email 记入 failed（`error` 为异常消息），继续下一块——不让一块失败废掉整批。
- 代理创建失败：warning 降级直连上传，结果 `results` 里标注 `proxy_fallback: true`。
- 无 sso 的账号：跳过并计入 `skipped_accounts`（reason「本地无 SSO」）。

### 测试（tests/）

store 层单测（HTTP mock `_urlopen`）：
- `normalize_sub2api_config` 归一化 / key 掩码保留旧值
- 三方 `get_remote_backend` 推断与 `set_remote_backend` 互斥清理
- proxy_url 解析（socks5/http/带认证/非法值）与查重匹配
- 分组分块逻辑 + index→email 映射（含 failed 交错）
- 块级失败不影响后续块；`mark_local_remote_imported` 只标成功者
