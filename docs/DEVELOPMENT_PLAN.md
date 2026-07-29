# Kocotree Skills 当前开发计划

## 1. 当前目标

当前版本优先完成平台 Skill 的真实安装。桌面客户端负责下载平台版本、校验 ZIP、安全解压并写入 `~/.agents/skills/<skillName>`；浏览器开发环境继续使用 Mock 安装。

## 2. 计划表

| 优先级 | 能力 | 当前状态 | 验收标准 |
| --- | --- | --- | --- |
| P0 | 安装器环境切换 | 已完成 | 浏览器使用 Mock，Tauri 窗口调用 Rust 安装命令 |
| P0 | Mock 可安装包 | 已完成 | Mock 下载凭证包含可解压 ZIP，包哈希与实际字节一致 |
| P0 | 安装包下载 | 已完成 | 支持 HTTP、HTTPS 和 Mock ZIP data URL，限制 50 MB 与 30 秒超时 |
| P0 | 包完整性校验 | 已完成 | `packageSha256` 不一致时停止安装，不写入目标目录 |
| P0 | ZIP 基础安全校验 | 已完成 | 拒绝路径穿越、绝对路径、反斜杠路径、符号链接、重复路径和大小写冲突 |
| P0 | Skill 结构校验 | 已完成 | 支持根目录或单层外包装目录，要求唯一 `SKILL.md` 且名称一致 |
| P0 | 临时解压与最终写入 | 已完成 | 内容先进入同分区临时目录，校验成功后移动到最终目录 |
| P0 | 同名目录保护 | 已完成 | 目标目录存在时返回冲突，已有文件保持不变 |
| P0 | 前端安装反馈 | 已完成 | 展示安装成功路径、包校验错误和不支持覆盖的冲突提示 |
| P0 | 基础自动化测试 | 已完成 | 覆盖正常安装、单层目录、路径穿越、目标冲突、包哈希失败和名称不一致 |
| P0 | 跨平台 Agent 连接 | 已完成 | macOS 使用目录软连接；Windows 按目录软连接、NTFS Junction、受管目录副本依次降级 |
| P1 | 真实后端下载联调 | 待开始 | 使用后端签发的短期下载 URL 完成安装 |
| P1 | Windows 与 macOS 实机验证 | 进行中 | 双平台 CI 与 Windows 安装包构建已通过；仍需在 Windows 实机验证安装、连接和关闭 |
| P1 | 解压内容哈希校验 | 待开始 | 解压结果的 `contentHash` 与平台版本完全一致 |
| P1 | 上传页选择文件夹 | 已完成 | 用户选择 Skill 文件夹后，客户端在内存中自动打包并复用现有 ZIP 发布流程 |
| P1 | 本地 Skill 卡片直接上传 | 待开始 | 本地 Skill 卡片提供上传按钮并直接使用已扫描的实际目录，用户无需再次选择文件夹 |
| P2 | 同名目录覆盖 | 待开始 | 用户明确确认后才允许覆盖 |
| P2 | 覆盖备份与失败回滚 | 待开始 | 覆盖失败时自动恢复原目录 |
| P2 | 最小安装凭证 | 待开始 | 安装成功后原子写入平台版本与内容哈希记录 |

## 3. macOS 与 Windows 连接策略

- Skill 本体统一保存在当前用户目录下的 `.agents/skills/<skillName>`。
- macOS 和 Linux 使用目录软连接接入 Claude Code 与 Codex。
- Windows 先尝试目录软连接；权限不足或开发者模式未开启时降级为无需管理员权限的 NTFS Junction。
- 软连接与 Junction 都不可用（例如部分 UNC、WSL 或非 NTFS 路径）时，创建带管理标记的目录副本。
- 受管副本保存源目录摘要；扫描发现本体变化时自动刷新。关闭时必须同时验证状态记录、管理标记和源路径，只删除 Agent 目标，不删除 Skill 本体。
- 前端统一使用“连接”术语，不向用户暴露不同操作系统的底层实现。
- CI 必须在 macOS 与 Windows 上分别运行前端测试、前端生产构建和 Rust 测试。
- `Windows Installer` 工作流在 `nangua` 分支相关代码更新时自动运行，也支持从 GitHub Actions 手动触发。
- 工作流生成 NSIS `.exe` 和 WiX `.msi`，并上传到 `kocotree-skills-windows-x64` Artifact，保留 14 天。
- Windows 测试电脑无需 Node.js、Rust 或 pnpm；下载并解压 Artifact 后，直接运行安装程序即可。
- 未配置代码签名的测试安装包可能触发 SmartScreen，正式发布前需要补充 Windows 代码签名。

## 4. Windows 安装与验收

### 4.1 下载安装包

