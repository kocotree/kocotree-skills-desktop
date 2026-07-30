# Kocotree Skills 架构说明

## 1. 架构目标

Kocotree Skills 当前包含在线 Skill 平台和平台版本安装两个领域：

- 在线平台负责浏览、详情、版本、发布、协作和下载凭证。
- 安装能力负责把用户选择的平台版本安全写入本机 Skill 目录。
- React 页面不直接访问文件系统、Tauri 命令或 HTTP。
- 在线服务不能直接读写用户磁盘。
- 本地安装成功后再向在线服务上报安装事件。
- 在线上报失败不能回滚已经成功的本地安装。

当前本地范围只包含安装。已实现版本在目标目录不存在时完成下载、校验、安全解压和最终写入；目标冲突时停止安装。覆盖、备份、回滚和安装凭证按开发计划逐步补充，不作为独立的本地管理功能提供。

以下能力不在当前范围：

- 扫描并管理任意本地 Skill。
- 识别未知来源、本地修改或丢失目录。
- 单独移除 Skill。
- 展示备份列表或手动恢复备份。
- 恢复任意本地 Skill 与平台版本的关联。
- 管理 Claude 目录链接。
- 自动替换同一派生链上的其他 Skill。

## 2. 当前项目基础

架构直接建立在现有代码上。

| 当前模块 | 当前职责 | 架构归属 |
| --- | --- | --- |
| `src/App.tsx` | 应用外壳、登录拦截、安装确认、下载凭证、本地安装和安装上报编排 | 页面层与当前安装用例 |
| `src/components/InstallConfirmModal.tsx` | 安装版本确认和同名冲突确认 | 安装展示层 |
| `src/components/InstallFeedbackModal.tsx` | 安装成功、降级、回滚和提示反馈 | 安装展示层 |
| `src/api/contracts.ts` | OpenAPI DTO、`SkillApi`、`LocalSkillService` 和安装模型 | 在线端口与本地端口 |
| `src/api/mockSkillApi.ts` | 在线平台内存模拟 | `SkillApi` 的 Mock 适配器 |
| `src/api/mockLocalSkillService.ts` | 安装、同名冲突和结果模拟 | `LocalSkillService` 的 Mock 适配器 |
| `src/api/tauriInstaller.ts` | 调用 Tauri 安装命令并转换安装结果和错误 | `SkillInstaller` 的桌面适配器 |
| `src/api/index.ts` | 创建并导出共享服务实例 | 应用组合入口 |
| `src/api/skillPackage.ts`、`src/api/zipInspector.ts` | ZIP 路径检查、文件清单、元数据和哈希 | 客户端包检查规则 |
| `docs/openapi.yaml`、`src/api/schema.d.ts` | 在线 HTTP 契约及生成类型 | 在线领域契约 |
| `src-tauri/src/lib.rs` | Tauri 启动和命令注册入口 | 本地适配器入口 |
| `src-tauri/src/installer/mod.rs` | 下载、包哈希、安全解压和最终写入 | Rust 安装实现 |

当前页面通过 `skillApi`、`installer` 和 `localSkillService` 访问数据。浏览器开发与前端测试使用 Mock 安装器；Tauri 桌面窗口使用真实磁盘安装器；在线平台仍使用 Mock API。

“我的 Skill”中的本地页签目前展示 Mock 数据，不代表真实磁盘扫描能力。

## 3. 领域边界

### 3.1 在线平台

在线平台通过 `SkillApi` 提供：

- 浏览、搜索和筛选 Skill。
- 查询 Skill 详情与指定版本。
- 创建 Skill 和发布版本。
- 修改展示信息和永久删除自己发布的 Skill。
- 获取短期下载凭证。
- 上报幂等的安装成功事件。

OpenAPI 只描述在线 HTTP 契约，不描述 Tauri 命令或本地文件系统结构。

### 3.2 本地安装

本地安装适配器负责：

