# Kocotree Skills Desktop 与现有后端接口对应关系

## 1. 文档目的

本文档用于回答以下问题：

1. `kocotree-skills-desktop` 前端需要哪些在线接口。
2. `Kocotree-skills-repository` 后端目前已经提供哪些接口。
3. 每项能力能否直接复用、是否需要适配，或者必须新增后端实现。
4. 接入真实后端时建议采用什么接口契约和实施顺序。

本文档只讨论在线平台接口。ZIP 下载后的校验、解压和写入
`~/.skills-manager/skills/<skillName>` 属于 Tauri/Rust 本地安装能力，不迁移到后端。

> 2026-07-29：根据 ADR-0006，归档、恢复、版本撤回和所有权转移已从目标产品契约移除。本文档中的历史后端状态字段仅用于兼容旧数据，不再代表待建设功能。

## 2. 对照范围与权威来源

### 2.1 Desktop 前端

- 前端在线端口：`src/api/contracts.ts` 中的 `SkillApi`。
- 目标 HTTP 契约：`docs/openapi.yaml`。
- 当前实现：`MockSkillApi`。
- 真实后端接入点：未来新增的 `HttpSkillApi`。
- 本地安装实现：`TauriInstaller` 和 Rust `install_skill` 命令。

### 2.2 现有后端

- 项目：`Kocotree-skills-repository`。
- 路由入口：`apps/api/src/app.ts`。
- 业务路由：`apps/api/src/routes/*.route.ts`。
- 数据模型：`prisma/schema.prisma`。
- 存储：阿里云 OSS。
- 身份：飞书 OAuth、设备授权、Bearer Token 和 Web Cookie。

## 3. 结论摘要

现有后端可以继续使用，不需要重建数据库、OSS 上传下载和飞书认证。
但它不能原样满足 desktop 前端，需要以 desktop 的 OpenAPI 为目标升级接口。

按复用程度可分为：

| 分类 | 能力 |
| --- | --- |
| 可以直接复用底层实现 | 飞书 OAuth、设备授权、Bearer Token 校验、PostgreSQL、Prisma、OSS、ZIP 打包、签名下载、SHA-256、文件预览 |
| 需要新增 HTTP 适配或调整返回结构 | 当前用户、Skill 列表、Tag、Skill 详情、创建 Skill、最新版文件树、最新版文件内容、最新版下载 |
| 后端已有数据基础，但缺少完整接口 | 历史版本、按版本读取文件、发布新版本、安装计数 |
| 必须新增数据模型和业务实现 | 协作者规则、通知、幂等安装事件、安装来源恢复、用户角色与部门同步 |

建议不要让 desktop 长期兼容旧响应结构。最终应让后端遵守
`kocotree-skills-desktop/docs/openapi.yaml`，desktop 只维护一个
`HttpSkillApi`。

## 4. 复用等级定义

| 等级 | 含义 |
| --- | --- |
| A：可直接复用 | 路径、语义和主要数据均满足；最多只需统一响应外层 |
| B：适配后复用 | 现有服务和数据可复用，但路径、参数、字段或权限需要调整 |
| C：部分复用 | 只能复用数据库、OSS 或部分服务逻辑，需要新增路由和业务规则 |
| D：不能直接复用 | 现有后端没有相应模型或能力，需要新实现 |

## 5. Desktop 前端需要的完整接口

### 5.1 身份接口

身份模块已经作为第一项能力迁入本项目的 `backend/` 目录。desktop 的 `signIn()`
使用深链接回调，不再使用设备码轮询：

1. 使用系统浏览器打开后端飞书登录入口。
2. 用户在飞书完成授权。
3. 开发环境通过随机 `127.0.0.1` 端口返回当前 Tauri 进程；正式环境通过
   `kocotree-skills://auth/callback` 唤起 desktop。
4. desktop 使用短效一次性 code 换取 Bearer Token。
5. 使用 Token 查询当前用户。

