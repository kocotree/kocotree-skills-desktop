import type {
  FileEntryDto,
  NotificationDto,
  SkillDetailDto,
  SkillVersionDto,
  TagDto,
  UserDto,
} from "./contracts";

export interface MockVersionFileSource {
  files: FileEntryDto[];
  contents: Record<string, string>;
  skillMd: string;
}

const syncedAt = "2026-07-17T02:00:00.000Z";

export const mockUsers = {
  current: {
    id: "4e6ee36b-e6ed-4400-b304-89f22c0527d1",
    name: "鸭腿",
    avatarUrl: null,
    departmentPath: ["运营中心", "运营办"],
    status: "ACTIVE",
    role: "ADMIN",
    syncedAt,
  },
  lin: {
    id: "4e6ee36b-e6ed-4400-b304-89f22c0527d2",
    name: "林晓",
    avatarUrl: null,
    departmentPath: ["产品中心", "协作产品组"],
    status: "ACTIVE",
    role: "USER",
    syncedAt,
  },
  chen: {
    id: "4e6ee36b-e6ed-4400-b304-89f22c0527d3",
    name: "陈默",
    avatarUrl: null,
    departmentPath: ["数据中心", "分析组"],
    status: "ACTIVE",
    role: "USER",
    syncedAt,
  },
  disabled: {
    id: "4e6ee36b-e6ed-4400-b304-89f22c0527d4",
    name: "周舟",
    avatarUrl: null,
    departmentPath: ["研发中心", "平台组"],
    status: "DISABLED",
    role: "USER",
    syncedAt,
  },
} satisfies Record<string, UserDto>;

const mockDataTag: TagDto = {
  id: "2bb6b0f2-96f9-49e1-8c2c-a92503171008",
  name: "Mock",
};

export const mockTags: TagDto[] = [
  { id: "2bb6b0f2-96f9-49e1-8c2c-a92503171001", name: "代码审查" },
  { id: "2bb6b0f2-96f9-49e1-8c2c-a92503171002", name: "内容处理" },
  { id: "2bb6b0f2-96f9-49e1-8c2c-a92503171003", name: "数据分析" },
  { id: "2bb6b0f2-96f9-49e1-8c2c-a92503171004", name: "开发工具" },
  { id: "2bb6b0f2-96f9-49e1-8c2c-a92503171005", name: "项目协作" },
  { id: "2bb6b0f2-96f9-49e1-8c2c-a92503171006", name: "安全" },
  { id: "2bb6b0f2-96f9-49e1-8c2c-a92503171007", name: "安装异常" },
  mockDataTag,
];

const packageHash = `sha256:${"a".repeat(64)}`;
const contentHash = `sha256:${"b".repeat(64)}`;

/**
 * 功能说明：创建符合最新接口契约的模拟版本。
 * @param skillId - 版本所属 Skill ID。
 * @param id - 版本 ID。
 * @param version - Skill 版本号；历史数据可能仍使用旧版 SemVer。
 * @param skillName - SKILL.md 中的名称。
 * @param skillDescription - SKILL.md 中的简介。
 * @param publishedAt - 发布时间。
 * @param uploadedBy - 实际发布用户。
 * @param changelog - 版本更新说明。
 * @param baseVersionId - 本版本基于的历史版本 ID。
 * @returns 完整的模拟版本记录。
 */
function createVersion(
  skillId: string,
  id: string,
  version: string,
  skillName: string,
  skillDescription: string,
  publishedAt: string,
  uploadedBy: UserDto,
  changelog: string,
  baseVersionId: string | null = null,
): SkillVersionDto {
  return {
    id,
    skillId,
    version,
    status: "PUBLISHED",
    skillName,
    skillDescription,
    changelog,
    baseVersionId,
    packageSize: 12_042,
    packageSha256: packageHash,
    contentHash: `${contentHash}-${id.slice(-4)}`,
    uploadedBy,
    publishedAt,
    withdrawnBy: null,
    withdrawnAt: null,
    withdrawalReason: null,
  };
}