1. 打开 GitHub Actions 中成功的 [`Windows Installer` 构建](https://github.com/kocotree/kocotree-skills-desktop/actions/runs/30341490159)。
2. 在运行详情页底部的 **Artifacts** 区域下载 `kocotree-skills-windows-x64`。
3. 解压下载的 ZIP。普通测试优先运行 NSIS 的 `*-setup.exe`；也可以使用 WiX 的 `.msi`。
4. 测试安装包尚未签名。如果 SmartScreen 拦截，确认文件来自本项目构建后，点击“更多信息”→“仍要运行”。
5. 按安装向导完成安装并启动 Kocotree Skills。Windows 电脑不需要额外安装 Node.js、Rust 或 pnpm。

Artifact 保留 14 天；过期后需要重新运行 `Windows Installer` 工作流生成新的安装包。

### 4.2 准备测试 Skill

在 Windows PowerShell 中执行：

```powershell
$skill = Join-Path $env:USERPROFILE ".agents\skills\windows-test"
New-Item -ItemType Directory -Force $skill

@"
---
name: windows-test
description: Windows compatibility test
---
"@ | Set-Content (Join-Path $skill "SKILL.md")
```

重新扫描后，“全部 Agents”页面应显示 `windows-test`。

### 4.3 验证 Agent 连接

1. 在“全部 Agents”页面为 `windows-test` 开启 Codex。
2. 确认 `%USERPROFILE%\.codex\skills\windows-test` 已出现。
3. 为同一个 Skill 开启 Claude Code，并确认 `%USERPROFILE%\.claude\skills\windows-test` 已出现。
4. 关闭并重新启动软件，确认两个 Agent 的连接状态仍然正确。
5. 分别关闭 Codex 和 Claude Code，确认对应 Agent 目录中的入口消失。
6. 确认 `%USERPROFILE%\.agents\skills\windows-test\SKILL.md` 始终存在，关闭连接不得删除本体。

可以用 PowerShell 查看 Windows 实际采用的连接类型：

```powershell
Get-Item "$env:USERPROFILE\.codex\skills\windows-test" |
  Format-List FullName,LinkType,Target,Attributes
```

- `LinkType` 为 `SymbolicLink`：使用了 Windows 目录软连接。
- `LinkType` 为 `Junction`：软连接权限不足，已正常降级为 NTFS Junction。
- 没有 `LinkType`，且目录内存在 `.kocotree-managed-copy.json`：软连接和 Junction 均不可用，已降级为受管目录副本。

普通本地 NTFS 用户目录通常会使用 Symbolic Link 或 Junction。受管目录副本主要覆盖网络用户目录、UNC、WSL 或非 NTFS 等特殊环境；该降级顺序已经由 Windows CI 自动化测试验证。

### 4.4 验收记录

测试时至少记录以下信息：

- Windows 版本和系统架构。
- 安装使用的是 `.exe` 还是 `.msi`。
- Codex 和 Claude Code 各自采用的 `LinkType`。
- 开启、重启扫描、关闭是否成功。
- SmartScreen、WebView2、文件权限或长路径相关错误的完整提示。

## 5. 本地 Skill 直接上传

### 5.1 用户入口

- 在“全部 Agents”、Claude Code 和 Codex 的本地 Skill 卡片上提供明确的“上传到平台”操作。
- 同一个 Skill 通过软连接出现在多个 Agent 目录时，上传的是解析后的同一本体目录，不重复上传软连接。
- 用户不需要先把目录打成 ZIP，也不需要在上传页面再次选择文件。
- 点击按钮后进入上传确认流程；客户端自动读取 `SKILL.md` 并预填名称、描述等可推导信息，只要求用户补充或确认平台必填信息。

### 5.2 创建与更新

- 本地记录没有可信的平台 `skillId` 时，默认创建新的平台 Skill，首个版本为 `1.0.0`。
- 本地记录能够确认平台来源时，默认发布到对应 Skill；版本号预填为当前平台版本的下一个补丁版本，用户可以在提交前修改。
- 已知平台来源但本地 `skillName` 与平台记录不一致时禁止直接上传，并提示用户选择“创建新 Skill”或修正本地元数据。
- 本地内容与目标平台版本内容相同时不重复发布，显示“内容没有变化”。

### 5.3 自动打包与安全

- 桌面端通过 Tauri/Rust 从本地 Skill 的真实本体目录生成临时 ZIP；网络接口继续复用现有创建 Skill 和发布版本的 multipart ZIP 契约。
- 自动打包必须先解析受管软连接，只读取最终 Skill 本体，不把软连接文件本身作为上传内容。
- 打包时忽略 `.DS_Store`、`__MACOSX` 和 `._*` 等系统元数据，并沿用 ZIP 上传的路径、文件数量、单文件大小、总大小和唯一 `SKILL.md` 校验。
- 不跟随 Skill 目录内部指向目录外部的软连接；遇到越界路径、循环链接、不可读文件或超过 50 MB 时停止上传并给出具体原因。
- 临时包仅用于本次上传，完成或失败后清理；整个流程不得修改本地 Skill 本体。
- 服务端仍需重新解析上传包并计算权威哈希，不能信任客户端校验结果。

### 5.4 验收标准

- 用户可以从任一本地 Skill 卡片发起上传，全程不需要手工打包或选择 ZIP。
- 未关联平台的本地 Skill 可以创建 `1.0.0`；已关联平台的本地 Skill 可以发布默认的下一补丁版本。
- 同一本体的 Claude/Codex 软连接不会造成重复上传或上传错误目录。
- 自动打包失败、平台名称冲突、内容未变化和后端上传失败都有明确反馈，且不会修改本地文件。

## 6. 仍非当前范围

- 本地 Skill 删除。
- 备份列表和手动恢复。
- 派生 Skill 一键替换。
- 下载进度、暂停和取消。
