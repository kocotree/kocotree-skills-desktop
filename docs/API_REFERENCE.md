# Kocotree Skills API 参考

## 1. 文档状态

本文档定义 Kocotree Skills 前端、模拟接口和未来真实后端共同遵守的 Skill 领域 HTTP 契约。权威机器可读定义为 [`openapi.yaml`](./openapi.yaml)。接口路径直接使用 `/api/...`，不增加 `/v1` 中间层。

ZIP 本地解析和平台版本安装属于客户端能力，不通过服务端 Skill DTO 表达。安装过程内部使用的目标校验、冲突备份和失败回滚也不属于 HTTP API。任意本地 Skill 扫描、来源识别、移除、手动恢复和 Claude 链接管理不在当前范围。登录协议和令牌生命周期由认证接入方负责，本契约只约定需要身份的请求携带 Bearer Token。

## 2. 公共约定

- JSON 使用 UTF-8。
- 时间使用带时区的 ISO 8601 字符串。
- 标识符是服务端生成的不透明字符串。
- 认证使用 `Authorization: Bearer <token>`。
- 登录方式、令牌获取、刷新、持久化和退出由后续认证接入方定义，不属于当前前端 Skill API 契约。
- 所有 HTTP 响应统一包含 `code`、`data`、`msg` 三个顶层字段。
- `code` 是数字，并与 HTTP 响应状态码一致；普通成功为 `200`，资源创建成功为 `201`，请求失败使用对应的 `4xx` 或 `5xx`。
- 成功响应的业务数据放在 `data`，`msg` 固定为 `success`。
- 失败响应的 Mock 业务错误码放在 `data.errorCode`，其他错误详情也放在 `data`，用户可读信息放在 `msg`。
- 列表使用 `page`、`pageSize`，分页结果在 `data` 中返回 `items`、`page`、`pageSize`、`total`。
- ZIP 发布使用 `multipart/form-data`。
- 新建和发布版本由服务端重新解析 ZIP 并计算权威哈希。
- 平台展示信息采用后提交覆盖前提交；版本发布使用 `baseVersionId` 检查并发。

成功响应：

```json
{
  "code": 200,
  "data": {
    "id": "skill_123"
  },
  "msg": "success"
}
```

无业务数据的成功响应使用空对象：

```json
{
  "code": 200,
  "data": {},
  "msg": "success"
}
```

失败响应：

```json
{
  "code": 409,
  "data": {
    "errorCode": "VERSION_CONFLICT",
    "expectedVersionId": "ver_142",
    "currentVersionId": "ver_143"
  },
  "msg": "目标 Skill 已发布更新，请刷新后重试。"
}
```

## 3. 鉴权与权限

| 能力 | 匿名 | 登录用户 | 协作者 | Owner | 管理员 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 浏览公开 Skill、版本、Tag、文件树 | 否 | 是 | 是 | 是 | 是 |
| 安装与安装上报 | 否 | 是 | 是 | 是 | 是 |
| 创建 Skill | 否 | 是 | 是 | 是 | 是 |
| 发布 ACTIVE Skill 新版本 | 否 | 是 | 是 | 是 | 是 |
| 发布 ARCHIVED Skill 新版本 | 否 | 否 | 是 | 是 | 是 |
| 修改展示简介、Tags | 否 | 否 | 是 | 是 | 是 |
| 修改展示名称 | 否 | 否 | 否 | 是 | 否 |
| 撤回自己的非首版版本 | 否 | 是 | 是 | 是 | 是 |
| 撤回任意非首版版本 | 否 | 否 | 否 | 是 | 是 |
| 归档、恢复 Skill | 否 | 否 | 否 | 是 | 是 |
| 正常发起所有权转移 | 否 | 否 | 否 | 是 | 否 |
| 处理停用 Owner | 否 | 否 | 否 | 否 | 是 |

管理员不能在有效 Owner 存在时强制转移所有权，也不能直接修改该 Skill 的展示名称。

除飞书登录入口、OAuth 回调、桌面一次性换码和健康检查外，所有业务接口都必须携带
`Authorization: Bearer <token>`。

## 4. 核心 DTO

