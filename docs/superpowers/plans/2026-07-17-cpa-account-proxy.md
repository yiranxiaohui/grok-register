# 账号代理携带进 CPA 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让注册时每个账号实际使用的代理落到 `accounts.proxy_url` 列，并在导出/上传 CPA 时注入 auth JSON 顶层 `proxy_url`，使 CPA 运行该账号时走同一出口。

**Architecture:** 单一真相源是新增的 `accounts.proxy_url` 列。注册流程把 `sess["proxy"]` 透传进 `import_auth_payload` 写入该列；重登时非空才覆盖（保留注册时的代理）。导出/上传全部经过 `_auth_parts`，在 `cpa=True` 分支把列值注入 CPA JSON 顶层。CPA（CLIProxyAPI）已原生支持顶层 `proxy_url`，零改动。

**Tech Stack:** Python 3（FastAPI 后端）、SQLite（stdlib `sqlite3`）。测试为 stdlib `assert` 脚本，在运行中的容器内用 `python` 执行（镜像无 pytest）。

## Global Constraints

- 改动仅限 grok-register 的 2 个文件：`src/register_lite_store.py`、`src/grok_build_adapter.py`。CPA 项目零改动。
- 新增列走已有 `_ensure_account_columns` 迁移机制（`PRAGMA table_info` 检测 + `ALTER TABLE ADD COLUMN`），向后兼容。
- `cpa_auth_json` 本身保持"纯凭证"，不含代理；`_build_auth_payloads` 不改。代理在 emit 时注入。
- grok2api 分支（`_auth_parts(cpa=False)`）永远不注入 `proxy_url`。
- 空代理时省略 `proxy_url` 字段（不写 `"direct"`），让 CPA 回退全局代理。
- 重登/重导入传入空代理时，保留已存列值（复用现有 `password` 的 `CASE WHEN excluded != '' THEN … ELSE accounts.…` 模式）。
- 宿主机无 Python。所有测试命令通过 `docker compose exec -T register-lite ...` 在容器内运行，工作目录为容器内 `/app`（源码所在）。测试用临时 DB（`GROK_REGISTER_LITE_DB` 指向 `/tmp/xxx.sqlite3`）隔离，绝不碰生产库 `/data/register_lite.sqlite3`。

---

## File Structure

- `src/register_lite_store.py`（Modify）
  - `_ensure_account_columns`（约 :1453）— 加 `proxy_url` 列
  - `_auth_parts`（约 :3604）— SELECT 带上 `proxy_url`，`cpa=True` 时注入 JSON 顶层
  - `import_auth_payload`（约 :4615）— 读 `parsed["proxy_url"]`，写列，重登保留
- `src/grok_build_adapter.py`（Modify）
  - `import_auth_payload` 调用处（约 :2942）— payload 加 `"proxy_url": sess.get("proxy") or ""`
- `src/tests/test_cpa_proxy.py`（Create）— stdlib assert 测试脚本

---

## Task 1: 数据库加列 + 落库/重登保留 + payload 捕获

把持久化链路一次做通：加列、落库写列、重登保留、注册时捕获。这些改动互相依赖（列不存在则写列会报错），且共享同一个测试脚本，属于同一个可独立测试的交付单元。

**Files:**
- Modify: `src/register_lite_store.py`（`_ensure_account_columns` 约 :1453；`import_auth_payload` 约 :4615）
- Modify: `src/grok_build_adapter.py`（`accounts.import_auth_payload({...})` 调用处 约 :2942）
- Create: `src/tests/test_cpa_proxy.py`

**Interfaces:**
- Produces: `accounts.proxy_url TEXT` 列；`import_auth_payload(raw)` 现在读取 `raw["proxy_url"]`（字符串，可缺省）并写入该列，重导入空值时保留旧值。
- Consumes: `grok_build_adapter` 侧从 `sess["proxy"]`（`str | None`，`grok_build_adapter.py:1334` 已存入）取该账号注册时的具体代理。

- [ ] **Step 1: 写失败测试**

创建 `src/tests/test_cpa_proxy.py`：

```python
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
```

- [ ] **Step 2: 运行测试，确认失败**