export const skillIds = {
  codeReview: "0c9c2f8d-3e84-4c0c-8a15-d41d87fd1001",
  meetingNotes: "0c9c2f8d-3e84-4c0c-8a15-d41d87fd1002",
  dataInsight: "0c9c2f8d-3e84-4c0c-8a15-d41d87fd1003",
  apiDoc: "0c9c2f8d-3e84-4c0c-8a15-d41d87fd1004",
  weeklyReport: "0c9c2f8d-3e84-4c0c-8a15-d41d87fd1005",
  sqlChecker: "0c9c2f8d-3e84-4c0c-8a15-d41d87fd1006",
  archived: "0c9c2f8d-3e84-4c0c-8a15-d41d87fd1007",
  localConflict: "0c9c2f8d-3e84-4c0c-8a15-d41d87fd1008",
  localModified: "0c9c2f8d-3e84-4c0c-8a15-d41d87fd1009",
  downgrade: "0c9c2f8d-3e84-4c0c-8a15-d41d87fd1010",
  derivedOverlap: "0c9c2f8d-3e84-4c0c-8a15-d41d87fd1011",
  packageHash: "0c9c2f8d-3e84-4c0c-8a15-d41d87fd1012",
  rollback: "0c9c2f8d-3e84-4c0c-8a15-d41d87fd1013",
  claudeLink: "0c9c2f8d-3e84-4c0c-8a15-d41d87fd1014",
  nameConflict: "0c9c2f8d-3e84-4c0c-8a15-d41d87fd1015",
  withdrawn: "0c9c2f8d-3e84-4c0c-8a15-d41d87fd1016",
} as const;

export interface MockInstallScenario {
  downloadError?: { code: string; message: string };
  forcedInstallError?: { code: string; message: string };
  completionNotices?: string[];
}

/** 安装异常演示卡片对应的模拟行为配置。 */
export const mockInstallScenarios: Partial<Record<string, MockInstallScenario>> = {
  [skillIds.packageHash]: {
    downloadError: { code: "PACKAGE_HASH_MISMATCH", message: "安装包校验失败，下载内容与平台版本记录不一致" },
  },
  [skillIds.rollback]: {
    forcedInstallError: { code: "INSTALL_ROLLBACK_COMPLETED", message: "目录替换失败，原 Skill 已自动恢复" },
  },
  [skillIds.claudeLink]: {
    completionNotices: [
      "检测到 ~/.claude/skills 非空，未创建 Claude 目录链接。",
      "Codex 已可使用该 Skill；Claude 需要按照迁移说明手工整理原目录。",
    ],
  },
};

/** 将模拟历史版本标记为已撤回。 */
function markVersionWithdrawn(version: SkillVersionDto, reason: string): SkillVersionDto {
  return {
    ...version,
    status: "WITHDRAWN",
    withdrawnBy: mockUsers.current,
    withdrawnAt: "2026-07-12T08:30:00.000Z",
    withdrawalReason: reason,
  };
}