### 4.1 User

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | ---: | --- |
| `id` | `string` | 是 | 平台用户标识。 |
| `name` | `string` | 是 | 飞书姓名，只读。 |
| `avatarUrl` | `string \| null` | 是 | 飞书头像。 |
| `departmentPath` | `string[]` | 是 | 飞书部门层级路径。 |
| `status` | `ACTIVE \| DISABLED` | 是 | 飞书账号状态。 |
| `role` | `USER \| ADMIN` | 是 | 平台角色。 |
| `syncedAt` | `string` | 是 | 最近同步时间。 |

飞书 `openId` 是服务端身份映射字段，不在公开 User DTO 中返回。

### 4.2 Tag

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | ---: | --- |
| `id` | `string` | 是 | 稳定标识。 |
| `name` | `string` | 是 | 展示名称。 |

Tag 治理规则暂缓。单个 Skill 最多关联 5 个 Tag。

### 4.3 SkillVersion

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | ---: | --- |
| `id` | `string` | 是 | 版本标识。 |
| `skillId` | `string` | 是 | 所属 Skill。 |
| `version` | `string` | 是 | SemVer。 |
| `status` | `PUBLISHED \| WITHDRAWN` | 是 | 版本状态。 |
| `skillName` | `string` | 是 | 此版本 `SKILL.md` 的名称。 |
| `skillDescription` | `string` | 是 | 此版本 `SKILL.md` 的描述。 |
| `changelog` | `string` | 是 | 不可变更新说明。 |
| `baseVersionId` | `string \| null` | 是 | 发布依据；`1.0.0` 为 `null`。 |
| `packageSize` | `integer` | 是 | ZIP 字节数。 |
| `packageSha256` | `string` | 是 | ZIP SHA-256。 |
| `contentHash` | `string` | 是 | 规范化目录内容哈希。 |
| `uploadedBy` | `User` | 是 | 实际上传者。 |
| `publishedAt` | `string` | 是 | 发布时间。 |
| `withdrawnBy` | `User \| null` | 是 | 撤回人。 |
| `withdrawnAt` | `string \| null` | 是 | 撤回时间。 |
| `withdrawalReason` | `string \| null` | 是 | 撤回原因。 |

`SkillVersionDetail` 在此基础上增加原始 `skillMd`。

### 4.4 SkillSummary

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | ---: | --- |
| `id` | `string` | 是 | Skill 标识。 |
| `skillName` | `string` | 是 | 全局唯一且不可修改。 |
| `displayName` | `string` | 是 | 平台展示名称。 |
| `skillDescription` | `string` | 是 | 当前可用版本原始描述。 |
| `displayDescription` | `string` | 是 | 平台展示简介。 |
| `status` | `ACTIVE \| ARCHIVED \| NAME_CONFLICT` | 是 | 在线状态。 |
| `owner` | `User` | 是 | 当前 Owner。 |
| `tags` | `Tag[]` | 是 | 最多 5 个。 |
| `currentVersion` | `SkillVersion` | 是 | 最高 `PUBLISHED` 版本。 |
| `installCount` | `integer` | 是 | 成功安装操作总数。 |
| `derivedFrom` | `DerivedSource \| null` | 是 | 直接派生来源。 |
| `updatedBy` | `User` | 是 | 最近版本或平台信息更新者。 |
| `archivedAt` | `string \| null` | 是 | 归档时间。 |
| `archiveReason` | `string \| null` | 是 | 归档原因。 |
| `nameConflictReason` | `string \| null` | 是 | 名称冲突说明。 |
| `createdAt` | `string` | 是 | 创建时间。 |
| `updatedAt` | `string` | 是 | 最近更新时间。 |

`DerivedSource` 包含来源 `skillId`、`skillName`、版本编号、来源状态和是否可打开公开详情。

### 4.5 SkillDetail

`SkillDetail` 包含 `SkillSummary` 全部字段，并增加：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | ---: | --- |
| `collaborators` | `User[]` | 是 | 成功发布过版本、且不等于当前 Owner 的用户。 |
| `derivedChain` | `DerivedSource[]` | 是 | 从直接来源到根来源的链路。 |

协作者排序和前 8 个头像属于前端显示规则，接口返回完整列表。

### 4.6 FileEntry

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | ---: | --- |
| `path` | `string` | 是 | 规范化相对路径。 |
| `type` | `FILE \| DIRECTORY` | 是 | 条目类型。 |
| `size` | `integer \| null` | 是 | 文件字节数。 |
| `sha256` | `string \| null` | 是 | 普通文件哈希。 |
| `previewable` | `boolean` | 是 | 是否支持文本预览。 |