Run:
```bash
docker compose exec -T register-lite python tests/test_cpa_proxy.py
```
Expected: FAIL — `sqlite3.OperationalError: no such column: proxy_url`（列还没加）。

- [ ] **Step 3: 加列**

在 `src/register_lite_store.py` 的 `_ensure_account_columns`（:1453）里，在 `cpa_auth_json` 那个 if 块之后加：

```python
    if "proxy_url" not in columns:
        conn.execute("ALTER TABLE accounts ADD COLUMN proxy_url TEXT")
```

- [ ] **Step 4: 落库写列 + 重登保留**

在 `src/register_lite_store.py` 的 `import_auth_payload`（:4615）里：

4a. 在解析 `sso`/`auth_key` 附近（约 :4652，`sso = str(parsed.get("sso") or "")` 之后）加：

```python
    proxy_url = str(parsed.get("proxy_url") or "").strip()
```

4b. INSERT 语句（:4669）的列清单末尾、`raw_json` 之前加 `proxy_url`：

```python
            INSERT INTO accounts(
              email, password, sso, auth_key, user_id, access_token, refresh_token, id_token,
              expires_at, oidc_issuer, oidc_client_id, grok2api_auth_path, cpa_auth_path,
              grok2api_auth_json, cpa_auth_json, status, batch_id, session_id, proxy_url,
              created_at, updated_at, raw_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

（注意：原来 21 个占位符 → 22 个，`proxy_url` 插在 `session_id` 之后、`created_at` 之前。）

4c. `ON CONFLICT ... DO UPDATE SET` 块里（在 `session_id = excluded.session_id,` 之后）加保留逻辑：

```python
              proxy_url = CASE
                WHEN excluded.proxy_url != '' THEN excluded.proxy_url
                ELSE accounts.proxy_url
              END,
```

4d. VALUES 元组（:4697-4719）里，在 `str(parsed.get("session_id") or ""),` 之后、`created_at,` 之前插入 `proxy_url,`：

```python
                str(parsed.get("session_id") or ""),
                proxy_url,
                created_at,
                now,
                auth_json,
```

- [ ] **Step 5: 运行测试，确认通过**

Run:
```bash
docker compose exec -T register-lite python tests/test_cpa_proxy.py
```
Expected: `TASK1 OK`

- [ ] **Step 6: 注册时捕获代理**

在 `src/grok_build_adapter.py` 的 `accounts.import_auth_payload({...})` 调用处（:2942），在 payload 字典里 `"session_id": sid,` 之后加一行：

```python
                "session_id": sid,
                "proxy_url": sess.get("proxy") or "",
```

这一步无独立单测（依赖真实注册会话），由 Task 3 端到端覆盖。改动是纯透传，与 Step 4 已测的 `import_auth_payload` 契约一致。

- [ ] **Step 7: Commit**

```bash
git add src/register_lite_store.py src/grok_build_adapter.py src/tests/test_cpa_proxy.py
git commit -m "feat: 账号注册代理落库到 accounts.proxy_url（重登保留）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 导出/上传 CPA 时注入 proxy_url

在 `_auth_parts` 的 `cpa=True` 分支，把 `proxy_url` 列值注入每个 CPA auth JSON 的顶层。这是所有出 CPA 路径（手动导入、自动导入、导出 zip、materialize）的单一注入点。

**Files:**
- Modify: `src/register_lite_store.py`（`_auth_parts` 约 :3604-3650）
- Modify: `src/tests/test_cpa_proxy.py`（追加测试）

**Interfaces:**
- Consumes: Task 1 的 `accounts.proxy_url` 列；`_auth_parts(cpa=bool, json_column, path_column, emails, limit)`。
- Produces: `_auth_parts(cpa=True)` 输出的每个 payload，当账号 `proxy_url` 非空时，JSON 顶层含 `proxy_url` 键；`cpa=False` 永不含。

- [ ] **Step 1: 追加失败测试**

在 `src/tests/test_cpa_proxy.py` 里，`if __name__` 之前追加：

