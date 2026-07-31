# Kocotree Skills

Kocotree Skills 是使用 Tauri 2、React 和 TypeScript 开发的 Skill 浏览、发布与安装客户端。

当前版本使用内存模拟接口，已经支持：

- 匿名浏览、搜索、Tag 筛选和排序。
- Skill 详情、版本历史和原始 `SKILL.md` 预览。
- 模拟飞书登录，以及登录后继续安装或上传操作。
- ZIP 或文件夹解析后创建 Skill，或为指定 Skill 发布更高版本。
- 浏览器中的模拟安装，以及 Tauri 桌面窗口中的真实下载、校验、解压和写入。
- 安装成功上报和本地安装状态演示。

真实后端和身份适配器尚未接入。登录协议与令牌生命周期由后续认证接入方提供。上传页面支持手工 ZIP，也支持选择文件夹后在内存中自动打包；两种入口都会校验文件路径、大小、数量、`SKILL.md` 元数据和内容哈希。

Tauri 窗口中的安装会把 Mock 接口生成的 ZIP 写入私有仓库 `~/.skills-manager/skills/<skillName>`。只有用户分别开启 Claude Code 或 Codex 后，客户端才会在对应 Agent 的扫描目录创建生效入口；关闭后会彻底移除入口。目标目录存在时会先请求用户确认；确认覆盖后，旧目录备份到 `~/.skills-manager/backups`，再安装平台版本，写入失败时自动恢复旧目录。浏览器页面仍使用内存 Mock，不写入本地目录。

## 本地运行

安装依赖：

```bash
pnpm install
```

只运行浏览器前端：

```bash
pnpm dev
```

打开 `http://localhost:1420/` 即可调试 React 页面。

运行 Tauri 桌面客户端：

```bash
pnpm tauri dev
```

此命令会同时启动 Vite 开发服务和 Tauri 窗口。浏览器页面与桌面窗口使用同一套 React 前端。

## 开发检查

```bash
pnpm test
pnpm build
```

接口契约更新后重新生成 TypeScript 类型：

```bash
pnpm api:generate
```

接口定义以 [`docs/openapi.yaml`](./docs/openapi.yaml) 为准，本地与在线领域边界见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)，当前排期见 [`docs/DEVELOPMENT_PLAN.md`](./docs/DEVELOPMENT_PLAN.md)。

生产环境的 Traefik、Docker Compose、GitHub Actions 和 Tag 发布配置见
[`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md)。

## 推荐编辑器配置

- [VS Code](https://code.visualstudio.com/)
- [Tauri 扩展](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
- [rust-analyzer 扩展](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