### 4.7 本地安装边界

以下信息只属于客户端安装流程，不进入 Skill DTO：

- 安装目标路径
- 同名目录冲突状态
- 覆盖确认状态
- 内部备份和失败回滚结果
- 安装凭证写入结果

## 5. 当前用户

```http
GET /api/users/me
Authorization: Bearer <token>
```

返回 `ApiResponse<User>`。

## 6. Tag

### 6.1 获取 Tag

```http
GET /api/tags?query=开发
```

需要登录，返回 `ApiResponse<Tag[]>`。创建 Tag 通过 Skill 创建、版本发布或平台信息修改请求中的 `newTagNames` 完成。

## 7. Skill 查询

### 7.1 Skill 列表

```http
GET /api/skills?query=review&tagId=tag_dev&sort=UPDATED_DESC&page=1&pageSize=20
```

排序枚举：`UPDATED_DESC`、`CREATED_DESC`、`INSTALLS_DESC`。

公开列表不返回 `ARCHIVED` 或 `NAME_CONFLICT`。两种状态仅通过在线管理列表和已安装客户端状态查询返回。

### 7.2 Skill 详情

```http
GET /api/skills/{skillId}
```

公开访问 `ARCHIVED` 返回 `404 SKILL_NOT_FOUND`。Owner、协作者或管理员携带令牌时可以读取归档管理详情。

### 7.3 版本历史

```http
GET /api/skills/{skillId}/versions?page=1&pageSize=20
```

返回 `ApiResponse<VersionPage>`，其中包含 `PUBLISHED` 与 `WITHDRAWN` 版本，并按 SemVer 降序。公开访问归档 Skill 返回不存在。

### 7.4 版本详情

```http
GET /api/skills/{skillId}/versions/{versionId}
```

返回 `ApiResponse<SkillVersionDetail>`，包括原始 `skillMd`。

### 7.5 文件树

```http
GET /api/skills/{skillId}/versions/{versionId}/files
```

返回 `ApiResponse<FileEntry[]>`，`data` 是该版本的完整文件树。

### 7.6 文本文件内容

```http
GET /api/skills/{skillId}/versions/{versionId}/files/content?path=references%2Fguide.md
```

只返回 `previewable=true` 的文件：

```json
{
  "code": 200,
  "data": {
    "path": "references/guide.md",
    "content": "# Guide\n",
    "sha256": "sha256:..."
  },
  "msg": "success"
}
```

### 7.7 我的在线 Skill

```http
GET /api/users/me/skills?relation=OWNED&page=1&pageSize=20
```

`relation` 支持 `OWNED`、`COLLABORATED`、`ARCHIVED`。该接口只返回在线平台关系，不表达本地安装目录。

## 8. 创建、更新和平台信息

### 8.1 创建 Skill

```http
POST /api/skills
Content-Type: multipart/form-data
Authorization: Bearer <token>
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | ---: | --- |
| `file` | ZIP | 是 | 原始 ZIP。 |
| `displayName` | `string` | 是 | 平台展示名称。 |
| `displayDescription` | `string` | 是 | 平台展示简介。 |
| `tagIds` | `string[]` | 否 | 已有 Tag。 |
| `newTagNames` | `string[]` | 否 | 新 Tag 名称。 |
| `confirmDuplicateDisplayName` | `boolean` | 否 | 确认展示名称重名。 |
| `forkedFromSkillId` | `string` | 否 | 派生来源 Skill。 |
| `forkedFromVersionId` | `string` | 否 | 派生来源版本。 |

来源字段必须同时出现。服务端固定创建 `1.0.0`，更新说明为“首次发布”。重名展示名称返回需要确认的业务错误，客户端确认后使用 `confirmDuplicateDisplayName=true` 重试。

`tagIds` 与 `newTagNames` 使用重复表单字段传递，每个数组元素对应一个同名字段。例如：

```text
tagIds=tag_dev&tagIds=tag_tool&newTagNames=效率
```

响应 `201 ApiResponse<SkillDetail>`。

### 8.2 发布新版本

```http
POST /api/skills/{skillId}/versions
Content-Type: multipart/form-data
Authorization: Bearer <token>
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | ---: | --- |
| `file` | ZIP | 是 | 原始 ZIP。 |
| `baseVersionId` | `string` | 是 | 当前版本标识。 |
| `version` | `string` | 是 | 更高 SemVer。 |
| `changelog` | `string` | 是 | 不可变更新说明。 |
| `displayName` | `string` | 否 | 仅 Owner 可提交。 |
| `displayDescription` | `string` | 否 | Owner 或协作者可提交。 |
| `tagIds` | `string[]` | 否 | 出现时完整替换 Tag 关联。 |
| `newTagNames` | `string[]` | 否 | 新 Tag 名称。 |
| `confirmDuplicateDisplayName` | `boolean` | 否 | Owner 确认展示名称重名。 |