```python
def _has_top_level_proxy(parts, filename_contains):
    for name, payload in parts:
        if filename_contains in name:
            doc = json.loads(payload.decode("utf-8"))
            return doc.get("proxy_url")
    return "___not_found___"

def test_cpa_parts_inject_proxy_url():
    store.init_db()
    email = "d@example.com"
    store.import_auth_payload(_payload(email, "http://10.0.0.9:3128"))
    parts = store.list_cpa_auth_parts(emails=[email])
    got = _has_top_level_proxy(parts, "d")
    assert got == "http://10.0.0.9:3128", got

def test_cpa_parts_omit_empty_proxy():
    store.init_db()
    email = "e@example.com"
    p = _payload(email, "")
    del p["proxy_url"]
    store.import_auth_payload(p)
    parts = store.list_cpa_auth_parts(emails=[email])
    got = _has_top_level_proxy(parts, "e")
    # 空代理时不应有 proxy_url 键（get 返回 None）
    assert got is None, got

def test_grok2api_parts_never_inject_proxy():
    store.init_db()
    email = "f@example.com"
    store.import_auth_payload(_payload(email, "http://10.0.0.9:3128"))
    parts = store.list_grok2api_auth_parts(emails=[email])
    got = _has_top_level_proxy(parts, "f")
    # grok2api 文档不应含 proxy_url
    assert got is None, got
```

并把 `__main__` 块替换为：

```python
if __name__ == "__main__":
    test_import_writes_proxy_url_column()
    test_reimport_empty_proxy_preserves_existing()
    test_import_no_proxy_field_is_empty()
    test_cpa_parts_inject_proxy_url()
    test_cpa_parts_omit_empty_proxy()
    test_grok2api_parts_never_inject_proxy()
    print("ALL OK")
```

- [ ] **Step 2: 运行测试，确认新测试失败**

Run:
```bash
docker compose exec -T register-lite python tests/test_cpa_proxy.py
```
Expected: FAIL 于 `test_cpa_parts_inject_proxy_url`（`got` 是 `None`，因为还没注入），断言信息 `AssertionError: None`。

- [ ] **Step 3: 实现注入**

在 `src/register_lite_store.py` 的 `_auth_parts`（:3604）：

3a. 修改 SELECT，带上 `proxy_url`（:3621-3630 那条 SQL）：

```python
        rows = conn.execute(
            f"""
            SELECT email, {json_column} AS auth_json, {path_column} AS auth_path, proxy_url
            FROM accounts
            WHERE {' AND '.join('(' + clause + ')' for clause in where)}
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            [*args, limit],
        ).fetchall()
```

3b. 修改循环体（:3634-3649），仅在 `cpa` 且列非空时注入。把原来的：

```python
    for row in rows:
        email = str(row["email"] or "")
        filename = _auth_part_filename(email, cpa=cpa)
        if filename in seen:
            continue
        content = str(row["auth_json"] or "").strip()
        if content:
            payload = json.dumps(json.loads(content), ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
        else:
            path = Path(str(row["auth_path"] or ""))
            if not path.is_file():
                continue
            payload = path.read_bytes()
            filename = path.name or filename
        seen.add(filename)
        parts.append((filename, payload))
```

替换为：

```python
    for row in rows:
        email = str(row["email"] or "")
        filename = _auth_part_filename(email, cpa=cpa)
        if filename in seen:
            continue
        proxy_url = str(row["proxy_url"] or "").strip() if cpa else ""
        content = str(row["auth_json"] or "").strip()
        if content:
            doc = json.loads(content)
            if proxy_url and isinstance(doc, dict):
                doc["proxy_url"] = proxy_url
            payload = json.dumps(doc, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
        else:
            path = Path(str(row["auth_path"] or ""))
            if not path.is_file():
                continue
            raw = path.read_bytes()
            if proxy_url:
                try:
                    doc = json.loads(raw.decode("utf-8"))
                    if isinstance(doc, dict):
                        doc["proxy_url"] = proxy_url
                        raw = json.dumps(doc, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
                except (ValueError, UnicodeDecodeError):
                    pass  # 非 JSON 文件原样上传
            payload = raw
            filename = path.name or filename
        seen.add(filename)
        parts.append((filename, payload))
```

- [ ] **Step 4: 运行测试，确认全部通过**

Run:
```bash
docker compose exec -T register-lite python tests/test_cpa_proxy.py
```
Expected: `ALL OK`