export const mockVersions: Record<string, SkillVersionDto[]> = {
  [skillIds.codeReview]: [
    createVersion(skillIds.codeReview, "8b37c0a5-f1c9-4f4e-a71b-b6f06f671001", "1.4.2", "code-review", "Review code changes against project rules.", "2026-07-15T01:40:00.000Z", mockUsers.current, "补充 TypeScript 与 Rust 审查规则", "8b37c0a5-f1c9-4f4e-a71b-b6f06f671011"),
    createVersion(skillIds.codeReview, "8b37c0a5-f1c9-4f4e-a71b-b6f06f671011", "1.3.0", "code-review", "Review code changes against project rules.", "2026-07-01T08:20:00.000Z", mockUsers.lin, "优化审查结果结构"),
  ],
  [skillIds.meetingNotes]: [createVersion(skillIds.meetingNotes, "8b37c0a5-f1c9-4f4e-a71b-b6f06f671002", "2.1.0", "meeting-notes", "Turn meeting records into decisions and action items.", "2026-07-14T08:25:00.000Z", mockUsers.lin, "增加风险清单")],
  [skillIds.dataInsight]: [createVersion(skillIds.dataInsight, "8b37c0a5-f1c9-4f4e-a71b-b6f06f671003", "1.2.3", "data-insight", "Analyze tabular data and explain metric changes.", "2026-07-12T03:08:00.000Z", mockUsers.chen, "完善异常原因摘要")],
  [skillIds.apiDoc]: [createVersion(skillIds.apiDoc, "8b37c0a5-f1c9-4f4e-a71b-b6f06f671004", "1.0.6", "api-doc-writer", "Generate consistent API documentation from source code.", "2026-07-10T06:30:00.000Z", mockUsers.current, "支持更多 TypeScript 类型")],
  [skillIds.weeklyReport]: [createVersion(skillIds.weeklyReport, "8b37c0a5-f1c9-4f4e-a71b-b6f06f671005", "1.3.1", "weekly-report", "Summarize project progress into a weekly report.", "2026-07-08T10:12:00.000Z", mockUsers.lin, "优化风险事项格式")],
  [skillIds.sqlChecker]: [createVersion(skillIds.sqlChecker, "8b37c0a5-f1c9-4f4e-a71b-b6f06f671006", "1.0.0", "sql-checker", "Identify risky and expensive SQL operations.", "2026-07-06T02:05:00.000Z", mockUsers.chen, "首次发布")],
  [skillIds.archived]: [createVersion(skillIds.archived, "8b37c0a5-f1c9-4f4e-a71b-b6f06f671007", "1.1.0", "legacy-helper", "Maintain legacy project notes.", "2026-06-20T02:05:00.000Z", mockUsers.current, "补充归档说明")],
  [skillIds.localConflict]: [createVersion(skillIds.localConflict, "8b37c0a5-f1c9-4f4e-a71b-b6f06f671008", "1.0.0", "local-conflict-demo", "Demonstrate conflict handling for an unknown local Skill.", "2026-07-17T03:01:00.000Z", mockUsers.current, "首次发布")],
  [skillIds.localModified]: [createVersion(skillIds.localModified, "8b37c0a5-f1c9-4f4e-a71b-b6f06f671009", "1.1.0", "local-modified-demo", "Demonstrate backup handling for locally modified content.", "2026-07-17T03:02:00.000Z", mockUsers.current, "增加本地修改演示")],
  [skillIds.downgrade]: [
    createVersion(skillIds.downgrade, "8b37c0a5-f1c9-4f4e-a71b-b6f06f671010", "2.0.0", "downgrade-demo", "Demonstrate confirmation before installing an older version.", "2026-07-17T03:03:00.000Z", mockUsers.lin, "升级演示规则", "8b37c0a5-f1c9-4f4e-a71b-b6f06f671110"),
    createVersion(skillIds.downgrade, "8b37c0a5-f1c9-4f4e-a71b-b6f06f671110", "1.0.0", "downgrade-demo", "Demonstrate confirmation before installing an older version.", "2026-07-01T03:03:00.000Z", mockUsers.current, "首次发布"),
  ],
  [skillIds.derivedOverlap]: [createVersion(skillIds.derivedOverlap, "8b37c0a5-f1c9-4f4e-a71b-b6f06f671011", "1.0.0", "review-helper-fork", "Demonstrate overlapping triggers in a derived Skill chain.", "2026-07-17T03:04:00.000Z", mockUsers.lin, "首次发布")],
  [skillIds.packageHash]: [createVersion(skillIds.packageHash, "8b37c0a5-f1c9-4f4e-a71b-b6f06f671012", "1.0.0", "package-hash-demo", "Demonstrate a package integrity verification failure.", "2026-07-17T03:05:00.000Z", mockUsers.chen, "首次发布")],
  [skillIds.rollback]: [createVersion(skillIds.rollback, "8b37c0a5-f1c9-4f4e-a71b-b6f06f671013", "1.0.0", "rollback-demo", "Demonstrate automatic recovery after replacement fails.", "2026-07-17T03:06:00.000Z", mockUsers.current, "首次发布")],
  [skillIds.claudeLink]: [createVersion(skillIds.claudeLink, "8b37c0a5-f1c9-4f4e-a71b-b6f06f671014", "1.0.0", "claude-link-demo", "Demonstrate a non-empty Claude skills directory.", "2026-07-17T03:07:00.000Z", mockUsers.lin, "首次发布")],
  [skillIds.nameConflict]: [createVersion(skillIds.nameConflict, "8b37c0a5-f1c9-4f4e-a71b-b6f06f671015", "1.0.0", "reserved-name-demo", "Demonstrate an unavailable reserved Skill name.", "2026-07-17T03:08:00.000Z", mockUsers.chen, "首次发布")],
  [skillIds.withdrawn]: [
    createVersion(skillIds.withdrawn, "8b37c0a5-f1c9-4f4e-a71b-b6f06f671016", "1.2.0", "withdrawn-version-demo", "Demonstrate how a withdrawn historical version is displayed.", "2026-07-17T03:09:00.000Z", mockUsers.current, "发布可用替代版本", "8b37c0a5-f1c9-4f4e-a71b-b6f06f671116"),
    markVersionWithdrawn(createVersion(skillIds.withdrawn, "8b37c0a5-f1c9-4f4e-a71b-b6f06f671116", "1.1.0", "withdrawn-version-demo", "Demonstrate how a withdrawn historical version is displayed.", "2026-07-05T03:09:00.000Z", mockUsers.lin, "增加旧版演示"), "该版本包含错误的安装脚本说明"),
  ],
};

