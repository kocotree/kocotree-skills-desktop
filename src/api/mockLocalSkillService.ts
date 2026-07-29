import {
  SkillApiError,
  type LocalInstallRequest,
  type LocalInstallResult,
  type LocalSkillAgent,
  type LocalSkillLocation,
  type LocalSkillRecord,
  type LocalSkillService,
  type RemoveLocalSkillInput,
  type SetLocalSkillEnabledInput,
} from "./contracts";
import { mockInstallScenarios, skillIds } from "./mockData";

const initialRecords: LocalSkillRecord[] = [
  {
    id: "local-code-review",
    skillId: "0c9c2f8d-3e84-4c0c-8a15-d41d87fd1001",
    versionId: "8b37c0a5-f1c9-4f4e-a71b-b6f06f671001",
    version: "1.4.2",
    skillName: "code-review",
    displayName: "代码审查助手",
    installPath: "~/.codex/skills/code-review",
    contentHash: `sha256:${"b".repeat(64)}-1001`,
    installedAt: "2026-07-16T08:00:00.000Z",
    status: "PLATFORM_INSTALLED",
  },
  {
    id: "local-personal-helper",
    skillId: null,
    versionId: null,
    version: null,
    skillName: "personal-helper",
    displayName: "个人工作助手",
    installPath: "~/.claude/skills/personal-helper",
    contentHash: `sha256:${"c".repeat(64)}`,
    installedAt: null,
    status: "LOCAL_UNKNOWN",
  },
  {
    id: "local-archived-platform-skill",
    skillId: skillIds.archived,
    versionId: "8b37c0a5-f1c9-4f4e-a71b-b6f06f671007",
    version: "1.1.0",
    skillName: "legacy-helper",
    displayName: "旧项目说明助手",
    installPath: "~/.codex/skills/legacy-helper",
    contentHash: `sha256:${"b".repeat(64)}-1007`,
    installedAt: "2026-07-08T08:00:00.000Z",
    status: "PLATFORM_INSTALLED",
  },
  {
    id: "local-name-conflict-platform-skill",
    skillId: skillIds.nameConflict,
    versionId: "8b37c0a5-f1c9-4f4e-a71b-b6f06f671015",
    version: "1.0.0",
    skillName: "reserved-name-demo",
    displayName: "演示：名称冲突不可安装",
    installPath: "~/.claude/skills/reserved-name-demo",
    contentHash: `sha256:${"b".repeat(64)}-1015`,
    installedAt: "2026-07-09T08:00:00.000Z",
    status: "PLATFORM_INSTALLED",
  },
  {
    id: "local-withdrawn-platform-version",
    skillId: skillIds.withdrawn,
    versionId: "8b37c0a5-f1c9-4f4e-a71b-b6f06f671116",
    version: "1.1.0",
    skillName: "withdrawn-version-demo",
    displayName: "演示：历史版本已撤回",
    installPath: "~/.codex/skills/withdrawn-version-demo",
    contentHash: `sha256:${"b".repeat(64)}-1116`,
    installedAt: "2026-07-10T08:00:00.000Z",
    status: "PLATFORM_INSTALLED",
  },
  {
    id: "local-online-unavailable-skill",
    skillId: "0c9c2f8d-3e84-4c0c-8a15-d41d87fd1099",
    versionId: "8b37c0a5-f1c9-4f4e-a71b-b6f06f671199",
    version: "1.0.0",
    skillName: "online-unavailable-demo",
    displayName: "演示：在线信息不可用",
    installPath: "~/.agents/skills/online-unavailable-demo",
    contentHash: `sha256:${"b".repeat(64)}-1199`,
    installedAt: "2026-07-11T08:00:00.000Z",
    status: "PLATFORM_INSTALLED",
  },
  {
    id: "local-conflict-demo",
    skillId: null,
    versionId: null,
    version: null,
    skillName: "local-conflict-demo",
    displayName: "本地同名演示目录",
    installPath: "~/.agents/skills/local-conflict-demo",
    contentHash: `sha256:${"d".repeat(64)}`,
    installedAt: null,
    status: "LOCAL_UNKNOWN",
  },
  {
    id: "local-modified-demo",
    skillId: skillIds.localModified,
    versionId: "8b37c0a5-f1c9-4f4e-a71b-b6f06f671009",
    version: "1.1.0",
    skillName: "local-modified-demo",
    displayName: "演示：本地内容已修改",
    installPath: "~/.agents/skills/local-modified-demo",
    contentHash: `sha256:${"e".repeat(64)}`,
    installedAt: "2026-07-16T08:00:00.000Z",
    status: "PLATFORM_MODIFIED",
  },
  {
    id: "local-rollback-demo",
    skillId: null,
    versionId: null,
    version: null,
    skillName: "rollback-demo",
    displayName: "待恢复的本地 Skill",
    installPath: "~/.agents/skills/rollback-demo",
    contentHash: `sha256:${"f".repeat(64)}`,
    installedAt: null,
    status: "LOCAL_UNKNOWN",
  },
];

