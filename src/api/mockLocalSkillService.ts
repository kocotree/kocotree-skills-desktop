import { SkillApiError, type LocalInstallRequest, type LocalInstallResult, type LocalSkillRecord, type LocalSkillService } from "./contracts";
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

/** 浏览器开发阶段使用的本地 Skill 内存模拟服务。 */
export class MockLocalSkillService implements LocalSkillService {
  private readonly records = structuredClone(initialRecords);
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

  /**
   * 功能说明：模拟安装、覆盖和备份结果，不读写真实文件系统。
   * @param input - 待安装的 Skill、版本和强制替换标记。
   * @returns 新的本地记录以及模拟备份信息。
   */
  async install(input: LocalInstallRequest): Promise<LocalInstallResult> {
    await this.wait();
    const scenario = mockInstallScenarios[input.skill.id];
    const conflict = this.records.find((item) => item.skillName === input.version.skillName);
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

  async remove(skillName: string): Promise<void> {
    await this.wait();
    const index = this.records.findIndex((item) => item.skillName === skillName);
    if (index >= 0) this.records.splice(index, 1);
  }
}
