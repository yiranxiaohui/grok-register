# 账号代理携带进 CPA — 设计文档

日期：2026-07-17
状态：已通过设计评审，待写实现计划

## 背景

grok-register 注册账号时，用注册表单里配置的**代理池**（round-robin / random / sticky）为每个注册 job 挑一个具体代理。注册完成后，账号凭证（access_token / refresh_token 等）会导入到远端后端（Grok2API 或 CPA，二者互斥）。

当前实现中，代理只是注册那一刻的"过路"通道：

- 代理不按账号存储 —— `accounts` 表没有代理列。
- 导入 CPA 的 `cpa_auth_json`（由 `_build_auth_payloads` 组装）没有任何代理字段。

结果：账号导入 CPA 后不携带代理，CPA 运行该账号时只能用 CPA 自己配置的代理或直连，无法保持账号注册时的出口。

## 目标

让每个账号把**注册时实际使用的那个具体代理**带进 CPA 的 auth 文件，使 CPA 运行、以及后续续期 token 时，该账号都走同一出口 IP。

### 非目标（YAGNI）

- 不改 CPA（CLIProxyAPI）任何代码。
- 不为 Grok2API 后端做同样的携带（Grok2API 导入文档格式不同，且用户需求明确指向 CPA）。
- 不回填改动前已存在的老账号（注册时没记录过代理，无从追溯）。
- 不加 UI 开关（携带代理是本功能的全部目的，空代理时优雅回退，无需开关）。

## 关键事实：CPA 已原生支持账号级代理

对 `D:\Projects\CLIProxyAPI`（module `github.com/router-for-me/CLIProxyAPI/v7`）核实：

- **字段名**：auth 文件**顶层** `proxy_url`（snake_case，字符串）。
- **结构体**：`sdk/cliproxy/auth/types.go:70-71` — `ProxyURL string json:"proxy_url,omitempty"`，注释 "ProxyURL overrides the global proxy setting for this auth if provided."
- **加载路径**：`internal/watcher/synthesizer/file.go:146-149,182` — 整个 auth JSON 反序列化为 `map[string]any`，读 `metadata["proxy_url"]` 赋给 `Auth.ProxyURL`。因为是 `map[string]any` 全量加载，额外字段原样保留。
- **消费路径**：`internal/runtime/executor/helps/proxy_helpers.go:28-62` 的 `NewProxyAwareHTTPClient`，优先级为 **账号级 `auth.ProxyURL` > 全局 `cfg.ProxyURL` > context**。xAI executor 每次请求都调用它（`xai_executor.go:117,152,244,485,550,606`）。
- **续期也走账号级代理**：`internal/auth/xai/xai.go:33-43`，`NewXAIAuthWithProxyURL` 在账号级值为空时回退全局。
- **上传端点** `/v0/management/auth-files`（`internal/api/handlers/management/auth_files.go`）：接受 multipart 或 raw JSON，只校验 `.json` 扩展名 + 文件名安全 + 合法 JSON，**原样落盘不裁剪 schema**。额外的 `proxy_url` 字段完整保留。
- **代理串格式**：`proxyutil.Parse` 支持 `http / https / socks5 / socks5h`，以及哨兵值 `direct` / `none` 显式绕过代理。

**因此 CPA 侧零改动。** 只要 grok-register 在导入 CPA 的 JSON 顶层写入 `proxy_url`，CPA 就会把它作为该账号的专属代理。空值时省略该字段，CPA 自动回退它自己的全局代理。

## 设计决策（已与用户确认）

1. **存储方式：`accounts` 表新增 `proxy_url` 列。** 该列是单一真相源 —— 持久、重登不丢、可查询/可修改。
2. **重登行为：保持注册时的代理。** 账号终生绑定注册时那个代理；relogin 不改。

## 数据流

```
注册 job 按策略从池里选定 job_proxy
  └─ sess["proxy"]                       grok_build_adapter.py:1334（已存在）
       └─ import_auth_payload payload 加 "proxy_url"   grok_build_adapter.py:2942
            └─ accounts.proxy_url 列（新增，单一真相源）
                 └─ 导出/上传 CPA 时，_auth_parts(cpa=True) 把列值注入 JSON 顶层 proxy_url
                      └─ POST /v0/management/auth-files（CPA 原样落盘并生效）
```

## 改动清单（grok-register 侧，4 处）