- [ ] **Step 5: Commit**

```bash
git add src/register_lite_store.py src/tests/test_cpa_proxy.py
git commit -m "feat: 导出/上传 CPA 时注入账号级 proxy_url

_auth_parts(cpa=True) 把 accounts.proxy_url 注入 CPA auth JSON 顶层；
grok2api 分支不受影响。单一注入点覆盖手动/自动导入、导出 zip、materialize。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 端到端验证（真实注册 → 导出确认）

用真实注册流程验证代理从注册一路带到 CPA 导出文件。这一步不写自动化测试，是操作性验收，确认 Task 1 Step 6 的透传在真实会话下工作。

**Files:** 无（纯验证）

- [ ] **Step 1: 重建容器加载新代码**

新代码在 `src/` 里，需要进镜像/容器。按项目部署方式（构建自定义镜像 `FROM ... + COPY 覆盖`）重建：

```bash
docker compose up -d --build
```

若项目用预构建镜像而非本地构建，则改为重新构建并推送镜像后 `docker compose pull && docker compose up -d`。确认容器 healthy：

```bash
docker compose ps
```

- [ ] **Step 2: 配好代理池并注册 1 个账号**

在后台管理页配置注册代理池（至少 1 个代理），触发注册 1 个账号。等待其状态变为 active/registered。

- [ ] **Step 3: 确认列已写入**

Run（查生产库，只读）：
```bash
docker compose exec -T register-lite python -c "import register_lite_store as s; \
c=s._connect(); \
rows=c.execute('SELECT email, proxy_url FROM accounts ORDER BY updated_at DESC LIMIT 3').fetchall(); \
[print(r['email'], '->', r['proxy_url']) for r in rows]"
```
Expected: 最新注册的账号 `proxy_url` 为你配置的代理串（非空）。

- [ ] **Step 4: 确认 CPA 导出文件含 proxy_url**

Run：
```bash
docker compose exec -T register-lite python -c "import register_lite_store as s, json; \
parts=s.list_cpa_auth_parts(limit=3); \
[print(name, '->', json.loads(p.decode()).get('proxy_url')) for name,p in parts]"
```
Expected: 最新账号对应的 CPA JSON 顶层 `proxy_url` 等于 Step 3 的代理串。

- [ ] **Step 5:（可选，需真实 CPA）上传验证**

在后台把该账号导入 CPA（或用 CPA 配置的自动导入），到 CPA 的 `auths/` 目录确认落盘的 `xai-<email>.json` 顶层含 `proxy_url`，且该账号请求走对应出口 IP。

- [ ] **Step 6: 更新 memory**

在 `C:\Users\xiaohui\.claude\projects\d--Projects-grok-register\memory\` 记录本功能：accounts 新增 `proxy_url` 列，注册代理携带进 CPA 的链路（注入点在 `_auth_parts(cpa=True)`），并在 MEMORY.md 加索引行。

---

## Self-Review

**Spec coverage:**
- 加列 → Task 1 Step 3 ✓
- 注册捕获 → Task 1 Step 6 ✓
- 落库 + 重登保留 → Task 1 Step 4 + 测试 ✓
- 导出/上传注入（单一点）→ Task 2 ✓
- 空代理省略字段 → Task 2 `test_cpa_parts_omit_empty_proxy` ✓
- grok2api 不受影响 → Task 2 `test_grok2api_parts_never_inject_proxy` ✓
- 边界（老账号、含账密、格式）→ 由列为空的回退路径 + Task 3 端到端覆盖 ✓
- 测试（单元 + 端到端）→ Task 1/2 单元 + Task 3 端到端 ✓

**Placeholder scan:** 无 TBD/TODO；每个代码步都是完整可粘贴代码；测试含真实断言。

**Type consistency:** `proxy_url` 全程为 `str`；`import_auth_payload` 读 `parsed["proxy_url"]`；`_auth_parts` 读 `row["proxy_url"]`；`grok_build_adapter` 传 `sess.get("proxy")`。列名 `proxy_url` 各处一致。占位符计数：INSERT 22 列 / 22 `?` / 22 值，已核对（原 21 → 加 1）。