| 前端能力 | 需要的接口 |
| --- | --- |
| 发起登录 | `GET /api/auth/feishu/login` |
| 飞书 OAuth 回调 | `GET /api/auth/feishu/callback` |
| 一次性换码 | `POST /api/auth/desktop/exchange` |
| 获取当前用户 | `GET /api/users/me` |
| 退出登录 | `POST /api/auth/logout` |

### 5.2 用户、Tag 和 Skill 接口

| `SkillApi` 方法 | 目标 HTTP 接口 | 用途 |
| --- | --- | --- |
| `getCurrentUser` | `GET /api/users/me` | 获取登录用户 |
| `listMySkills` | `GET /api/users/me/skills` | 获取拥有或协作的 Skill |
| `listTags` | `GET /api/tags` | 查询 Tag |
| `listSkills` | `GET /api/skills` | 浏览和搜索公开 Skill |
| `getSkill` | `GET /api/skills/{skillId}` | 获取详情、Owner、协作者和当前版本 |
| `createSkill` | `POST /api/skills` | 上传 ZIP 并创建首个版本 |
| `updateSkillMetadata` | `PATCH /api/skills/{skillId}` | 修改展示名称、简介和 Tag |

### 5.3 版本和文件接口

| `SkillApi` 方法 | 目标 HTTP 接口 | 用途 |
| --- | --- | --- |
| `listSkillVersions` | `GET /api/skills/{skillId}/versions` | 分页查询全部版本 |
| `getSkillVersion` | `GET /api/skills/{skillId}/versions/{versionId}` | 获取版本和原始 `SKILL.md` |
| `publishSkillVersion` | `POST /api/skills/{skillId}/versions` | 上传 ZIP 并发布新版本 |
| `listVersionFiles` | `GET /api/skills/{skillId}/versions/{versionId}/files` | 获取指定版本文件树 |
| `getVersionFileContent` | `GET /api/skills/{skillId}/versions/{versionId}/files/content?path=...` | 预览指定版本文本文件 |

### 5.4 安装接口

| `SkillApi` 方法 | 目标 HTTP 接口 | 用途 |
| --- | --- | --- |
| `getDownloadTicket` | `POST /api/skills/{skillId}/versions/{versionId}/download-tickets` | 获取指定版本的短期下载地址和哈希 |
| `recordInstallation` | `POST /api/installations/events` | 幂等上报安装成功事件 |
| `getInstallationStatus` | `GET /api/skills/{skillId}/installation-status` | 查询名称冲突或历史状态兼容信息 |
| `resolveInstallation` | `POST /api/installations/resolve` | 使用 `skillName + contentHash` 恢复平台关联 |

### 5.5 通知接口

| `SkillApi` 方法 | 目标 HTTP 接口 |
| --- | --- |
| `listNotifications` | `GET /api/notifications` |
| `readNotification` | `POST /api/notifications/{notificationId}/read` |
| `readAllNotifications` | `POST /api/notifications/read-all` |

## 6. 现有后端接口清单

### 6.1 健康检查

| 方法和路径 | 鉴权 | 当前用途 |
| --- | --- | --- |
| `GET /health` | 否 | 服务健康检查 |

### 6.2 身份认证

| 方法和路径 | 鉴权 | 当前能力 |
| --- | --- | --- |
| `POST /api/auth/device/start` | 否 | 创建设备授权会话 |
| `GET /api/auth/device/poll` | 否 | 轮询并领取 Bearer Token |
| `GET /api/auth/feishu/login` | 否 | 进入设备授权的飞书 OAuth |
| `GET /api/auth/feishu/callback` | 否 | 处理飞书 OAuth 回调 |
| `GET /api/auth/web/feishu/login` | 否 | 网页 Cookie 登录入口 |
| `POST /api/auth/logout` | Cookie | 注销 Web Cookie Token |
| `GET /api/auth/dev/callback` | 开发环境 | 模拟设备授权回调 |
| `GET /api/me` | Bearer 或 Cookie | 返回 `{ user, scopes }` |

### 6.3 Skill

所有现有 Skill 路由都挂载在 `/api/skills` 下。

