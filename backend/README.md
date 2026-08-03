# Kocotree Skills Desktop Backend

这个目录承载从旧项目逐步迁移到 desktop 项目的后端能力。当前已经迁移飞书授权登录、
Tag 查询、Skill 列表、Skill 详情、版本历史、文件预览、创建 Skill、发布新版本、
指定版本下载凭证和安装成功上报。

## 当前接口

| 方法和路径 | 说明 |
| --- | --- |
| `GET /health` | 健康检查 |
| `GET /api/auth/feishu/login` | 打开飞书授权 |
| `GET /api/auth/feishu/callback` | 飞书 OAuth 回调 |
| `POST /api/auth/desktop/exchange` | 使用一次性 code 换取 Bearer Token |
| `POST /api/auth/logout` | 注销当前 Bearer Token |
| `GET /api/users/me` | 获取当前登录用户 |
| `GET /api/users/me/skills` | 获取当前用户创建的 Skill |
| `GET /api/tags?query=...` | 查询 Tag |
| `GET /api/skills?query=...&tagId=...&sort=...` | 分页浏览 Skill |
| `GET /api/skills/:skillId` | 获取 Skill 详情 |
| `GET /api/skills/:skillId/versions` | 分页获取版本历史 |
| `GET /api/skills/:skillId/versions/:versionId/files` | 获取版本文件树 |
| `GET /api/skills/:skillId/versions/:versionId/files/content?path=...` | 获取文本文件内容 |
| `POST /api/skills` | 上传 ZIP 并创建 Skill `1.0.0` |
| `POST /api/skills/:skillId/versions` | 为已有 Skill 发布新版本 |
| `DELETE /api/skills/:skillId/versions/:versionId` | Owner 永久删除指定版本，且至少保留一个版本 |
| `DELETE /api/skills/:skillId` | Owner 永久删除 Skill 并清理版本 OSS 包 |
| `POST /api/skills/:skillId/versions/:versionId/download-tickets` | 获取指定已发布版本的短期 OSS 下载地址 |
| `POST /api/installations/events` | 幂等上报安装成功并增加安装次数 |

除健康检查和登录流程接口外，以上业务接口都要求
`Authorization: Bearer <token>`。

登录流程不轮询：

```text
desktop
  → 系统浏览器打开 /api/auth/feishu/login
  → 飞书授权
  → /api/auth/feishu/callback
  → 开发环境：http://127.0.0.1:随机端口/auth/callback?code=一次性授权码
  → 正式环境：kocotree-skills://auth/callback?code=一次性授权码
  → desktop 调用 /api/auth/desktop/exchange
  → 返回 Bearer Token 和用户信息
```

浏览器 URL 中只携带五分钟有效且只能使用一次的授权码，不携带长期 Bearer Token。

## 数据库

`prisma/schema.prisma` 映射本阶段需要的用户、Token、Skill、版本、文件、Tag 和安装会话
表，表名和字段与现有 PostgreSQL 数据库保持一致。

安装成功上报复用数据库已有的 `install_sessions`，不需要新建数据表或执行 migration。
更新 Prisma schema 后只需重新生成 Client：

```bash
cd backend
pnpm prisma:generate
```

客户端的 `eventId` 作为 `install_sessions.id`，是全局幂等键。相同事件重复上报不会重复
增加 `skills.install_count`；复用事件编号上报不同内容会被拒绝。

一次性桌面授权码也保存在 `user_tokens`：

- `client_type = desktop-auth-code`
- `scopes = ["auth:exchange"]`
- 默认五分钟过期
- exchange 成功后立即标记为已撤销

正式桌面 Token 使用 `client_type = desktop`。同一用户重新登录时会撤销其旧的 desktop
Token。

## 本地配置

复制环境变量：

```bash
cd backend
cp .env.example .env
```

至少需要填写：

```text
DATABASE_URL
FEISHU_APP_ID
FEISHU_APP_SECRET
TOKEN_SECRET
OSS_ACCESS_KEY_ID
OSS_ACCESS_KEY_SECRET
```

`OSS_SIGNED_URL_EXPIRES_SECONDS` 控制下载凭证有效期，默认 300 秒。
`SKILL_UPLOAD_MAX_MB` 控制上传 ZIP 的压缩包大小上限，默认 50 MB。服务端会移除
`__MACOSX`、`.DS_Store`、`._*` 等系统元数据并重新生成 ZIP，再计算哈希和上传 OSS。

飞书开放平台中配置的重定向 URL 必须与下面的值完全一致：

```text
http://localhost:4000/api/auth/feishu/callback
```

生产环境应替换为正式 HTTPS API 域名，并同步修改 `FEISHU_REDIRECT_URI`。

安装依赖并生成 Prisma Client：

```bash
pnpm install
pnpm prisma:generate
pnpm dev
```

desktop 根目录可通过 `.env.local` 指定后端地址：

```text
VITE_API_BASE_URL=http://localhost:4000
```

开发模式默认也会回退到 `http://localhost:4000`。

## 深链接

开发环境由 Tauri 在每次登录时监听一个随机 loopback 端口，因此 `pnpm tauri dev`
可以直接接收飞书授权回调。后端只接受满足以下条件的开发回调：

- 协议必须是 `http`。
- host 必须是 `127.0.0.1`。
- 必须包含随机端口。
- path 必须是 `/auth/callback`。

正式构建注册的协议是：

```text
kocotree-skills://auth/callback
```

`DESKTOP_AUTH_CALLBACK_URL` 必须保持相同协议、host 和 path。

macOS 的 `tauri dev` 使用 loopback 回调，不依赖系统注册自定义协议。打包应用继续使用
`kocotree-skills://`；Windows 和 Linux 使用 single-instance 插件把正式深链接交给已经
运行的主应用实例。

## 当前边界

- 飞书登录、当前用户、Tag、Skill 列表、详情、版本历史、文件树、文本预览、创建
  Skill、发布新版本、修改展示信息、下载凭证和安装成功上报使用真实后端。
- 归档、恢复、版本撤回和所有权转移已从产品契约移除；通知等未迁移能力暂时继续使用前端 Mock。
- 真实飞书身份会同步给 Mock 业务接口，使登录后的现有演示页面仍可工作。
- Bearer Token 当前保存在 webview 的 `sessionStorage`，关闭会话后需要重新登录。后续可单独
  迁移到系统凭据存储。
- 本阶段没有迁移设备码和轮询接口。