const managedSkillNames = new Set([
  "code-review",
  "personal-helper",
  "legacy-helper",
  "reserved-name-demo",
  "withdrawn-version-demo",
]);

const AGENT_LOCATIONS: Record<LocalSkillAgent, LocalSkillLocation> = {
  agents: "AGENTS",
  claude: "CLAUDE",
  codex: "CODEX",
};

function inferMockLocation(path: string): LocalSkillLocation {
  if (path.includes("/.claude/skills/")) return "CLAUDE";
  if (path.includes("/.codex/skills/")) return "CODEX";
  return "AGENTS";
}

function inferMockAgent(path: string): LocalSkillAgent {
  const location = inferMockLocation(path);
  if (location === "CLAUDE") return "claude";
  if (location === "CODEX") return "codex";
  return "agents";
}

function managerPath(skillName: string): string {
  return `~/.skills-manager/skills/${skillName}`;
}

const initialMockRecords: LocalSkillRecord[] = [
  ...initialRecords
    .filter((record) => managedSkillNames.has(record.skillName))
    .map((record) => ({
      ...record,
      id: `manager-${record.skillName}`,
      installPath: managerPath(record.skillName),
      location: "MANAGER" as const,
      entryKind: "DIRECTORY" as const,
      resolvedPath: managerPath(record.skillName),
      assignedAgents: [inferMockAgent(record.installPath)],
    })),
  ...initialRecords.map((record) => {
    const managed = managedSkillNames.has(record.skillName);
    return {
      ...record,
      location: inferMockLocation(record.installPath),
      entryKind: managed ? "SYMLINK" as const : "DIRECTORY" as const,
      resolvedPath: managed
        ? managerPath(record.skillName)
        : record.installPath,
    };
  }),
  {
    ...initialRecords[0],
    id: "agents-code-review",
    installPath: "~/.agents/skills/code-review",
    location: "AGENTS",
    entryKind: "DIRECTORY",
    resolvedPath: "~/.agents/skills/code-review",
  },
];

/** 浏览器开发阶段使用的本地 Skill 内存模拟服务。 */
export class MockLocalSkillService implements LocalSkillService {
  private readonly records = structuredClone(initialMockRecords);
  private readonly delayMs: number;

  constructor(delayMs = 160) {
    this.delayMs = delayMs;
  }

  private async wait(): Promise<void> {
    await new Promise((resolve) => globalThis.setTimeout(resolve, this.delayMs));
  }

  async scanSkills(): Promise<LocalSkillRecord[]> {
    await this.wait();
    return structuredClone(this.records);
  }