| 方法和路径 | 鉴权 | 当前能力 |
| --- | --- | --- |
| `GET /api/skills` | 必须登录 | 查询 Skill，参数为 `q`、`tag`、`createdBy`、`page`、`pageSize` |
| `POST /api/skills` | 必须登录 | 上传文件或 ZIP，创建 Skill 和首个版本 |
| `GET /api/skills/tags` | 必须登录 | 分页获取 Tag |
| `GET /api/skills/{idOrSlug}` | 必须登录 | 获取 Skill 和最新版本详情 |
| `DELETE /api/skills/{idOrSlug}` | 必须登录 | 硬删除自己创建的 Skill |
| `GET /api/skills/{idOrSlug}/download` | 必须登录 | 获取最新版本 OSS 签名下载地址 |
| `GET /api/skills/{idOrSlug}/files/content?path=...` | 必须登录 | 获取最新版本文件内容 |

### 6.4 创作者、职业和分类

| 方法和路径 | 鉴权 | 当前能力 | Desktop 是否使用 |
| --- | --- | --- | --- |
| `GET /api/creators` | 必须登录 | 创作者列表 | 当前不使用 |
| `GET /api/creators/{id}` | 必须登录 | 创作者和其 Skill | 当前不使用 |
| `GET /api/occupations` | 否 | 职业列表 | 当前不使用 |
| `GET /api/categories` | 否 | 分类列表 | 当前不使用 |

这些接口来自旧网页的信息架构。desktop 当前使用 Tag，不使用职业和分类；
迁移第一阶段可以保留，但不需要接入 desktop。

## 7. 前后端逐项对应与复用判断

### 7.1 身份

| 前端需要 | 后端现有 | 等级 | 判断和改动 |
| --- | --- | --- | --- |
| `signIn()` | `device/start`、`feishu/login`、`device/poll` | A | 设备授权流程可直接复用；desktop 需要实现浏览器打开、轮询和 Token 保存 |
| `GET /api/users/me` | `GET /api/me` | B | 用户 ID、姓名和头像可复用；desktop 后端已补 `departmentPath`、`role`、`syncedAt` |
| `signOut()` | `POST /api/auth/logout` | C | 当前接口只读取 Web Cookie，不能注销 desktop Bearer Token；需要支持注销当前 Bearer Token |
| Bearer 鉴权 | `requireAuth` | A | 可以复用 |
| 安全保存 Token | 后端不负责 | C | desktop 应使用系统凭据存储或 Rust 安全存储，不建议普通 `localStorage` |

注意：当前设备授权生成的 Token 原文临时保存在 API 进程内存中。后端重启或多实例负载均衡时，
授权回调和轮询可能落到不同进程，从而无法领取 Token。生产部署前需要改为可共享且一次性消费的安全存储方案。

### 7.2 当前用户和“我的 Skill”

| 前端需要 | 后端现有 | 等级 | 判断和改动 |
| --- | --- | --- | --- |
| `GET /api/users/me` | `GET /api/me` | B | 修改路径、外层和 User DTO |
| `GET /api/users/me/skills?relation=...` | 可用 `GET /api/skills?createdBy=...` 查询创建者 | C | `OWNED` 可部分复用；`COLLABORATED` 和权限过滤必须新增 |

desktop 后端将主部门路径同步到 `users.department_path`，并通过 User DTO 返回
`departmentPath`；`role` 当前固定为 `USER`，`syncedAt` 使用用户记录更新时间。

### 7.3 Tag

| 前端需要 | 后端现有 | 等级 | 判断和改动 |
| --- | --- | --- | --- |
| `GET /api/tags?query=...` | `GET /api/skills/tags?page=...` | B | Tag 表和查询服务可复用；需改路径、支持名称查询，并按 desktop 契约返回 |

差异：

- desktop 和后端都要求登录并携带 Bearer Token。
- desktop 接收 `query`，旧后端只有分页。
- 旧后端返回 `{ items, total, page, pageSize }`，desktop 目标是
  `{ code, data: Tag[], msg }`。

### 7.4 Skill 列表

| 前端需要 | 后端现有 | 等级 | 判断和改动 |
| --- | --- | --- | --- |
| `GET /api/skills` | `GET /api/skills` | B | 路径相同，查询仓库可复用；鉴权、参数、排序、状态过滤和 DTO 需要对齐 |