### 1. 建表加列
文件：`src/register_lite_store.py`，函数 `_ensure_account_columns`（约 :1453）。
按现有 `grok2api_auth_json` / `cpa_auth_json` 的同款模式，检测列不存在时执行：
```sql
ALTER TABLE accounts ADD COLUMN proxy_url TEXT
```

### 2. 注册时捕获
文件：`src/grok_build_adapter.py`，`accounts.import_auth_payload({...})` 调用处（约 :2942）。
在 payload 字典里增加一项：
```python
"proxy_url": sess.get("proxy") or "",
```
`sess["proxy"]` 即该注册 job 实际使用的具体代理（`_prepare_registration_session` 在 :1334 已存入），无需额外抓取。

### 3. 落库 + 重登保持
文件：`src/register_lite_store.py`，函数 `import_auth_payload`（约 :4615）。
- 读取 `parsed.get("proxy_url")`，写入新的 `proxy_url` 列。
- INSERT 语句的列清单与 VALUES 增加 `proxy_url`。
- `ON CONFLICT(email) DO UPDATE` 中，对 `proxy_url` 采用与 `password` 相同的"非空才覆盖、否则保留旧值"模式：
  ```sql
  proxy_url = CASE
    WHEN excluded.proxy_url != '' THEN excluded.proxy_url
    ELSE accounts.proxy_url
  END
  ```
  这样 relogin/重导入若传入空代理，会保留注册时已存的代理 —— 实现"重登保持注册时的代理"。

### 4. 导出/上传时注入（单一注入点）
文件：`src/register_lite_store.py`，函数 `_auth_parts`（约 :3604）。
- SELECT 增加 `proxy_url` 列。
- 仅在 `cpa=True` 分支：当该行 `proxy_url` 非空时，把 JSON 解析出来、在顶层加 `proxy_url`、再序列化。
- 对 json 内容分支和 file-path fallback 分支都注入。
- grok2api 分支（`cpa=False`）完全不受影响。

该单一注入点同时覆盖所有出 CPA 的路径：手动导入（`upload_cpa_auth_files`）、注册后自动导入、导出 zip（`export-cpa-zip`）、materialize 文件（`materialize_auth_export_files`）—— 它们全部经过 `list_cpa_auth_parts` → `_auth_parts`。

`cpa_auth_json` 本身保持"纯凭证"不含代理；`_build_auth_payloads` 不改。代理作为部署项在 emit 时贴上，使 `proxy_url` 列成为唯一真相源，改列后无需重建已存的 `cpa_auth_json`。

## 边界情况

- **代理为空（proxyless 注册）**：`proxy_url` 列为空 → 注入时省略该字段 → CPA 回退自己的全局代理。不写 `"direct"`（除非未来需要强制某账号绝不走代理）。
- **改动前的老账号**：列为空，行为同上；无法回填。仅对改动后新注册的账号生效。
- **代理串含内联账密**：`http://user:pass@host:port` 形式与 CPA `proxyutil.Parse` 兼容；明文存储与 DB 已有的 token/password 同级别，无新增泄露面。
- **Grok2API 后端**：不携带代理（非目标）；`_auth_parts(cpa=False)` 分支不注入。

## 测试

### 单元测试
- `_auth_parts(cpa=True)`：对「proxy_url 列有值」的账号，断言输出 JSON 顶层含正确 `proxy_url`；对「列为空」的账号，断言输出**不含** `proxy_url` 键。
- `_auth_parts(cpa=False)`（grok2api）：断言输出永远不含 `proxy_url`。
- `import_auth_payload`：
  - 新账号带 `proxy_url` → 列被写入。
  - 已存账号、重导入传入空 `proxy_url` → 列值保留不被清空。

### 端到端
1. 配好代理池，注册 1 个账号。
2. 查 `accounts.proxy_url` 有值且等于该 job 实际用的代理。
3. 导出 CPA zip，确认文件顶层 `proxy_url` 正确。
4. （可选，需真实 CPA）上传到 CPA，确认 auth 文件生效、该账号请求走对应出口。

## 影响面

- 改动全部集中在 grok-register 的 2 个文件（`register_lite_store.py`、`grok_build_adapter.py`）。
- 新增一列，走已有的 `_ensure_account_columns` 迁移机制，向后兼容。
- CPA 项目零改动。
