import { describe, expect, it } from "vitest";
import {
  countActiveLocalSkills,
  filterLocalSkillGroups,
  filterWorkspaceSkillGroups,
  getLocalSkillActivationState,
  getLocalSkillSourceRecord,
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

  it("通过 Mock 服务为 .agents 本体创建和移除 Codex 软链接", async () => {
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
});