查询参数对应：

| Desktop | 旧后端 | 复用判断 |
| --- | --- | --- |
| `query` | `q` | 可改名或在后端同时兼容 |
| `tagId` | `tag`（Tag 名称或 slug 语义） | 不能直接等价，需要统一为稳定 Tag ID |
| `sort` | 无 | 新增 `UPDATED_DESC`、`CREATED_DESC`、`INSTALLS_DESC` |
| `page` | `page` | 直接复用 |
| `pageSize` | `pageSize` | 直接复用 |
| 必须登录 | 必须登录 | 统一由 HTTP Client 自动携带 Bearer Token |

响应字段对应：

| Desktop 字段 | 旧后端字段 | 判断 |
| --- | --- | --- |
| `id` | `id` | 直接映射 |
| `skillName` | `name` | 可映射，但需确认 `name` 是否始终来自 `SKILL.md` |
| `displayName` | 无独立字段 | 需要新增字段或暂时使用 `name` |
| `skillDescription` | `description` | 可暂时映射 |
| `displayDescription` | 无独立字段 | 需要新增 |
| `status: ACTIVE/ARCHIVED/NAME_CONFLICT` | `DRAFT/PUBLISHED/ARCHIVED` | `ARCHIVED` 只作历史兼容，其他枚举语义需要迁移 |
| `owner` | `uploadedBy` | 可部分映射；Owner 语义需要明确 |
| `tags: Tag[]` | `tags: string[]` | 需要返回 Tag ID 和名称 |
| `currentVersion` | `latestVersion` | 可复用版本关系，但版本 DTO 字段不完整 |
| `installCount` | `installCount` | 直接映射 |
| `derivedFrom` | 无 | 新增 |
| `updatedBy` | 无 | 新增或从最新版本创建者推导 |
| 历史归档和名称冲突原因 | 无 | 归档字段只作兼容；名称冲突原因需要新增 |

### 7.5 Skill 详情

| 前端需要 | 后端现有 | 等级 | 判断和改动 |
| --- | --- | --- | --- |
| `GET /api/skills/{skillId}` | `GET /api/skills/{idOrSlug}` | B | 路径基本兼容；旧后端可继续允许 ID/slug，但响应 DTO 需要调整 |

旧详情已经包含：

- Skill 基础信息。
- 上传者。
- 最新版本。
- 最新版本 SHA-256。
- `readmeMd`。
- 最新版本文件树。

缺少：

- 独立的 `displayName`、`displayDescription`。
- Owner 和协作者。
- 派生来源链。
- 完整 `currentVersion` DTO。
- `contentHash`。
- 名称冲突原因和更新者。

因此可以复用查询和组装服务，但不能直接把旧响应交给 React 页面。

### 7.6 创建 Skill

| 前端需要 | 后端现有 | 等级 | 判断和改动 |
| --- | --- | --- | --- |
| `POST /api/skills` | `POST /api/skills` | B | 上传、ZIP 解析、OSS、数据库事务可复用；multipart 字段和业务校验需调整 |

主要差异：

| Desktop 请求 | 旧后端请求 |
| --- | --- |
| 单个 `file` ZIP | 支持 ZIP 或多文件 |
| `displayName` | `name` |
| `displayDescription` | `description` |
| 首版由服务端按北京时间生成日期版本 | 接受客户端传入 `version` |
| `tagIds[]`、`newTagNames[]` | 逗号分隔 `tags` |
| 可选派生来源 | 无 |
| 展示名称重复确认 | 无 |

建议保留旧后端 ZIP 解析、哈希计算、OSS 上传和事务逻辑，重新实现请求解析和
desktop 领域规则。服务端仍应重新解析 ZIP，并以服务端计算出的哈希为准。

### 7.7 修改展示信息

| 前端需要 | 后端现有 | 等级 | 判断和改动 |
| --- | --- | --- | --- |
| `PATCH /api/skills/{skillId}` | 已实现 | A | Owner 校验、展示字段和 Tag 替换在同一事务中完成 |

