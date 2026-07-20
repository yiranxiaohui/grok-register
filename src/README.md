# grok-register-lite

Grok 注册机：本地 SQLite 注册、账号管理、SSO/Auth 导出，以及 Grok2API/CPA 导入控制台。  
内嵌 **Camoufox 过盾浏览器**（Turnstile）。

## 本地启动

```bash
./start.sh
```

打开：`http://127.0.0.1:8788/admin/accounts`  
运行数据：`data/register_lite/`（与 Docker/服务器挂载到容器 `/data` 的布局一致）

过盾浏览器（可选单独起）：

```bash
./turnstile-solver/start.sh
```

## Docker 一体封装（推荐）

公开镜像：`puritan3116/grok-register-lite:1.2.13`（或 `:latest`）

单镜像包含：

- 注册机 API + 管理台
- SQLite 账号库（运行时挂载）
- Camoufox 过盾浏览器（镜像内烘焙；运行时也可挂载数据目录缓存）

```bash
# 使用公开镜像（推荐）
# 见 docs/forum-docker-compose.yml + docs/forum-env.example

# 或本地构建：
cp .env.example .env
docker compose up -d --build
docker compose logs -f
```

打开：`http://127.0.0.1:8788/admin/accounts`

### 发布公共镜像

```bash
docker build -t puritan3116/grok-register-lite:1.2.13 \
  -t puritan3116/grok-register-lite:latest .
docker push puritan3116/grok-register-lite:1.2.13
docker push puritan3116/grok-register-lite:latest
```

发布前确认：

1. **不要**把 `.env`、本地数据库、`data/`、`generated/` 打进镜像（`.dockerignore` 已排除）  
2. **不要**在 Dockerfile / compose 写死代理、邮箱密钥、域名  
3. 管理员密码只用运行时环境变量：
   ```bash
   GROK_REGISTER_ADMIN_BOOTSTRAP_PASSWORD='强密码'
   ```

### 数据持久化（重要）

**业务数据在宿主机目录，不在可丢弃的容器层。**

默认挂载：

```text
./data/register_lite  →  容器 /data
```

```text
data/register_lite/
  register_lite.sqlite3
  backups/
  outputs/
  cache/            # 运行时可选浏览器缓存
  register_sso/
```

自定义路径：

```bash
GROK_REGISTER_HOST_DATA_DIR=/var/lib/grok-register
```

### 浏览器

- **不打进镜像**（否则镜像 3GB+，推送很慢）
- 首次 `docker compose up` 自动下载到 `./data/register_lite/cache/`
- 版本由 `camoufox` 包决定，不写死
- 需要 `shm_size: 1gb`（compose 已配）
- 过盾端口仅容器内 `127.0.0.1:5072`

### 常用命令

```bash
docker compose restart
docker compose down
docker compose up -d --build
docker compose exec register-lite bash
```

## 功能概览

- 协议注册（邮箱 + 本地过盾 + SSO → OAuth）
- 账号池 / 测活 / 重登
- 拉取远端全部 / 拉取远端异常
- 导出 SSO / Auth ZIP / CPA
- 上传 Grok2API / CPA
- 删除 CPA 异常账号（远端 auth + 本地记录，手动按钮 / 调度自动，默认关）
- 远端对接支持第三方 **sub2api**：通过其原生 `sso-to-oauth` 接口导入账号（仅上传本地 SSO，转换/探活由 sub2api 完成），与 Grok2API / CPA 三选一互斥；支持账号级代理同步、测活/重登后自动上传、手动批量导入
