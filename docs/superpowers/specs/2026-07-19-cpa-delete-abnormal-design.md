# 删除 CPA 异常账号（手动 + 自动） — 设计文档

日期：2026-07-19
状态：已通过设计评审，待写实现计划

## 背景

grok-register 对接远端后端 CPA（CLIProxyAPI，management API 前缀 `/v0/management/`）：注册后把账号 auth JSON 导入 CPA，并可通过 grok-inspection 插件拉取每个账号在 CPA 上的运行状态（分类为 healthy / reauth / quota_exhausted / permission_denied / … 落到本地 `remote_accounts` 表）。

当前系统的"删除账号"（`DELETE /api/accounts` → `lite_store.delete_accounts`）**只删本地 `accounts` 表记录**，不会去 CPA 删除远端那份 auth。也就是说：当某个账号在 CPA 上变成异常（如 `subscription:free-usage-exhausted` 额度用尽 = 429、需重登 = 401、权限拒绝 = 403），运维无法从本系统一键把它从 CPA 池子里删掉——远端那份坏 auth 会一直挂着。

## 目标

新增"删除 CPA 异常账号"能力，覆盖手动与自动两条路径：

- **手动**：账号列表页新增独立按钮，对选中账号中处于异常状态的那些，执行"删 CPA 远端 auth + 删本地记录"。
- **自动**：调度器每轮先拉取 CPA 最新异常状态，再自动删除异常账号；由开关控制，默认关闭。
- **可删的异常状态**：`reauth`(401)、`quota_exhausted`(429)、`permission_denied`(403)。
- **严格联动**：CPA 远端删成功才删本地；远端删失败则本地保留并逐条报告。

### 非目标（YAGNI）

- 不改 CPA（CLIProxyAPI）任何代码——删除走其已有的 management 接口。
- 不对 Grok2API 后端做同样的删除（需求明确指向 CPA；两后端互斥）。
- 不做"只删远端不删本地"或"删远端+仅标记本地"的变体——已明确选定"删远端+删本地"。
- 自动删除不引入新定时器，跟随现有调度 tick；也不做"自动只删部分状态"的分裂逻辑（自动/手动可删状态一致）。

## 关键事实：CPA 删除接口（已核实）

对 CLIProxyAPI（`router-for-me/CLIProxyAPI`，module `/v7`）核实：

- **删除端点**：`DELETE /v0/management/auth-files?name=<file_name.json>`
  - **query 参数形式，不是 path 参数**（不是 `/auth-files/{name}`）。
  - 参数是 auth 文件名（`.json` 结尾），不是 id。
  - 认证头：`Authorization: Bearer <management_key>`（与现有上传一致）。
  - 路由注册证据：`internal/api/server.go` `registerManagementRoutes()` 中 `mgmt.DELETE("/auth-files", s.mgmt.DeleteAuthFile)`；handler `DeleteAuthFile` 用 `c.QueryArray("name")` 读取；测试 `auth_files_delete_test.go` 用 `NewRequest(MethodDelete, "/v0/management/auth-files?name="+QueryEscape(fileName))` 证实 query 形式。
- **响应**：单文件成功 `200 {"status":"ok"}`；文件不存在 `404 {"error":"file not found"}`（幂等友好）；非法名 `400`；密钥错 `401`；远端禁用 `403`；内部错误 `500`。
- **定位键**：grok-inspection 结果条目里唯一能定位 CPA auth 文件、且删除接口接受的字段是 **`file_name`**（`accountResult.FileName`，`json:"file_name"`）。**`auth_index` 不是删除接口接受的键**。

证据来源：CLIProxyAPI `internal/api/server.go` / `internal/api/handlers/management/auth_files.go` / `auth_files_delete_test.go`；grok-inspection 插件 `engine.go`(`accountResult`)、`apply.go`(`deleteAuthFile` → `/v0/management/auth-files?name=` + `QueryEscape(fileName)`)。

## 现状关键点（本项目侧）