任何登录用户可以更新 `ACTIVE` Skill；`ARCHIVED` 只允许 Owner、已有协作者和管理员。首次更新者在同一事务成功后成为协作者并可应用展示简介与 Tags。任何字段失败都会回滚整个请求。

`tagIds` 与 `newTagNames` 的编码方式与创建 Skill 相同，均使用重复表单字段。

响应 `201 ApiResponse<SkillDetail>`。

### 8.3 修改平台信息

```http
PATCH /api/skills/{skillId}
Content-Type: application/json
Authorization: Bearer <token>
```

```json
{
  "displayName": "代码审查助手",
  "displayDescription": "检查代码和配置变更。",
  "tagIds": ["tag_dev"],
  "newTagNames": [],
  "confirmDuplicateDisplayName": false
}
```

请求至少包含一个可修改字段。`displayName` 仅 Owner 可改；展示简介和 Tags 允许 Owner 与协作者修改。修改不创建版本，采用后提交覆盖前提交。修改为重名展示名称时，客户端确认后携带 `confirmDuplicateDisplayName=true` 重试。

## 9. 撤回、归档与恢复

### 9.1 撤回版本

```http
POST /api/skills/{skillId}/versions/{versionId}/withdraw
Authorization: Bearer <token>
```

```json
{
  "reason": "该版本包含错误的操作指引。"
}
```

`1.0.0` 返回 `INITIAL_VERSION_REQUIRED`。撤回不可逆，响应为 `ApiResponse<SkillVersion>`。

### 9.2 归档 Skill

```http
POST /api/skills/{skillId}/archive
Authorization: Bearer <token>
```

```json
{
  "reason": "该 Skill 已停止维护。"
}
```

仅 Owner 或管理员可用，原因必填且不可修改。

### 9.3 恢复 Skill

```http
POST /api/skills/{skillId}/restore
Authorization: Bearer <token>
```

```json
{
  "reason": "维护工作已经恢复。"
}
```

不强制先发布新版本，响应为 `ApiResponse<SkillDetail>`。

### 9.4 已安装客户端查询状态

```http
GET /api/skills/{skillId}/installation-status?versionId={versionId}
```

该接口必须登录并携带 Bearer Token。`versionId` 来自本地安装凭证，可选。响应不返回 ZIP、下载地址或完整平台展示信息。

归档且本地安装版本已撤回时返回：

```json
{
  "code": 200,
  "data": {
    "skillId": "skill_123",
    "status": "ARCHIVED",
    "archivedAt": "2026-07-17T10:00:00+08:00",
    "archiveReason": "该 Skill 已停止维护。",
    "nameConflictReason": null,
    "versionStatus": "WITHDRAWN",
    "withdrawalReason": "该版本包含错误的安装说明。",
    "recommendedVersion": {
      "id": "version_456",
      "version": "1.2.0"
    }
  },
  "msg": "success"
}
```

在线状态查询失败属于临时状态，客户端保留安装凭证和本地记录并显示“在线信息不可用”，不得自动改为 `LOCAL_UNKNOWN`。

## 10. 所有权转移

### 10.1 发起邀请

```http
POST /api/skills/{skillId}/ownership-transfers
Authorization: Bearer <token>
```

```json
{
  "targetUserId": "user_456",
  "reason": "原 Owner 账号已停用。"
}
```

有效 Owner 只能选择已有协作者，`reason` 可选。管理员只能处理停用 Owner，必须填写原因；没有协作者时可以选择任意登录过平台的活跃用户。

### 10.2 接受、拒绝和取消

```http
POST /api/ownership-transfers/{transferId}/accept
POST /api/ownership-transfers/{transferId}/reject
POST /api/ownership-transfers/{transferId}/cancel
```

