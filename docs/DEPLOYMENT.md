# 生产部署与桌面发布

本项目使用同一个 `v*` Git tag 串行完成后端部署和桌面客户端构建：

```text
推送版本 Tag
  -> 校验 Tag 与应用版本
  -> 运行前端测试和构建、后端类型检查
  -> 构建后端 Docker 镜像并推送到 GHCR
  -> SSH 登录生产服务器并通过 Docker Compose 更新后端
  -> 检查 https://skills-api.kktree.cn/health
  -> 构建 Windows、macOS Apple Silicon 和 macOS Intel 安装包
  -> 创建 GitHub Draft Release
```

## 1. 服务器准备

服务器需要已经安装 Docker 和 Docker Compose，并运行现有 Traefik。先确认 Traefik
使用的 Docker 网络、HTTPS entrypoint 和证书 resolver：

```bash
docker network ls
docker ps
```

创建部署目录：

```bash
mkdir -p /home/nangua/kocotree-skills-desktop
cd /home/nangua/kocotree-skills-desktop
```

把仓库中的文件复制为服务器实际配置：

```text
deploy/docker-compose.prod.example.yml -> /home/nangua/kocotree-skills-desktop/docker-compose.yml
deploy/.env.example                    -> /home/nangua/kocotree-skills-desktop/.env
```

生产 `.env` 必须替换所有占位值，并确保：

```text
API_DOMAIN=skills-api.kktree.cn
FEISHU_REDIRECT_URI=https://skills-api.kktree.cn/api/auth/feishu/callback
DESKTOP_AUTH_CALLBACK_URL=kocotree-skills://auth/callback
DEEPSEEK_API_KEY=替换为真实的 DeepSeek API Key
```

可以生成独立的 Token 签名密钥：

```bash
openssl rand -base64 48
```

真实数据库密码、飞书密钥、Token 密钥、OSS 密钥和 DeepSeek API Key 只保存在服务器 `.env`，不要提交到
Git 或放入桌面构建环境。

首次部署前验证 Compose：

```bash
docker compose config
```

如果 GHCR 包是私有的，需要先在服务器登录：

```bash
echo "GitHub PAT" | docker login ghcr.io -u "GitHub 用户名" --password-stdin
```

PAT 至少需要 `read:packages`。

## 2. Traefik

Compose 不把后端 4000 端口映射到公网。Traefik 和后端通过同一个外部 Docker 网络
通信：

```text
https://skills-api.kktree.cn -> Traefik -> backend:4000
```

本项目使用服务器现有 Traefik 的固定配置：

```text
Docker 网络：traefik-network
HTTPS entrypoint：websecure
证书 resolver：myresolver
```

DNS 需要把 `skills-api.kktree.cn` 指向 Traefik 所在服务器。

## 3. 飞书开放平台

在飞书开放平台对应应用的安全设置中，把重定向 URL 配置为：

```text
https://skills-api.kktree.cn/api/auth/feishu/callback
```

该值必须与服务器 `.env` 中的 `FEISHU_REDIRECT_URI` 完全一致。

## 4. GitHub Actions Secrets

进入仓库的 Actions Secrets：

```text
GitHub 仓库
  -> Settings
  -> Secrets and variables
  -> Actions
  -> Repository secrets
```

配置：

```text
SSH_HOST
SSH_PORT
SSH_USER
SSH_PRIVATE_KEY
DEPLOY_DIR
REGISTRY_USERNAME
REGISTRY_TOKEN
TAURI_SIGNING_PRIVATE_KEY
```

说明：

- `SSH_PRIVATE_KEY` 是专用部署私钥的完整内容，不是本地文件路径。
- `SSH_USER` 使用服务器登录用户 `nangua`。
- `REGISTRY_USERNAME` 使用创建 GHCR PAT 的 GitHub 用户 `Sun-0102`。
- `DEPLOY_DIR` 为 `/home/nangua/kocotree-skills-desktop`。
- `REGISTRY_TOKEN` 用于生产服务器拉取 GHCR 私有镜像，至少需要 `read:packages`。
- `TAURI_SIGNING_PRIVATE_KEY` 是 Tauri Updater 私钥的完整内容，只用于在
  Release 构建中签署更新包，不能提交到仓库。当前密钥没有口令，因此不需要配置
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。

本机私钥默认位于 `~/.tauri/kocotree-skills.key`，公钥位于同目录的
`kocotree-skills.key.pub`。把私钥文件的完整内容保存为 GitHub Secret 后，还必须把
私钥安全备份到另一处；丢失私钥后，已经安装的客户端将无法验证后续更新。

建议为部署创建独立 SSH 密钥，不要使用日常登录主密钥。

## 5. 发布版本

完整发布步骤、更新说明规则和产物检查清单见
[Kocotree Skills 发布手册](./发布流程.md)。

发布前必须让以下版本信息保持一致：

```text
package.json
src-tauri/tauri.conf.json
src-tauri/Cargo.toml
src-tauri/Cargo.lock 中 kocotree-skills-desktop 包的版本
```

同时更新仓库根目录的 `发布说明.md`，填写本次面向用户展示的中文更新说明。
客户端页面已经包含“本次更新”标题，文件中只需填写具体条目。

Tag 使用相同版本并带 `v` 前缀：

```bash
git tag v0.1.0
git push origin v0.1.0
```

工作流会拒绝版本不一致的 Tag。

当前 Release 默认创建为 Draft。检查安装包和发布说明后，再在 GitHub Releases 页面
手动 Publish。Draft Release 不会被客户端的 `/releases/latest/` 更新地址发现；发布后，
客户端才会读取其中的 `latest.json`。

## 6. 当前签名策略

- Windows 安装包暂时不签名，内部用户需要手动通过 SmartScreen 提示。
- macOS 使用 Tauri Ad-hoc 签名，用户仍可能需要在“隐私与安全性”中手动允许。
- Tauri Updater 使用独立的 minisign 密钥签署每个平台的更新包。客户端内置公钥，
  Release 工作流使用 `TAURI_SIGNING_PRIVATE_KEY` 生成 `.sig` 和 `latest.json`。
- 自动更新签名只负责验证更新来源和完整性，不能替代 Windows/macOS 的系统代码签名。

正式公开发布前，再接入 Windows Code Signing 和 Apple Developer ID 公证。

## 7. 回滚

每次构建都会向 GHCR 推送三个镜像 Tag：

```text
latest
v0.1.0
Git commit SHA
```

需要回滚时，在服务器 `.env` 中把 `BACKEND_IMAGE_TAG` 改为已验证版本，然后执行：

```bash
docker compose pull backend
docker compose up -d --no-deps backend
curl --fail https://skills-api.kktree.cn/health
```