  async setSkillEnabled(
    input: SetLocalSkillEnabledInput,
  ): Promise<LocalSkillRecord[]> {
    await this.wait();
    if (input.agent === "agents") {
      throw new SkillApiError(
        "LOCAL_SKILL_AGENT_UNSUPPORTED",
        "全部 Agents 是 Skill 本体工作区，不通过 Agent 连接开关控制",
      );
    }
    const sourceRecord = this.records.find(
      (record) =>
        (record.location === "AGENTS" || record.location === "MANAGER")
        && record.entryKind === "DIRECTORY"
        && record.installPath === input.sourcePath,
    );
    if (!sourceRecord) {
      throw new SkillApiError(
        "LOCAL_SKILL_SOURCE_UNMANAGED",
        "只能控制全部 Agents 工作区或兼容仓库中的实体 Skill",
      );
    }
    const locations: LocalSkillLocation[] = [AGENT_LOCATIONS[input.agent]];
    const existingRecords = this.records
      .map((record, index) => ({ record, index }))
      .filter(
        ({ record }) =>
          record.location
          && locations.includes(record.location)
          && record.skillName === input.skillName,
      );
    const conflictingRecord = existingRecords.find(
      ({ record }) =>
        (
          record.entryKind !== "SYMLINK"
          && record.entryKind !== "JUNCTION"
          && record.entryKind !== "COPY"
        )
        || (
          record.resolvedPath !== sourceRecord.resolvedPath
          && !(
            sourceRecord.location === "AGENTS"
            && record.resolvedPath === managerPath(input.skillName)
          )
        ),
    );
    if (conflictingRecord) {
      throw new SkillApiError(
        input.enabled
          ? "LOCAL_SKILL_TARGET_CONFLICT"
          : "LOCAL_SKILL_NOT_MANAGED_LINK",
        "Agent 可读取的目录中存在独立安装的同名 Skill，不能通过开关修改",
      );
    }

    if (input.enabled) {
      if (existingRecords.length === 0) {
        const location = AGENT_LOCATIONS[input.agent];
        this.records.push({
          ...structuredClone(sourceRecord),
          id: `${input.agent}-${input.skillName}`,
          installPath: `~/.${input.agent}/skills/${input.skillName}`,
          location,
          entryKind: "SYMLINK",
          resolvedPath: sourceRecord.resolvedPath,
        });
      } else {
        for (const { record } of existingRecords) {
          if (record.resolvedPath === managerPath(input.skillName)) {
            record.resolvedPath = sourceRecord.resolvedPath;
          }
        }
      }
    } else {
      for (const { index } of [...existingRecords].sort(
        (left, right) => right.index - left.index,
      )) {
        this.records.splice(index, 1);
      }
    }

    const assignedAgents = sourceRecord.assignedAgents ?? [];
    if (!assignedAgents.includes(input.agent)) {
      sourceRecord.assignedAgents = [...assignedAgents, input.agent];
    }

    return structuredClone(this.records);
  }

  /**
   * 功能说明：模拟安装、覆盖和备份结果，不读写真实文件系统。
   * @param input - 待安装的 Skill、版本和强制替换标记。
   * @returns 新的本地记录以及模拟备份信息。
   */
  async install(input: LocalInstallRequest): Promise<LocalInstallResult> {
    await this.wait();
    const scenario = mockInstallScenarios[input.skill.id];
    const conflict = this.records.find(
      (item) =>
        item.location !== "MANAGER"
        && item.skillName === input.version.skillName,
    );
    if (conflict && !input.force && (conflict.skillId !== input.skill.id || conflict.status !== "PLATFORM_INSTALLED")) {
      throw new SkillApiError("LOCAL_SKILL_CONFLICT", "本地已存在同名 Skill，请确认后强制替换", { localSkill: structuredClone(conflict) });
    }
    if (input.force && scenario?.forcedInstallError) {
      console.error("[MockLocalSkillService] 模拟目录替换失败并完成恢复", { skillId: input.skill.id });
      throw new SkillApiError(scenario.forcedInstallError.code, scenario.forcedInstallError.message);
    }
    const record: LocalSkillRecord = {
      id: conflict?.id ?? crypto.randomUUID(),
      skillId: input.skill.id,
      versionId: input.version.id,
      version: input.version.version,
      skillName: input.version.skillName,
      displayName: input.skill.displayName,
      installPath: `~/.agents/skills/${input.version.skillName}`,
      contentHash: input.version.contentHash,
      installedAt: new Date().toISOString(),
      status: "PLATFORM_INSTALLED",
    };
    if (conflict) Object.assign(conflict, record);
    else this.records.push(record);
    console.info("[MockLocalSkillService] 模拟安装完成", { skillName: record.skillName, force: Boolean(input.force) });
    return {
      record: structuredClone(record),
      replacedSkillName: conflict && input.force ? conflict.skillName : null,
      backupPath: conflict && input.force ? `~/.agents/.kocotree/backups/${conflict.skillName}-${Date.now()}` : null,
      notices: [...(scenario?.completionNotices ?? [])],
    };
  }

  async remove(input: RemoveLocalSkillInput): Promise<LocalSkillRecord[]> {
    await this.wait();
    const ownedRecord = this.records.find(
      (item) =>
        item.skillId === input.skillId
        && item.skillName === input.skillName
        && (
          item.status === "PLATFORM_INSTALLED"
          || item.status === "PLATFORM_MODIFIED"
        ),
    );
    if (!ownedRecord) {
      throw new SkillApiError(
        "LOCAL_UNINSTALL_NOT_FOUND",
        "没有找到可由平台卸载的本地 Skill",
      );
    }
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      if (this.records[index]?.skillName === input.skillName) {
        this.records.splice(index, 1);
      }
    }
    return structuredClone(this.records);
  }
}