- 上传辅助 `_upload_cpa_auth_part`（`register_lite_store.py:3970`）已用 `POST /v0/management/auth-files`，可作为删除辅助的对称参照。
- 管理头 `_cpa_management_headers`（`:4017`）提供 Bearer 头，可复用。
- HTTP 走项目封装的 `_urlopen`（带 SSRF 防护/代理）。
- `sync_cpa_remote_status`（`:4093`）拉取 grok-inspection 结果，写入 `remote_accounts` 时 `classified_rows.append({**row, **classified})`（`:4134`）——**原始 `row` 含 `file_name`，会进 `raw_json`**。因此删除时可从 `remote_accounts.raw_json` 反查 `file_name`。
- ⚠️ `remote_accounts.remote_id`：在 `_write_remote_rows` 的预分类分支（`:3127`）优先取 `auth_index`，**不是** `file_name`。所以删除定位**必须从 `raw_json` 取 `file_name`**，不能用 `remote_id`。
- 本地删除 `delete_accounts(emails, backup=True)`（`:5723`）已带备份，复用。
- ⚠️ 调度线程 `_schedule_loop`（`register_lite_app.py:742`）每 tick 只调 `evaluate_schedule_tick`，后者**只做注册批次启停，不拉 CPA 远端状态**。因此"自动删除跟随调度周期"需要在 tick 里**新增**"拉 CPA 异常 → 删"两步，不是复用已有步骤。

## 详细设计

### 组件 1：CPA 删除 HTTP 层 `_delete_cpa_auth_file_by_name`

`register_lite_store.py` 新增，与 `_upload_cpa_auth_part` 对称：

```python
def _delete_cpa_auth_file_by_name(file_name, cfg, *, timeout=30.0) -> dict:
    endpoint = cfg["base_url"].rstrip("/") + "/v0/management/auth-files?" \
               + urllib.parse.urlencode({"name": file_name})
    req = urllib.request.Request(endpoint, headers=_cpa_management_headers(cfg), method="DELETE")
    # _urlopen；捕获 HTTPError 取 code/body
    # 2xx → {"ok": True, "status": <s>, "name": file_name}
    # 404 → {"ok": True, "status": 404, "name": file_name, "note": "远端本就不存在"}
    # 其它 → {"ok": False, "status": <s>, "name": file_name, "error": body[:300]}
```

- 只删一个；批量在上层循环（逐条才能满足严格联动 + 逐条报告）。
- 复用 `_urlopen`、`_cpa_management_headers`，不引入新 HTTP 栈。

### 组件 2：核心编排 `delete_cpa_abnormal(emails)`（手动/自动共用）

`register_lite_store.py` 新增。可删状态集合：`{"reauth", "quota_exhausted", "permission_denied"}`。

```
校验 emails 非空（空 → {"ok": False, "deleted": 0, "error": "未选择账号"}）
读 CPA 配置（不完整 → 报错返回）
对每个 email:
  1. 查 remote_accounts(provider='cpa') 该 email 的 classification + raw_json
  2. classification ∉ 可删集合 → skipped.append({email, reason})，continue
  3. file_name = raw_json.file_name  或回退 _auth_part_filename(email, cpa=True)（xai-<email>.json）
  4. r = _delete_cpa_auth_file_by_name(file_name, cfg)
     - r.ok（含 404）→ deletable_emails.append(email)
     - else → failed.append({email, file_name, status, error})
若 deletable_emails 非空:
  delete_accounts(deletable_emails, backup=True)   # 一次性删本地 + 备份
返回 {ok, deleted, skipped, failed, backup_path, requested}
```

严格联动：只有远端删成功（含 404 幂等）的 email 才进本地删除列表。

### 组件 3：辅助 `_abnormal_emails_from_remote()`

`register_lite_store.py` 新增。从 `remote_accounts`(provider='cpa') 查 classification 属于可删集合的 email 列表，供自动删除使用（先 `sync_cpa_remote_status` 刷新，再查表）。

### 组件 4：手动入口（后端路由 + 前端按钮）

**后端**（`register_lite_app.py`，CPA 路由组附近）：

```python
class DeleteCpaAbnormalBody(BaseModel):
    emails: list[str] | None = None

@app.post(_admin_path('api', 'cpa', 'delete-abnormal'))
async def delete_cpa_abnormal(body: DeleteCpaAbnormalBody):
    try:
        return await asyncio.to_thread(lite_store.delete_cpa_abnormal, _clean_emails(body.emails))
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
```

用 POST + body（与现有 `cpa/upload` 一致），不用 DELETE 方法，保持 CPA 操作路由风格统一。

**前端**（`web/src/pages/AccountsView.tsx`）：新增 `deleteCpaAbnormalSelected`，`confirm` 提示"只处理异常状态（需重登/额度用尽/权限拒绝），健康账号跳过，删除前自动备份"，POST `api/cpa/delete-abnormal`，结果 badge 展示 `成功/跳过/失败` 计数，`refresh()`。按钮放在"删除选中"旁边，`danger` 样式，文案"删除 CPA 异常"。

