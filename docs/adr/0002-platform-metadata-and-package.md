# ADR-0002：平台元数据与原始包分离

- 状态：部分被 ADR-0005 取代
- 日期：2026-07-15

> ADR-0005 已取代协作者可以修改平台展示信息的权限规则。当前仅 Owner 可以修改 `displayName`、`displayDescription` 和 Tag。

## 背景

`SKILL.md` 中的名称和描述适合 Agent 读取，但不一定适合作为平台展示文案。若平台直接改写用户上传的 ZIP，下载内容将不再是上传原件；若只使用手工字段，又容易失去 Skill 的稳定身份。

## 决策

- 从 `SKILL.md` frontmatter 提取 `skillName` 和 `skillDescription`。
- `skillName` 是平台全局唯一身份，创建后不可修改。
- 平台单独保存 `displayName`、`displayDescription` 和 Tag。
- `displayName`、`displayDescription` 和 Tag 只允许当前 Owner 修改。
- 平台信息修改不创建 SkillVersion，也不写回 ZIP 或 `SKILL.md`，但保留更新者、时间和变更字段审计。
- 原始 ZIP 与每个版本的 `SKILL.md` 快照不可变。
- 发布新版本时，ZIP 中的 `skillName` 必须与 Skill 聚合一致。版本请求可以携带调用者有权修改的平台信息，并与版本创建使用同一事务。
- 新版本的 `skillDescription` 发生变化且发布者没有明确提交展示简介时，平台同步 `displayDescription`。
- 未识别的 frontmatter 字段原样保留在包内，不进入核心 Skill 实体。
- 展示名称不参与版本匹配，也不决定本地目录。

## 结果

### 正面影响

- 上传原件可验证、可追溯。
- 平台可以使用更友好的中文展示信息。
- 改名不会破坏版本历史和本地安装路径。

### 代价

- 详情页需要同时解释 Skill 名称和展示名称。
- Skill 描述与展示简介可能不同，接口必须清晰区分。

## 后续约束

- API 不得使用含义不明的单一 `name` 或 `description` 字段同时表示两类信息。
- 创建和更新响应必须同时提供 Skill 信息与平台信息。
- 发现 Skill 名称冲突时不得自动覆盖或合并。
