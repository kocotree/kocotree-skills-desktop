# Kocotree Skills Desktop Backend

这个目录承载从旧项目逐步迁移到 desktop 项目的后端能力。当前只迁移飞书授权登录，
不包含 Skill 列表、上传、下载等其他接口。

## 当前接口

| 方法和路径 | 说明 |
| --- | --- |
| `GET /health` | 健康检查 |
| `GET /api/auth/feishu/login` | 打开飞书授权 |
| `GET /api/auth/feishu/callback` | 飞书 OAuth 回调 |
| `POST /api/auth/desktop/exchange` | 使用一次性 code 换取 Bearer Token |
| `POST /api/auth/logout` | 注销当前 Bearer Token |
| `GET /api/users/me` | 获取当前登录用户 |

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

浏览器 URL 中只携带两分钟有效且只能使用一次的授权码，不携带长期 Bearer Token。

## 数据库

`prisma/schema.prisma` 只映射本阶段需要的 `users` 和 `user_tokens` 表，表名和字段与旧后端
保持一致，因此可以连接现有 PostgreSQL 数据库，不需要为本次迁移新建表。

一次性桌面授权码也保存在 `user_tokens`：

- `client_type = desktop-auth-code`
- `scopes = ["auth:exchange"]`
- 默认两分钟过期
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
```

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

- 其他在线接口继续使用前端 Mock。
- 真实飞书身份会同步给 Mock 业务接口，使登录后的现有演示页面仍可工作。
- Bearer Token 当前保存在 webview 的 `sessionStorage`，关闭会话后需要重新登录。后续可单独
  迁移到系统凭据存储。
- 本阶段没有迁移设备码和轮询接口。