当前支持：

- Owner 修改展示名称、展示简介和 Tag。
- Tag 为可选项，最多 5 个。
- 同名展示名称二次确认。
- 更新 `updatedAt`；独立的展示信息审计模型后续再补。

### 7.8 版本历史、详情和发布

| 前端需要 | 后端现有 | 等级 | 判断和改动 |
| --- | --- | --- | --- |
| `GET /api/skills/{skillId}/versions` | 无 | C | `SkillVersion` 表已有，可新增查询接口 |
| `GET /api/skills/{skillId}/versions/{versionId}` | 无 | C | 版本、文件和 `readmeMd` 已有基础 |
| `POST /api/skills/{skillId}/versions` | 无 | C | OSS 和包处理可复用；需新增版本发布事务 |

发布新版本需要新增：

- `baseVersionId` 乐观并发检查。
- 日期版本必须等于服务端根据北京时间和历史版本计算出的下一版本。
- 同一 Skill 下版本号唯一。
- ZIP 内 `SKILL.md` 名称必须与目标 Skill 一致。
- `contentHash` 重复检查。
- 发布者成为协作者。
- 版本、最新版本指针和平台展示信息在一个事务中更新。

### 7.9 文件树和文件预览

| 前端需要 | 后端现有 | 等级 | 判断和改动 |
| --- | --- | --- | --- |
| 指定版本文件树 | 详情响应中包含最新版本文件树 | C | 文件表和映射逻辑可复用；需增加 `versionId` 路由 |
| 指定版本文本内容 | 最新版本文件内容接口 | C | OSS 读取和 ZIP 解包可复用；需按 `versionId` 查找对象 |

字段映射：

| Desktop | 旧后端 |
| --- | --- |
| `type: DIRECTORY` | `type: FOLDER` |
| `size` | `sizeBytes` |
| `sha256` | `checksumSha256` |
| `previewable` | 已计算 |
| 文件内容 `sha256` | 旧响应没有，需要补充 |

如果第一阶段只安装和展示当前版本，可以用兼容适配器复用最新版本接口；
一旦允许安装历史版本，就必须增加按 `versionId` 查询。

### 7.10 下载凭证

| 前端需要 | 后端现有 | 等级 | 判断和改动 |
| --- | --- | --- | --- |
| `POST .../{versionId}/download-tickets` | `GET /api/skills/{idOrSlug}/download` | B/C | OSS 签名 URL 可直接复用；必须支持指定版本并补齐返回字段 |

目标返回：

```json
{
  "code": 201,
  "data": {
    "url": "https://...",
    "expiresAt": "2026-07-24T10:00:00.000Z",
    "packageSha256": "sha256:...",
    "contentHash": "sha256:..."
  },
  "msg": "success"
}
```

旧后端当前只返回：

```json
{
  "url": "https://...",
  "expiresIn": 300
}
```

其中：

- URL 签发逻辑可以直接复用。
- `expiresIn` 可转换为绝对时间 `expiresAt`。
- `checksumSha256` 可映射为 `packageSha256`。
- `contentHash` 当前数据库没有独立权威字段，需要增加或从 `manifestJson` 迁移。
- 旧接口只能下载最新版本，必须改为指定 `versionId`。

这是第一阶段真实安装联调的核心接口。

### 7.11 安装事件和安装状态

| 前端需要 | 后端现有 | 等级 | 判断和改动 |
| --- | --- | --- | --- |
| `POST /api/installations/events` | 只有 `Skill.installCount` 字段 | C | 增加安装事件表、唯一 `eventId` 和幂等计数事务 |
| `GET .../installation-status` | 无 | C | Skill/Version 状态可复用，原因字段需新增 |
| `POST /api/installations/resolve` | 无 | C | 需要使用 `skillName + contentHash` 匹配 SkillVersion |

不能让客户端直接调用“安装次数 +1”，否则重试会重复计数。建议新增安装事件表，并对
`eventId` 建唯一索引，在同一事务中写事件和增加 `installCount`。

### 7.12 永久删除