- 接收已经确定的目标版本和下载凭证。
- 下载 ZIP 并校验包哈希。
- 安全解析 ZIP，拒绝路径穿越、链接和越界路径。
- 校验唯一 `SKILL.md` 和目标 Skill 名称。
- 检查目标目录是否冲突。
- 通过同分区临时目录解压，并在目标不存在时移动到最终路径。

本地安装适配器不负责在线查询、登录、页面交互或平台统计。

### 3.3 安装协调

安装协调流程组合 `SkillApi` 与本地安装适配器：

1. 获取目标 Skill 与版本。
2. 获取下载凭证和安装包。
3. 转换为本地安装请求。
4. 调用本地安装适配器。
5. 处理同名冲突并等待用户确认。
6. 本地安装成功后上报安装事件。

协调流程不直接操作磁盘，也不实现服务端业务规则。

### 3.4 身份

身份适配器负责获取当前用户和 Bearer Token。平台安装是在线写操作，需要登录；登录协议和令牌生命周期由后续认证接入方负责。

## 4. 分层与依赖方向

```mermaid
flowchart TB
  UI["React 页面与安装弹窗"]
  InstallFlow["安装协调流程"]
  OnlinePort["SkillApi"]
  LocalPort["本地安装端口"]
  Composition["src/api/index.ts"]
  MockOnline["MockSkillApi"]
  MockLocal["MockLocalSkillService"]
  HttpAdapter["HttpSkillApi"]
  TauriAdapter["Tauri 安装适配器"]
  Server["在线 Skill 服务"]
  Rust["Rust 文件系统实现"]

  UI --> InstallFlow
  UI --> OnlinePort
  InstallFlow --> OnlinePort
  InstallFlow --> LocalPort
  Composition -. "创建并注入" .-> OnlinePort
  Composition -. "创建并注入" .-> LocalPort
  OnlinePort --> MockOnline
  OnlinePort --> HttpAdapter
  LocalPort --> MockLocal
  LocalPort --> TauriAdapter
  HttpAdapter --> Server
  TauriAdapter --> Rust
```

依赖方向固定为“页面 → 协调流程或接口 → 适配器”。`src/api/index.ts` 是组合入口：浏览器环境注入 Mock，桌面环境注入 Tauri 本地实现，接入后端时注入 HTTP 在线实现。

## 5. 数据归属

| 数据 | 事实来源 | 持久化位置 |
| --- | --- | --- |
| 在线 Skill、版本和平台信息 | 在线服务 | 服务端 |
| 下载凭证 | 在线服务 | 客户端短期内存 |
| 下载缓存 | 安装流程 | 系统临时目录 |
| 生效 Skill 目录 | 本地安装流程 | `~/.agents/skills/<skillName>` |
| 登录身份和令牌 | 身份适配器 | 由认证接入方定义 |

## 6. 核心接口

### 6.1 SkillApi

现有 `SkillApi` 作为在线端口，继续负责详情、版本、下载凭证和安装上报。`MockSkillApi` 用于浏览器开发和测试，后端接入时增加 `HttpSkillApi`。

### 6.2 本地安装端口

`SkillInstaller` 只包含安装方法。浏览器环境由 `MockLocalSkillService` 实现，Tauri 环境由 `TauriInstaller` 实现：

```ts
interface SkillInstaller {
  install(input: LocalInstallRequest): Promise<LocalInstallResult>;
}

interface LocalInstallRequest {
  skill: SkillSummaryDto;
  version: SkillVersionDto;
  ticket?: DownloadTicketDto;
  force?: boolean;
}
```

Tauri 命令只接收安装所需字段：

```ts
interface InstallSkillCommandInput {
  skillId: string;
  versionId: string;
  version: string;
  skillName: string;
  downloadUrl: string;
  packageSha256: string;
}
```

本地安装错误至少区分：

- 包校验失败。
- 安装目标冲突。
- 文件系统权限不足。
- ZIP 结构无效。
- `SKILL.md` 名称不一致。

