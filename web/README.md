# grok-register-web

Grok 注册机后台的 React 前端。由原来的单文件 `accounts.html`（内联 CSS + 原生 JS）还原为
React 19 + Vite + TypeScript 工程。

## 与后端的关系

后端是 `../src` 里的 FastAPI（`register_lite_app.py`）。它在 `GET /admin` / `GET /admin/accounts`
返回 `src/static/admin/accounts.html`，并把其中一行
`window.__ADMIN_BASE__ = window.__ADMIN_BASE__ || "/admin";`
字符串替换成实际的管理路径；`/static` 挂载到 `src/static/`。

因此本工程的构建产物**直接输出到 `../src/static/admin/`**：

- 入口 HTML 命名为 `accounts.html`（见 `vite.config.ts` 的 `rollupOptions.input`），覆盖旧文件。
- `base: "/static/admin/"`，assets 通过 `/static/admin/assets/...` 加载，页面挂在哪个管理路径都能取到。
- `index.html` 顶部保留那行 `__ADMIN_BASE__` 内联脚本，后端的替换才继续生效；同时保留主题 FOUC 预防脚本。
- `emptyOutDir: false`，避免删掉后端一起服务的 `grok-icon.png / *.svg`；构建前由 `scripts/clean-assets.mjs` 只清空 `assets/`。

## 开发

```bash
bun install
bun run dev        # Vite dev server :5173，把 /admin 代理到后端 :8788
```

先起后端（默认 8788），再 `bun run dev`，浏览器开 http://localhost:5173/admin 。
所有 `/admin/api/...` 请求经代理打到后端。

## 构建

```bash
bun run build      # 清 assets → tsc -b → vite build，产物落到 ../src/static/admin/
bun run typecheck  # 仅类型检查
```

构建后后端无需改动即可服务新页面。

## 目录

- `src/lib/` — `adminBase`（`__ADMIN_BASE__` → `adminUrl`）、`api`（fetch 封装 + 401 处理）、
  `status`（中文映射）、`format`、`logRender`（日志 → JSX）、`accountCells`（表格单元格）、
  `mailProviders`（邮箱服务元数据）、`types`。
- `src/context/` — Auth / Theme / Toast / Operation。
- `src/hooks/` — `useHashView`、`usePolling`、`useTaskRestore`（刷新后重连探测/重登任务）。
- `src/components/` — Sidebar、LoginScreen、OperationDialog、Badge、Terminal、MailProviderFields、
  `settings/*`（远端对接 / 重登 / 强力模式 / 定时策略 / 改密卡片）。
- `src/pages/` — RegisterView（注册）、AccountsView（账号池）、SettingsView（设置）。
