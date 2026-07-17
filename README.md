# grok-register

Grok 注册机——自有源码结构。基于 `grok-register-lite`，前端后台重写为 React，并新增 AnyMail 邮箱接码支持。

## 目录

- **`src/`** — FastAPI 后端 + 内嵌 Camoufox 过盾（`turnstile-solver/`）+ `grok-build-auth` 子模块。应用说明见 [src/README.md](src/README.md)。
- **`web/`** — React 19 + Vite + TypeScript 后台前端。开发/构建说明见 [web/README.md](web/README.md)。构建产物输出到 `src/static/admin/`，由后端直接服务。
- **`docker-compose.yml`** — 部署编排（挂载 `./data`、映射端口、过盾环境变量）。
- **`.env.example`** — 环境变量模板，复制为 `.env` 使用。

支持的邮箱服务商：MoeMail / YYDS / GPTMail / Cloudflare Temp Email / DuckMail / **AnyMail**。

## 本地构建与运行

前端产物不入库，先构建前端再起服务：

```bash
# 1) 构建前端 → 产物落到 src/static/admin/
cd web && bun install && bun run build && cd ..

# 2) 复制环境变量并按需修改
cp .env.example .env

# 3) 起服务（用 CI 产出的镜像，或本地构建）
docker compose up -d
```

打开 `http://<IP>:8788/admin`。

### 前端开发（热重载）

```bash
cd web && bun run dev   # :5173，把 /admin 代理到后端 :8788
```

## 镜像 / CI

GitHub Actions（[.github/workflows/build-image.yml](.github/workflows/build-image.yml)）在**打 git tag** 时自动构建多架构镜像并推送到 GHCR：

```bash
git tag v1.0.0
git push origin v1.0.0
```

产出：

- `ghcr.io/yiranxiaohui/grok-register:1.0.0`
- `ghcr.io/yiranxiaohui/grok-register:1.0`
- `ghcr.io/yiranxiaohui/grok-register:latest`

架构：`linux/amd64` + `linux/arm64`。CI 会先 `bun run build` 生成前端产物，再以 `src/` 为上下文 `docker build`（Dockerfile: [src/Dockerfile](src/Dockerfile)），把浏览器（Camoufox）一并烤进镜像。也可在 Actions 页面手动 `Run workflow` 触发。

用 GHCR 镜像部署时，把 `docker-compose.yml` 里的 `image:` 改成 `ghcr.io/yiranxiaohui/grok-register:latest` 即可。