### 6.3 安装协调服务

`App.tsx` 当前直接串联下载凭证、详情查询、真实本地安装和安装上报。安装流程继续扩展时把这段编排提取为单一安装协调服务：

```ts
interface InstallationService {
  installPlatformVersion(input: {
    skillId: string;
    versionId: string;
    force: boolean;
  }): Promise<PlatformInstallResult>;
}
```

`App.tsx` 保留登录拦截、弹窗状态和 Toast。协调服务负责在线 DTO 转换、下载、本地安装和成功上报。

## 7. 安装流程

### 7.1 正常安装

1. 在线服务确认目标 Skill 与版本可安装。
2. 客户端获取短期下载凭证。
3. Tauri 安装器下载 ZIP 并校验 `packageSha256`。
4. 安全解析 ZIP，校验结构、大小、路径和 `SKILL.md` 名称。
5. 将内容写入 `~/.agents/skills` 下的临时目录。
6. 确认最终目标目录不存在。
7. 将临时内容移动到最终目录。
8. 使用唯一事件编号上报安装成功。

最终目录写入完成后即视为安装成功。安装事件上报失败不能删除已经安装的目录。

### 7.2 同名冲突

1. 目标目录不存在时进入正常安装。
2. 目标目录存在时停止写入并返回 `LOCAL_SKILL_CONFLICT`。
3. 页面展示冲突目录和“不覆盖已有内容”的提示。

### 7.3 历史版本

历史版本安装沿用同一流程。页面展示当前版本、目标版本和更新说明，用户确认后执行安装；客户端不自动降级，旧数据中的撤回版本不可安装。

## 8. 安全与原子性

- 拒绝绝对路径、路径穿越、符号链接、目录联接和大小写冲突。
- 限制包大小、解压总大小和文件数量。
- 安装过程不执行包中的脚本或二进制文件。
- ZIP 在解压前校验 `packageSha256`。
- 临时目录和最终目录必须限定在解析后的明确位置。
- 解压内容使用同分区临时目录，成功后移动到最终路径。
- Rust 层使用标准日志记录下载完成、校验结果、冲突判断、最终写入和异常。

## 9. 跨平台边界

React 和安装协调服务不包含 Windows、macOS 或 Linux 路径逻辑。

Rust 适配器负责：

- 解析用户主目录和规范化安装目标。
- 处理平台权限、文件占用和原子重命名差异。
- 返回统一安装结果和错误码。

Windows 与 macOS 使用同一安装端口和安全规则，分别验证正常安装、同名冲突和文件系统权限错误。

## 10. 代码落点

真实安装按以下边界落地：

```text
src/
├─ App.tsx
├─ components/
│  ├─ InstallConfirmModal.tsx
│  └─ InstallFeedbackModal.tsx
└─ api/
   ├─ contracts.ts
   ├─ index.ts
   ├─ mockSkillApi.ts
   ├─ mockLocalSkillService.ts
   └─ tauriInstaller.ts

src-tauri/src/
├─ lib.rs
└─ installer/
   └─ mod.rs
```

`index.ts` 负责根据运行环境选择 Mock 安装器或 Tauri 安装器。安装器能力扩大后再按下载、校验、写入等职责拆分 Rust 文件。

## 11. 开发计划

当前实现状态、下一阶段任务和非当前范围统一维护在 [`DEVELOPMENT_PLAN.md`](./DEVELOPMENT_PLAN.md)。

## 12. 文档职责

- 本文档定义在线平台与本地安装的架构边界。
- [`DEVELOPMENT_PLAN.md`](./DEVELOPMENT_PLAN.md) 定义当前开发顺序和验收标准。
- [`API_REFERENCE.md`](./API_REFERENCE.md) 与 [`openapi.yaml`](./openapi.yaml) 定义在线 HTTP 契约。
- [`adr/0003-local-installation-state.md`](./adr/0003-local-installation-state.md) 记录安装状态和安全边界。