| 前端需要 | 后端现有 | 等级 | 判断和改动 |
| --- | --- | --- | --- |
| Owner 永久删除 | `DELETE /api/skills/{idOrSlug}` | B | 保留硬删除语义，补齐 Owner 校验、关联记录事务删除和 OSS 清理结果 |

系统不提供归档或恢复。历史 `ARCHIVED` 数据只需保持只读兼容，后续通过独立迁移清理。

### 7.13 所有权和协作者

| 前端需要 | 后端现有 | 等级 | 判断和改动 |
| --- | --- | --- | --- |
| Owner | `Skill.createdBy` 可作为固定 Owner | B | 当前直接以 `createdBy` 校验固定 Owner |
| 协作者 | 无 | D | 需要关系表或可靠的版本发布者推导规则 |

当前不提供所有权转移，因此 `createdBy` 可以同时作为固定 Owner；如未来重新引入转移，需要单独 ADR 和数据迁移。

### 7.14 通知

| 前端需要 | 后端现有 | 等级 | 判断和改动 |
| --- | --- | --- | --- |
| 通知列表 | 无 | D | 新增通知表和分页接口 |
| 单条已读 | 无 | D | 新增 |
| 全部已读 | 无 | D | 新增 |

通知用于新版本发布和展示信息修改等弱提醒。可以放在第二阶段，不阻塞“登录—浏览—下载—安装”的第一条闭环。

## 8. 公共协议差异

### 8.1 成功响应

Desktop 目标：

```json
{
  "code": 200,
  "data": {},
  "msg": "success"
}
```

旧后端：直接返回业务对象，没有统一外层。

建议后端统一响应外层。`HttpSkillApi` 校验 HTTP 状态和 `code` 后，只把 `data`
返回给 React 组件。

### 8.2 错误响应

Desktop 目标：

```json
{
  "code": 409,
  "data": {
    "errorCode": "VERSION_CONFLICT"
  },
  "msg": "目标 Skill 已发布更新，请刷新后重试。"
}
```

旧后端：

```json
{
  "error": "UNAUTHENTICATED",
  "message": "Invalid or expired token"
}
```

短期可以由 `HttpSkillApi` 同时兼容两种错误；最终应由后端统一为 desktop 契约，
避免每个客户端重复维护映射。

### 8.3 鉴权

Desktop 使用：

```http
Authorization: Bearer <token>
```

旧后端已经支持 Bearer Token，可以复用。但还需要：

- 对写接口检查 scope，而不只是检查是否登录。
- 设计发布、永久删除、Owner 和管理员权限。
- desktop 退出时吊销当前 Bearer Token。
- 401 后清理本地失效 Token，并重新进入登录流程。

### 8.4 API Base URL

建议 desktop 使用构建环境变量，例如：

```text
VITE_API_BASE_URL=https://skills-api.example.com
```

浏览器开发环境可以直接 `fetch`。Tauri 正式环境需要确认 CSP、允许的网络域名和
后端 CORS 白名单。旧后端目前反射任意 Origin，正式环境应改成明确的允许列表。

## 9. 数据模型改造建议

### 9.1 可保留

- `User`
- `UserToken`
- `DeviceAuthSession`
- `Skill`
- `SkillVersion`
- `SkillFile`
- `Tag`
- `SkillTag`
- OSS bucket/object key
- package checksum

### 9.2 建议补充或调整

| 模型 | 建议 |
| --- | --- |
| `User` | 增加 `role`、部门路径、飞书同步时间 |
| `Skill` | 增加 `displayName`、`displayDescription`、名称冲突信息、`updatedBy`；历史归档字段仅兼容旧数据 |
| `SkillVersion` | 增加 `baseVersionId`、`contentHash`；历史撤回字段仅兼容旧数据 |
| `SkillCollaborator` | 新增 Skill 与用户的协作者关系 |
| `InstallationEvent` | 新增幂等安装事件 |
| `Notification` | 新增通知及已读时间 |
| `DerivedSkill` 或 Skill 自关联 | 保存直接派生来源 |

具体采用新增列还是独立审计表，应在实现前确定审计和历史追踪要求。

## 10. 推荐实施顺序

