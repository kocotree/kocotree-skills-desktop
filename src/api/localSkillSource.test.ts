import { describe, expect, it } from "vitest";
import {
  countActiveLocalSkills,
  filterLocalSkillGroups,
  filterWorkspaceSkillGroups,
  getLocalSkillActivationState,
  getLocalSkillSourceRecord,
  getUninstallableSkillRecords,
  groupLocalSkills,
} from "./localSkillSource";
import { MockLocalSkillService } from "./mockLocalSkillService";
import type { LocalSkillRecord } from "./contracts";

function record(
  overrides: Partial<LocalSkillRecord>,
): LocalSkillRecord {
  return {
    id: "record",
    skillId: null,
    versionId: null,
    version: null,
    skillName: "research",
    displayName: "Research",
    installPath: "/Users/test/.agents/skills/research",
    contentHash: "sha256:test",
    installedAt: null,
    status: "LOCAL_UNKNOWN",
    location: "AGENTS",
    entryKind: "DIRECTORY",
    resolvedPath: "/Users/test/.agents/skills/research",
    ...overrides,
  };
}

describe("全部 Agents 工作区", () => {
  it("将 .agents 实体目录作为本体，但不把它误判为 Codex 已连接", () => {
    const groups = groupLocalSkills([
      record({ id: "agents-source" }),
      record({
        id: "claude-link",
        installPath: "/Users/test/.claude/skills/research",
        location: "CLAUDE",
        entryKind: "SYMLINK",
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(filterWorkspaceSkillGroups(groups)).toHaveLength(1);
    expect(getLocalSkillSourceRecord(groups[0])?.location).toBe("AGENTS");
    expect(getLocalSkillActivationState(groups[0], "claude")).toBe("enabled");
    expect(getLocalSkillActivationState(groups[0], "codex")).toBe("disabled");
    expect(filterLocalSkillGroups(groups, "claude")).toHaveLength(1);
    expect(filterLocalSkillGroups(groups, "codex")).toHaveLength(0);
    expect(countActiveLocalSkills(groups, "codex")).toBe(0);
  });

  it("历史上开启过但当前已关闭的 Skill 不再显示在 Agent 页面", () => {
    const groups = groupLocalSkills([
      record({
        id: "agents-source",
        assignedAgents: ["claude", "codex"],
      }),
    ]);

    expect(filterLocalSkillGroups(groups, "claude")).toHaveLength(0);
    expect(filterLocalSkillGroups(groups, "codex")).toHaveLength(0);
    expect(filterWorkspaceSkillGroups(groups)).toHaveLength(1);
  });

  it("将 Windows Junction 识别为受管 Agent 连接", () => {
    const sourcePath = "C:\\Users\\test\\.agents\\skills\\research";
    const groups = groupLocalSkills([
      record({
        id: "agents-source-windows",
        installPath: sourcePath,
        resolvedPath: sourcePath,
      }),
      record({
        id: "codex-junction",
        installPath: "C:\\Users\\test\\.codex\\skills\\research",
        location: "CODEX",
        entryKind: "JUNCTION",
        resolvedPath: sourcePath,
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(getLocalSkillActivationState(groups[0], "codex")).toBe("enabled");
    expect(filterLocalSkillGroups(groups, "codex")).toHaveLength(1);
  });

  it("将 Windows 复制降级目录识别为受管 Agent 连接", () => {
    const sourcePath = "C:\\Users\\test\\.agents\\skills\\research";
    const groups = groupLocalSkills([
      record({
        id: "agents-source-windows",
        installPath: sourcePath,
        resolvedPath: sourcePath,
      }),
      record({
        id: "codex-copy",
        installPath: "C:\\Users\\test\\.codex\\skills\\research",
        location: "CODEX",
        entryKind: "COPY",
        resolvedPath: sourcePath,
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(getLocalSkillActivationState(groups[0], "codex")).toBe("enabled");
    expect(filterLocalSkillGroups(groups, "codex")).toHaveLength(1);
  });

  it("将指向兼容仓库的同名连接合并到工作区并标记为旧连接", () => {
    const workspacePath = "/Users/test/.agents/skills/research";
    const managerPath = "/Users/test/.skills-manager/skills/research";
    const groups = groupLocalSkills([
      record({
        id: "agents-source",
        installPath: workspacePath,
        resolvedPath: workspacePath,
      }),
      record({
        id: "manager-source",
        installPath: managerPath,
        resolvedPath: managerPath,
        location: "MANAGER",
      }),
      record({
        id: "legacy-codex-link",
        installPath: "/Users/test/.codex/skills/research",
        resolvedPath: managerPath,
        location: "CODEX",
        entryKind: "SYMLINK",
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.workspaceRecord?.id).toBe("agents-source");
    expect(groups[0]?.managerRecord?.id).toBe("manager-source");
    expect(groups[0]?.agentRecords.codex?.id).toBe("legacy-codex-link");
    expect(getLocalSkillActivationState(groups[0]!, "codex")).toBe("legacy");
  });

  it("通过 Mock 服务为 .agents 本体创建和移除 Codex 连接", async () => {
    const service = new MockLocalSkillService(0);
    const initial = await service.scanSkills();
    const source = initial.find(
      (item) =>
        item.location === "AGENTS"
        && item.entryKind === "DIRECTORY"
        && item.skillName === "local-conflict-demo",
    )!;

    const enabled = await service.setSkillEnabled({
      skillName: source.skillName,
      sourcePath: source.installPath,
      agent: "codex",
      enabled: true,
    });
    expect(enabled).toContainEqual(
      expect.objectContaining({
        skillName: source.skillName,
        location: "CODEX",
        entryKind: "SYMLINK",
        resolvedPath: source.resolvedPath,
      }),
    );

    const disabled = await service.setSkillEnabled({
      skillName: source.skillName,
      sourcePath: source.installPath,
      agent: "codex",
      enabled: false,
    });
    expect(
      disabled.some(
        (item) =>
          item.skillName === source.skillName
          && item.location === "CODEX",
      ),
    ).toBe(false);
    expect(
      disabled.some(
        (item) =>
          item.skillName === source.skillName
          && item.location === "AGENTS",
      ),
    ).toBe(true);
  });

  it("通过 Mock 服务将 Codex 旧连接迁移到 .agents 本体", async () => {
    const service = new MockLocalSkillService(0);
    const initialGroups = groupLocalSkills(await service.scanSkills());
    const initialGroup = initialGroups.find(
      (group) => group.workspaceRecord?.skillName === "code-review",
    )!;

    expect(getLocalSkillActivationState(initialGroup, "codex")).toBe("legacy");

    const migrated = await service.setSkillEnabled({
      skillName: initialGroup.workspaceRecord!.skillName,
      sourcePath: initialGroup.workspaceRecord!.installPath,
      agent: "codex",
      enabled: true,
    });
    const migratedGroup = groupLocalSkills(migrated).find(
      (group) => group.workspaceRecord?.skillName === "code-review",
    )!;

    expect(getLocalSkillActivationState(migratedGroup, "codex")).toBe("enabled");
    expect(
      migrated.some(
        (record) =>
          record.location === "MANAGER"
          && record.skillName === "code-review",
      ),
    ).toBe(true);
  });

  it("通过 Mock 服务卸载平台 Skill 及其同名 Agent 记录", async () => {
    const service = new MockLocalSkillService(0);
    const installed = (await service.scanSkills()).find(
      (item) =>
        item.skillId
        && item.status === "PLATFORM_INSTALLED",
    )!;

    const remaining = await service.remove({
      skillId: installed.skillId!,
      skillName: installed.skillName,
    });

    expect(
      remaining.some((item) => item.skillName === installed.skillName),
    ).toBe(false);
  });

  it("卸载记录优先选择全部 Agents 本体并排除未知来源", () => {
    const platformSkillId = "platform-skill";
    const records = [
      record({
        id: "codex-link",
        skillId: platformSkillId,
        status: "PLATFORM_INSTALLED",
        location: "CODEX",
        entryKind: "SYMLINK",
      }),
      record({
        id: "agents-source",
        skillId: platformSkillId,
        status: "PLATFORM_MODIFIED",
        location: "AGENTS",
        entryKind: "DIRECTORY",
      }),
      record({
        id: "unknown-source",
        skillId: "unknown",
        status: "LOCAL_UNKNOWN",
      }),
    ];

    const uninstallable = getUninstallableSkillRecords(records);

    expect(uninstallable.get(platformSkillId)?.id).toBe("agents-source");
    expect(uninstallable.has("unknown")).toBe(false);
  });

  it("Mock 服务拒绝卸载用户自己的本地 Skill", async () => {
    const service = new MockLocalSkillService(0);
    const localSkill = (await service.scanSkills()).find(
      (item) => item.status === "LOCAL_UNKNOWN",
    )!;

    await expect(service.remove({
      skillId: "not-platform-owned",
      skillName: localSkill.skillName,
    })).rejects.toMatchObject({
      code: "LOCAL_UNINSTALL_NOT_FOUND",
    });
  });
});