const skillMeta = [
  [skillIds.codeReview, "代码审查助手", "按照团队规范检查变更，输出可执行的审查意见。", [0, 3, 5], mockUsers.current, [mockUsers.lin, mockUsers.disabled], 128, "2026-06-01T01:30:00.000Z", "ACTIVE"],
  [skillIds.meetingNotes, "会议纪要整理", "将会议记录整理为结论、待办和风险清单。", [1, 4], mockUsers.lin, [mockUsers.current], 96, "2026-05-20T06:10:00.000Z", "ACTIVE"],
  [skillIds.dataInsight, "经营数据洞察", "分析表格数据，生成指标变化与异常原因摘要。", [2], mockUsers.chen, [], 74, "2026-06-18T02:20:00.000Z", "ACTIVE"],
  [skillIds.apiDoc, "接口文档生成", "根据接口代码生成统一格式的使用说明和请求示例。", [3], mockUsers.current, [], 61, "2026-06-28T07:00:00.000Z", "ACTIVE"],
  [skillIds.weeklyReport, "研发周报汇总", "合并项目进展，生成面向团队的结构化周报。", [1, 4], mockUsers.lin, [mockUsers.current], 53, "2026-06-12T09:18:00.000Z", "ACTIVE"],
  [skillIds.sqlChecker, "SQL 安全检查", "识别 SQL 中的性能风险和高危数据操作。", [2, 5], mockUsers.chen, [], 47, "2026-07-02T04:45:00.000Z", "ACTIVE"],
  [skillIds.archived, "旧项目说明助手", "整理旧项目的维护说明。", [1], mockUsers.current, [mockUsers.lin], 19, "2026-05-02T04:45:00.000Z", "ARCHIVED"],
  [skillIds.localConflict, "演示：本地同名冲突", "本地存在同名未知来源目录，安装时要求先备份再强制替换。", [6], mockUsers.current, [], 0, "2026-07-17T03:01:00.000Z", "ACTIVE"],
  [skillIds.localModified, "演示：本地内容已修改", "平台安装内容被本地修改，覆盖前展示风险并创建备份。", [6], mockUsers.current, [], 0, "2026-07-17T03:02:00.000Z", "ACTIVE"],
  [skillIds.downgrade, "演示：历史版本降级", "在版本历史中选择旧版本，展示降级确认与版本风险。", [6], mockUsers.lin, [], 0, "2026-07-17T03:03:00.000Z", "ACTIVE"],
  [skillIds.derivedOverlap, "演示：派生触发冲突", "安装同一来源链的 Skill 时提示触发可能重叠并推荐只保留一个。", [6], mockUsers.lin, [], 0, "2026-07-17T03:04:00.000Z", "ACTIVE"],
  [skillIds.packageHash, "演示：安装包校验失败", "下载内容与平台哈希不一致时中止安装，不修改本地文件。", [5, 6], mockUsers.chen, [], 0, "2026-07-17T03:05:00.000Z", "ACTIVE"],
  [skillIds.rollback, "演示：失败自动恢复", "目录替换失败后自动恢复原 Skill，并向用户说明恢复结果。", [6], mockUsers.current, [], 0, "2026-07-17T03:06:00.000Z", "ACTIVE"],
  [skillIds.claudeLink, "演示：Claude 目录非空", "Codex 安装继续，Claude 链接跳过并展示手工迁移说明。", [6], mockUsers.lin, [], 0, "2026-07-17T03:07:00.000Z", "ACTIVE"],
  [skillIds.nameConflict, "演示：名称冲突不可安装", "名称命中平台保留项，继续公开展示但禁止安装和更新。", [6], mockUsers.chen, [], 0, "2026-07-17T03:08:00.000Z", "NAME_CONFLICT"],
  [skillIds.withdrawn, "演示：历史版本已撤回", "版本历史保留撤回原因，并禁用该版本的安装入口。", [6], mockUsers.current, [], 0, "2026-07-17T03:09:00.000Z", "ACTIVE"],
] as const;