邀请 7 天后自动过期。同一 Skill 同时只能存在一个 `PENDING` 邀请。

## 11. 下载与安装上报

### 11.1 获取下载凭证

```http
POST /api/skills/{skillId}/versions/{versionId}/download-tickets
Authorization: Bearer <token>
```

只允许 `PUBLISHED` 版本。响应：

```json
{
  "code": 201,
  "data": {
    "url": "https://download.example.test/file.zip",
    "expiresAt": "2026-07-17T10:05:00+08:00",
    "packageSha256": "sha256:...",
    "contentHash": "sha256:..."
  },
  "msg": "success"
}
```

### 11.2 平台匹配接口

```http
POST /api/installations/resolve
Authorization: Bearer <token>
```

```json
{
  "skillName": "code-review",
  "contentHash": "sha256:..."
}
```

匹配成功返回 `skillId`、`versionId` 和在线状态；归档 Skill 只返回最小归档状态。此操作不增加安装次数。

该服务端接口保留在在线契约中，当前客户端安装流程不调用。

### 11.3 上报安装成功

```http
POST /api/installations/events
Authorization: Bearer <token>
```

```json
{
  "eventId": "01J...",
  "skillId": "skill_123",
  "versionId": "ver_143",
  "installedAt": "2026-07-17T10:02:00+08:00"
}
```

相同 `eventId` 重试返回成功但不重复计数。凭证恢复、下载失败、取消和安装失败不上报。

## 12. 通知

### 12.1 获取通知

```http
GET /api/notifications?page=1&pageSize=20&unreadOnly=true
Authorization: Bearer <token>
```

通知包含版本发布、展示信息修改、所有权邀请和状态变化。客户端只显示弱提醒红点。

### 12.2 标记已读

```http
POST /api/notifications/{notificationId}/read
POST /api/notifications/read-all
```

两个接口均返回 `200 ApiResponse<{}>`。

## 13. 常见错误码

表中的 HTTP 数字同时是响应体的 `code`，错误码字符串位于 `data.errorCode`。

| HTTP | 错误码 | 说明 |
| ---: | --- | --- |
| 400 | `INVALID_REQUEST` | 请求字段不合法。 |
| 400 | `INVALID_SKILL_PACKAGE` | ZIP 损坏、结构不合法或 `SKILL.md` 元数据无效。 |
| 400 | `INVALID_SEMVER` | 版本号不是合法 SemVer。 |
| 400 | `VERSION_NOT_GREATER` | 版本号未高于最高历史版本。 |
| 400 | `CONTENT_UNCHANGED` | 内容与历史版本一致。 |
| 400 | `INITIAL_VERSION_REQUIRED` | `1.0.0` 不允许撤回。 |
| 401 | `UNAUTHENTICATED` | 当前请求没有可用的登录身份。 |
| 403 | `FORBIDDEN` | 当前用户无权执行操作。 |
| 403 | `USER_DISABLED` | 当前用户账号已停用。 |
| 403 | `OWNER_REQUIRED` | 当前操作仅允许 Owner 或指定管理员执行。 |
| 403 | `COLLABORATOR_REQUIRED` | 目标用户不是当前 Skill 的有效协作者。 |
| 404 | `SKILL_NOT_FOUND` | Skill 不存在或公开不可见。 |
| 404 | `VERSION_NOT_FOUND` | 版本不存在。 |
| 404 | `FILE_NOT_FOUND` | 版本文件或文件清单不存在。 |
| 404 | `TRANSFER_NOT_FOUND` | 所有权转移邀请不存在。 |
| 409 | `DUPLICATE_SKILL_NAME` | `skillName` 已被占用。 |
| 409 | `DISPLAY_NAME_CONFIRMATION_REQUIRED` | 展示名称重名，需要确认。 |
| 409 | `VERSION_CONFLICT` | `baseVersionId` 已过期。 |
| 409 | `VERSION_ALREADY_EXISTS` | 相同 SemVer 版本号已经存在。 |
| 409 | `SKILL_NAME_MISMATCH` | 更新 ZIP 名称与目标 Skill 不一致。 |
| 409 | `SKILL_UNAVAILABLE` | Skill 已归档或名称冲突，当前操作不可用。 |
| 409 | `INSTALLATION_UNAVAILABLE` | 当前 Skill 或版本不可安装。 |
| 409 | `TRANSFER_RESOLVED` | 所有权转移邀请已经处理。 |
| 413 | `PACKAGE_TOO_LARGE` | ZIP 超过文件大小、数量或解压大小限制。 |
| 415 | `FILE_PREVIEW_UNAVAILABLE` | 文件不是受支持的 UTF-8 文本预览类型。 |
| 422 | `PACKAGE_HASH_MISMATCH` | 服务端或客户端下载校验失败。 |