### 阶段一：打通真实安装闭环

优先级 P0：

1. 实现 desktop `HttpSkillApi` 公共请求、错误解析和 API Base URL。**已完成**
2. 接入飞书直接授权登录和 Bearer Token 会话存储。**已完成**
3. 对齐当前用户、Tag 和 Skill 列表 DTO。**已完成**
4. 对齐 Skill 详情和版本历史 DTO。**已完成**
5. 对齐指定版本文件树和文本预览。**已完成**
6. 增加指定版本下载凭证。
7. 让 Tauri 安装器使用真实签名 URL 和服务端包哈希。
8. 增加幂等安装事件上报。

阶段一验收：

```text
飞书登录
  → 浏览真实 Skill
  → 查看真实详情
  → 获取指定版本下载凭证
  → Rust 下载、校验并安装
  → 后端幂等记录安装事件
```

### 阶段二：发布和管理

优先级 P1：

1. 历史版本列表和版本详情。
2. 指定版本文件树和文件预览。**已提前完成**
3. 新建 Skill 契约升级。
4. 发布新版本。
5. 修改展示信息。**已完成**
6. 我的 Skill。
7. Owner 永久删除。

### 阶段三：协作治理

优先级 P2：

1. 协作者。
2. 通知。
3. 安装来源恢复和在线状态。
4. 管理员治理和名称冲突处理。

## 11. 第一阶段可采用的临时兼容策略

如果目标是尽快跑通真实后端，可以先由 `HttpSkillApi` 做少量兼容：

- 把旧 `{ error, message }` 转换为 `SkillApiError`。
- 把 `q` 映射为 desktop 的 `query`。
- 把旧 `name` 暂时同时映射到 `skillName` 和 `displayName`。
- 把旧 `description` 暂时同时映射到 `skillDescription` 和
  `displayDescription`。
- 把 `latestVersion` 映射到 `currentVersion`。
- 把 `checksumSha256` 映射到 `packageSha256`。
- 用 `expiresIn` 在客户端计算临时 `expiresAt`。
- 第一阶段只允许安装当前版本。

此策略只适合作为联调过渡。以下内容不能靠前端伪造：

- `contentHash`。
- Owner、协作者和管理员权限。
- 安装事件幂等。
- 历史版本下载。
- 通知。

## 12. 不建议的做法

- 不建议把旧网页 `apps/web/src/api/client.ts` 直接复制到 desktop。
- 不建议让 React 组件直接判断旧后端字段。
- 不建议把所有在线请求都放进 Rust；普通业务 HTTP 由 `HttpSkillApi` 处理，
  Rust 只负责需要本地权限的下载和安装。
- 不建议为迎合旧接口而删除 desktop 的版本和安装事件设计。
- 不建议把 Bearer Token 明文长期保存在普通日志或 `localStorage`。
- 不建议由客户端提供并决定包哈希、内容哈希或安装次数。

## 13. 最终推荐架构

```text
React 页面
  → SkillApi
    → MockSkillApi（浏览器开发和测试）
    → HttpSkillApi（真实在线平台）
      → Kocotree Fastify API
        → Prisma/PostgreSQL
        → 阿里云 OSS

安装协调流程
  → HttpSkillApi 获取下载凭证
  → TauriInstaller
    → Rust 下载、SHA-256 校验、安全解压和本地写入
  → HttpSkillApi 幂等上报安装事件
```

后端继续作为在线数据的唯一事实来源；Tauri/Rust 作为本地文件系统事实来源；
React 只负责页面状态和流程协调。

## 14. 总体判断

现有后端不是废弃重写对象，而是 desktop 后端的基础版本：

- 认证、数据库、OSS、Skill 包处理和最新版查询具备较高复用价值。
- 列表、详情、上传、下载和预览需要契约升级。
- 版本治理、安装事件、协作者和通知需要继续建设。

最稳妥的方向是：

> 保留 `Kocotree-skills-repository` 的后端实现和基础设施，以
> `kocotree-skills-desktop/docs/openapi.yaml` 为目标契约逐步升级，
> desktop 通过单一 `HttpSkillApi` 接入。