const skillOverrides: Partial<Record<string, Pick<SkillDetailDto, "derivedFrom" | "nameConflictReason">>> = {
  [skillIds.derivedOverlap]: {
    derivedFrom: {
      skillId: skillIds.codeReview,
      skillName: "code-review",
      versionId: mockVersions[skillIds.codeReview][0].id,
      version: mockVersions[skillIds.codeReview][0].version,
      status: "ACTIVE",
      linkable: true,
    },
    nameConflictReason: null,
  },
  [skillIds.nameConflict]: {
    derivedFrom: null,
    nameConflictReason: "该名称已被加入平台保留名称列表，请使用新名称创建派生 Skill。",
  },
};

export const mockSkillDetails: SkillDetailDto[] = skillMeta.map((item) => {
  const [id, displayName, displayDescription, tagIndexes, owner, collaborators, installCount, createdAt, status] = item;
  const currentVersion = mockVersions[id][0];
  const override = skillOverrides[id];
  return {
    id,
    skillName: currentVersion.skillName,
    displayName,
    skillDescription: currentVersion.skillDescription,
    displayDescription,
    status,
    owner,
    collaborators: [...collaborators],
    tags: [...tagIndexes.map((index) => mockTags[index]), mockDataTag],
    currentVersion,
    installCount,
    derivedFrom: override?.derivedFrom ?? null,
    derivedChain: [],
    updatedBy: currentVersion.uploadedBy,
    archivedAt: status === "ARCHIVED" ? "2026-07-10T08:00:00.000Z" : null,
    archiveReason: status === "ARCHIVED" ? "当前项目已结束维护" : null,
    nameConflictReason: override?.nameConflictReason ?? null,
    createdAt,
    updatedAt: currentVersion.publishedAt,
  };
});

/**
 * 功能说明：为演示版本创建稳定的文件树和文本内容。
 * @param version - 需要生成文件数据的版本。
 * @returns 文件清单、文本内容和原始 SKILL.md。
 */
function createVersionFileSource(version: SkillVersionDto): MockVersionFileSource {
  const skillMd = `---\nname: ${version.skillName}\ndescription: ${version.skillDescription}\n---\n`;
  const usage = `# ${version.skillName}\n\n${version.skillDescription}\n`;
  return {
    files: [
      { path: "assets", type: "DIRECTORY", size: null, sha256: null, previewable: false },
      { path: "references", type: "DIRECTORY", size: null, sha256: null, previewable: false },
      { path: "SKILL.md", type: "FILE", size: new Blob([skillMd]).size, sha256: packageHash, previewable: true },
      { path: "assets/icon.png", type: "FILE", size: 2_048, sha256: packageHash, previewable: false },
      { path: "references/usage.md", type: "FILE", size: new Blob([usage]).size, sha256: packageHash, previewable: true },
    ],
    contents: { "SKILL.md": skillMd, "references/usage.md": usage },
    skillMd,
  };
}

export const mockVersionFiles = Object.fromEntries(
  Object.values(mockVersions).flat().map((version) => [version.id, createVersionFileSource(version)]),
) satisfies Record<string, MockVersionFileSource>;

export const mockNotifications: NotificationDto[] = [
  {
    id: "notification-1001",
    type: "VERSION_PUBLISHED",
    title: "会议纪要整理发布了新版本",
    body: "林晓发布了 v2.1.0，你可以在详情中查看更新内容。",
    skillId: skillIds.meetingNotes,
    readAt: null,
    createdAt: "2026-07-16T08:20:00.000Z",
  },
  {
    id: "notification-1002",
    type: "METADATA_UPDATED",
    title: "代码审查助手的信息已更新",
    body: "协作者林晓更新了展示简介。",
    skillId: skillIds.codeReview,
    readAt: null,
    createdAt: "2026-07-15T03:10:00.000Z",
  },
];
