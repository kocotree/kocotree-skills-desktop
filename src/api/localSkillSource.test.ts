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
    displayDescription: "",
    skillDescription: "Research topics using trusted sources.",
    installPath: "/Users/test/.kocotree-skills/skills/research",
    contentHash: "sha256:test",
    installedAt: null,
    status: "LOCAL_UNKNOWN",
    location: "MANAGER",
    entryKind: "DIRECTORY",
    resolvedPath: "/Users/test/.kocotree-skills/skills/research",
    ...overrides,
  };
}

describe("私有 Skill 仓库", () => {
  it("将私有仓库实体目录作为本体，但不把它误判为 Codex 已开启", () => {
    const groups = groupLocalSkills([
      record({ id: "manager-source" }),
      record({
        id: "claude-link",
        installPath: "/Users/test/.claude/skills/research",
        location: "CLAUDE",
        entryKind: "SYMLINK",
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(filterWorkspaceSkillGroups(groups)).toHaveLength(1);
    expect(getLocalSkillSourceRecord(groups[0])?.location).toBe("MANAGER");
    expect(getLocalSkillActivationState(groups[0], "claude")).toBe("enabled");
    expect(getLocalSkillActivationState(groups[0], "codex")).toBe("disabled");
    expect(filterLocalSkillGroups(groups, "claude")).toHaveLength(1);
    expect(filterLocalSkillGroups(groups, "codex")).toHaveLength(0);
    expect(countActiveLocalSkills(groups, "codex")).toBe(0);
  });

  it("历史上开启过但当前已关闭的 Skill 不再显示在 Agent 页面", () => {
    const groups = groupLocalSkills([
      record({
        id: "manager-source",
        assignedAgents: ["claude", "codex"],
      }),
    ]);

    expect(filterLocalSkillGroups(groups, "claude")).toHaveLength(0);
    expect(filterLocalSkillGroups(groups, "codex")).toHaveLength(0);
    expect(filterWorkspaceSkillGroups(groups)).toHaveLength(1);
  });

  it("将旧 skills-manager 仓库作为只读外部来源", () => {
    const externalSource = record({
      id: "external-source",
      skillId: "external-skill-id",
      installPath: "/Users/test/.skills-manager/skills/research",
      resolvedPath: "/Users/test/.skills-manager/skills/research",
      location: "EXTERNAL",
      status: "PLATFORM_INSTALLED",
    });
    const groups = groupLocalSkills([
      externalSource,
      record({
        id: "external-codex-link",
        installPath: "/Users/test/.codex/skills/research",
        resolvedPath: externalSource.resolvedPath,
        location: "CODEX",
        entryKind: "SYMLINK",
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].externalRecord).toBe(externalSource);
    expect(getLocalSkillSourceRecord(groups[0])).toBeNull();
    expect(getLocalSkillActivationState(groups[0], "codex")).toBe("enabled");
    expect(getUninstallableSkillRecords([
      externalSource,
      groups[0].agentRecords.codex!,
    ]).size).toBe(0);
  });

  it("Agent 页面按展示名称和 Skill 名称搜索，不区分大小写并忽略首尾空格", () => {
    const groups = groupLocalSkills([
      record({ id: "research-source" }),
      record({
        id: "research-claude-link",
        installPath: "/Users/test/.claude/skills/research",
        location: "CLAUDE",
        entryKind: "SYMLINK",
      }),
      record({
        id: "writer-source",
        skillName: "article-writer",
        displayName: "Article Writer",
        installPath: "/Users/test/.kocotree-skills/skills/article-writer",
        resolvedPath: "/Users/test/.kocotree-skills/skills/article-writer",
      }),
      record({
        id: "writer-claude-link",
        skillName: "article-writer",
        displayName: "Article Writer",
        installPath: "/Users/test/.claude/skills/article-writer",
        resolvedPath: "/Users/test/.kocotree-skills/skills/article-writer",
        location: "CLAUDE",
        entryKind: "SYMLINK",
      }),
    ]);

    expect(
      filterLocalSkillGroups(groups, "claude", "  RESEARCH "),
    ).toHaveLength(1);
    expect(
      filterLocalSkillGroups(groups, "claude", "article-wri")[0]
        ?.primaryRecord.skillName,
    ).toBe("article-writer");
    expect(filterLocalSkillGroups(groups, "claude", "missing")).toHaveLength(0);
  });

  it("将 Windows Junction 识别为受管 Agent 连接", () => {
    const sourcePath = "C:\\Users\\test\\.kocotree-skills\\skills\\research";
    const groups = groupLocalSkills([
      record({
        id: "manager-source-windows",
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
    const sourcePath = "C:\\Users\\test\\.kocotree-skills\\skills\\research";
    const groups = groupLocalSkills([
      record({
        id: "manager-source-windows",
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

  it("通过 Mock 服务为私有本体创建和移除 Codex 入口", async () => {
    const service = new MockLocalSkillService(0);
    const initial = await service.scanSkills();
    const source = initial.find(
      (item) =>
        item.location === "MANAGER"
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
          && item.location === "MANAGER",
      ),
    ).toBe(true);
  });

  it("通过 Mock 服务关闭 Codex 时保留私有本体", async () => {
    const service = new MockLocalSkillService(0);
    const initialGroups = groupLocalSkills(await service.scanSkills());
    const initialGroup = initialGroups.find(
      (group) => group.managerRecord?.skillName === "code-review",
    )!;

    expect(getLocalSkillActivationState(initialGroup, "codex")).toBe("enabled");

    const disabled = await service.setSkillEnabled({
      skillName: initialGroup.managerRecord!.skillName,
      sourcePath: initialGroup.managerRecord!.installPath,
      agent: "codex",
      enabled: false,
    });
    const disabledGroup = groupLocalSkills(disabled).find(
      (group) => group.managerRecord?.skillName === "code-review",
    )!;

    expect(getLocalSkillActivationState(disabledGroup, "codex")).toBe("disabled");
    expect(
      disabled.some(
        (record) =>
          record.location === "MANAGER"
          && record.skillName === "code-review",
      ),
    ).toBe(true);
  });

  it("通过 Mock 服务重新开启 Codex 时复用私有本体", async () => {
    const service = new MockLocalSkillService(0);
    const initialGroups = groupLocalSkills(await service.scanSkills());
    const initialGroup = initialGroups.find(
      (group) => group.managerRecord?.skillName === "code-review",
    )!;

    await service.setSkillEnabled({
      skillName: initialGroup.managerRecord!.skillName,
      sourcePath: initialGroup.managerRecord!.installPath,
      agent: "codex",
      enabled: false,
    });

    const enabled = await service.setSkillEnabled({
      skillName: initialGroup.managerRecord!.skillName,
      sourcePath: initialGroup.managerRecord!.installPath,
      agent: "codex",
      enabled: true,
    });
    const enabledGroup = groupLocalSkills(enabled).find(
      (group) => group.managerRecord?.skillName === "code-review",
    )!;

    expect(getLocalSkillActivationState(enabledGroup, "codex")).toBe("enabled");
    expect(
      enabled.some(
        (record) =>
          record.location === "CODEX"
          && record.skillName === "code-review",
      ),
    ).toBe(true);
    expect(
      enabled.some(
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

  it("卸载记录优先选择私有仓库本体并排除未知来源", () => {
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
        id: "manager-source",
        skillId: platformSkillId,
        status: "PLATFORM_MODIFIED",
        location: "MANAGER",
        entryKind: "DIRECTORY",
      }),
      record({
        id: "unknown-source",
        skillId: "unknown",
        status: "LOCAL_UNKNOWN",
      }),
    ];

    const uninstallable = getUninstallableSkillRecords(records);

    expect(uninstallable.get(platformSkillId)?.id).toBe("manager-source");
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