### 组件 5：自动删除（调度 tick + 开关）

**开关**：`DEFAULT_CPA_CONFIG`（`:142`）新增 `auto_delete_abnormal: False`（默认关）与 `auto_delete_min_interval_sec: 300`（限流）；`normalize_cpa_config`（`:2125`）归一化 bool / int。

**调度 tick**：`evaluate_schedule_tick` 在注册批次逻辑之后新增独立小节，整段 `try` 包裹（任何失败只 append action，不影响注册主流程）：

```python
if _cpa_auto_delete_enabled():                 # 开关开 + CPA 配置完整
    if now - last_auto_delete_at >= min_interval:   # 限流
        try:
            sync_cpa_remote_status(mode="problems")     # ① 拉最新异常
            emails = _abnormal_emails_from_remote()      # ② 取异常 email
            if emails:
                res = delete_cpa_abnormal(emails)        # ③ 严格联动删（共用函数）
                actions.append({"type": "cpa_auto_delete", "deleted": res.get("deleted"), ...})
            set_schedule_runtime({"last_cpa_auto_delete_at": now})
        except Exception as exc:
            actions.append({"type": "cpa_auto_delete_error", "error": str(exc)[:200]})
```

- 每轮先拉后删：保证删的是"此刻真异常"的账号，避免删到 quota 已恢复的。
- 限流：`last_cpa_auto_delete_at` 存进 schedule runtime，距上次 ≥ `auto_delete_min_interval_sec`（默认 300s）才跑。
- 开关关闭时整段不执行，零开销。

**前端开关**（`web/src/components/settings/RemoteCards.tsx`）：CPA 配置卡片加勾选框"自动删除异常账号（需重登/额度用尽/权限拒绝）"，带风险提示；`types.ts` CPA 配置类型加字段。

## 错误处理与边界

| 情况 | 处理 |
|---|---|
| 选中账号无异常记录 / classification=healthy | skipped，不碰 CPA |
| raw_json 无 file_name | 回退 `_auth_part_filename(email, cpa=True)`（`xai-<email>.json`） |
| CPA 返回 404（远端本就没有） | 当成功，继续删本地（幂等） |
| CPA 返回 401/403 | failed，本地保留，附错误 |
| CPA 返回 5xx / 网络超时 | failed，本地保留 |
| CPA 配置不完整 | 手动：报错返回；自动：开关判 False，整段跳过 |
| emails 为空 | `{ok:False, error:"未选择账号"}`（与 `delete_accounts` 一致） |
| 本地删除备份 | 复用 `delete_accounts` 的备份，不重复实现 |

## 测试（新增 `src/tests/test_cpa_delete.py`）

- `_delete_cpa_auth_file_by_name`：2xx→ok、404→ok(幂等)、401→fail、500→fail（mock `_urlopen`）。
- `delete_cpa_abnormal`：
  - healthy 账号被跳过（不调 CPA）。
  - reauth / quota_exhausted / permission_denied 三种都触发删除。
  - file_name 从 raw_json 正确取出；缺失时回退推导。
  - CPA 删成功 → 本地被删；CPA 删失败 → 本地保留（严格联动）。
  - 混合批次：成功/跳过/失败分别归类正确。
- 自动删除：`auto_delete_abnormal=False` 时 tick 不执行；开启但未到最小间隔时跳过。

## 改动文件

- `src/register_lite_store.py` — `_delete_cpa_auth_file_by_name`、`delete_cpa_abnormal`、`_abnormal_emails_from_remote`、`DEFAULT_CPA_CONFIG`/`normalize_cpa_config` 加开关字段、`evaluate_schedule_tick` 加自动删除小节。
- `src/register_lite_app.py` — `DeleteCpaAbnormalBody` + `POST /api/cpa/delete-abnormal`。
- `web/src/pages/AccountsView.tsx` — 删除函数 + 按钮。
- `web/src/components/settings/RemoteCards.tsx` — 自动删除开关。
- `web/src/lib/types.ts` — CPA 配置类型加字段（若有）。
- 前端重新 build → `src/static/admin/assets/`（注意 `__ADMIN_BASE__` 注入约束）。
- `src/tests/test_cpa_delete.py` — 新增测试。