本地安装适配器另外使用以下客户端错误码，不属于 HTTP API 响应：

| 错误码 | 说明 |
| --- | --- |
| `DOWNLOAD_URL_INVALID` | 下载地址格式无效。 |
| `DOWNLOAD_URL_UNSUPPORTED` | 下载地址不是受支持的 HTTP、HTTPS 或 Mock data URL。 |
| `DOWNLOAD_FAILED` | 安装包下载或读取失败。 |
| `PACKAGE_TOO_LARGE` | 下载包、解压总大小或文件数量超过限制。 |
| `PACKAGE_HASH_MISMATCH` | 下载字节的 SHA-256 与凭证不一致。 |
| `INVALID_SKILL_PACKAGE` | ZIP 结构、路径或 `SKILL.md` 不合法。 |
| `SKILL_NAME_MISMATCH` | `SKILL.md` 名称与目标 Skill 不一致。 |
| `LOCAL_SKILL_CONFLICT` | 目标目录已经存在，当前真实安装器停止写入。 |
| `LOCAL_INSTALL_IO_ERROR` | 创建目录、解压文件或最终移动失败。 |
| `HOME_DIRECTORY_UNAVAILABLE` | 无法解析当前用户主目录。 |

Mock 安装器保留 `INSTALL_ROLLBACK_COMPLETED` 场景，用于验证未来覆盖失败提示；当前真实安装器不覆盖已有目录。

## 14. TypeScript DTO 示例

```ts
export interface ApiResponse<T> {
  code: 200 | 201;
  data: T;
  msg: string;
}

export interface ApiErrorData {
  errorCode: string;
  [key: string]: unknown;
}

export interface ApiErrorResponse {
  code: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 500;
  data: ApiErrorData;
  msg: string;
}

export interface UserDto {
  id: string;
  name: string;
  avatarUrl: string | null;
  departmentPath: string[];
  status: "ACTIVE" | "DISABLED";
  role: "USER" | "ADMIN";
  syncedAt: string;
}

export interface SkillVersionDto {
  id: string;
  skillId: string;
  version: string;
  status: "PUBLISHED" | "WITHDRAWN";
  skillName: string;
  skillDescription: string;
  changelog: string;
  baseVersionId: string | null;
  packageSize: number;
  packageSha256: string;
  contentHash: string;
  uploadedBy: UserDto;
  publishedAt: string;
  withdrawnBy: UserDto | null;
  withdrawnAt: string | null;
  withdrawalReason: string | null;
}

export interface TagDto {
  id: string;
  name: string;
}

export interface DerivedSourceDto {
  skillId: string;
  skillName: string;
  versionId: string;
  version: string;
  status: "ACTIVE" | "ARCHIVED" | "NAME_CONFLICT";
  linkable: boolean;
}

export interface SkillSummaryDto {
  id: string;
  skillName: string;
  displayName: string;
  skillDescription: string;
  displayDescription: string;
  status: "ACTIVE" | "ARCHIVED" | "NAME_CONFLICT";
  owner: UserDto;
  tags: TagDto[];
  currentVersion: SkillVersionDto;
  installCount: number;
  derivedFrom: DerivedSourceDto | null;
  updatedBy: UserDto;
  archivedAt: string | null;
  archiveReason: string | null;
  nameConflictReason: string | null;
  createdAt: string;
  updatedAt: string;
}
```

实际前端类型应从 OpenAPI 生成，不手工复制这段示例。

## 15. 模拟接口要求

- 模拟实现与真实 HTTP 客户端实现同一 TypeScript 应用接口；HTTP 客户端校验响应 `code` 后向页面返回 `data`。
- 覆盖登录后浏览、登录恢复动作、新建、更新、并发冲突、撤回、归档、所有权邀请、历史版本安装和安装上报。
- 模拟数据不能被 React 组件直接导入。
- 本地安装状态与服务端 DTO 明确隔离。
