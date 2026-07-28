import type {
  LocalSkillAgent,
  LocalSkillLocation,
  LocalSkillRecord,
} from "./contracts";

export type LocalSkillFilter = Exclude<LocalSkillAgent, "agents">;

export type LocalSkillActivationState =
  | "enabled"
  | "disabled"
  | "unmanaged";

export interface LocalSkillGroup {
  id: string;
  primaryRecord: LocalSkillRecord;
  managerRecord: LocalSkillRecord | null;
  workspaceRecord: LocalSkillRecord | null;
  agentRecords: Partial<Record<LocalSkillAgent, LocalSkillRecord>>;
}

function normalizedPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function getLocalSkillLocation(
  record: LocalSkillRecord,
): LocalSkillLocation {
  if (record.location) return record.location;
  const path = normalizedPath(record.installPath).toLowerCase();
  if (path.includes("/.skills-manager/skills/")) return "MANAGER";
  if (path.includes("/.claude/skills/")) return "CLAUDE";
  if (path.includes("/.codex/skills/")) return "CODEX";
  return "AGENTS";
}

function locationToAgent(
  location: LocalSkillLocation,
): LocalSkillAgent | null {
  if (location === "AGENTS") return "agents";
  if (location === "CLAUDE") return "claude";
  if (location === "CODEX") return "codex";
  return null;
}

function resolvedKey(record: LocalSkillRecord): string {
  return normalizedPath(record.resolvedPath ?? record.installPath);
}

export function groupLocalSkills(
  records: LocalSkillRecord[],
): LocalSkillGroup[] {
  const groups = new Map<string, LocalSkillGroup>();
  const orderedRecords = [...records].sort((left, right) => {
    const leftManager = getLocalSkillLocation(left) === "MANAGER";
    const rightManager = getLocalSkillLocation(right) === "MANAGER";
    return Number(rightManager) - Number(leftManager);
  });

  for (const record of orderedRecords) {
    const key = resolvedKey(record);
    const location = getLocalSkillLocation(record);
    const existing = groups.get(key);
    const group: LocalSkillGroup = existing ?? {
      id: `local-group-${key}`,
      primaryRecord: record,
      managerRecord: null,
      workspaceRecord: null,
      agentRecords: {},
    };

    if (location === "MANAGER") {
      group.managerRecord = record;
      group.primaryRecord = record;
    } else {
      const agent = locationToAgent(location);
      if (agent && !group.agentRecords[agent]) {
        group.agentRecords[agent] = record;
      }
      if (location === "AGENTS") {
        group.workspaceRecord = record;
        group.primaryRecord = record;
      }
    }
    groups.set(key, group);
  }

  return [...groups.values()].sort((left, right) =>
    left.primaryRecord.displayName.localeCompare(
      right.primaryRecord.displayName,
      "zh-CN",
    ),
  );
}

/**
 * 返回可作为 Agent 连接本体的 Skill。优先使用全部 Agents 工作区，
 * 旧版统一仓库仅作为兼容来源保留。
 */
export function getLocalSkillSourceRecord(
  group: LocalSkillGroup,
): LocalSkillRecord | null {
  if (group.workspaceRecord?.entryKind === "DIRECTORY") {
    return group.workspaceRecord;
  }
  return group.managerRecord?.entryKind === "DIRECTORY"
    ? group.managerRecord
    : null;
}

function isManagedLink(
  group: LocalSkillGroup,
  record: LocalSkillRecord,
): boolean {
  const sourceRecord = getLocalSkillSourceRecord(group);
  return Boolean(
    sourceRecord
      && (record.entryKind === "SYMLINK" || record.entryKind === "JUNCTION")
      && resolvedKey(record) === resolvedKey(sourceRecord),
  );
}

export function getLocalSkillActivationState(
  group: LocalSkillGroup,
  agent: LocalSkillAgent,
): LocalSkillActivationState {
  if (agent === "agents") {
    return group.workspaceRecord ? "enabled" : "disabled";
  }
  const directRecords = [group.agentRecords[agent]].filter(
    (record): record is LocalSkillRecord => Boolean(record),
  );
  if (directRecords.length === 0) return "disabled";
  return directRecords.every((record) => isManagedLink(group, record))
    ? "enabled"
    : "unmanaged";
}

export function isLocalSkillAssigned(
  group: LocalSkillGroup,
  agent: LocalSkillFilter,
): boolean {
  const assignments =
    getLocalSkillSourceRecord(group)?.assignedAgents ?? [];
  return assignments.includes(agent);
}

export function filterLocalSkillGroups(
  groups: LocalSkillGroup[],
  filter: LocalSkillFilter,
): LocalSkillGroup[] {
  return groups.filter(
    (group) =>
      getLocalSkillActivationState(group, filter) !== "disabled",
  );
}

export function countActiveLocalSkills(
  groups: LocalSkillGroup[],
  agent: Exclude<LocalSkillAgent, "agents">,
): number {
  return groups.filter(
    (group) =>
      getLocalSkillActivationState(group, agent) !== "disabled",
  ).length;
}

export function canControlLocalSkill(group: LocalSkillGroup): boolean {
  return getLocalSkillSourceRecord(group) !== null;
}

export function filterWorkspaceSkillGroups(
  groups: LocalSkillGroup[],
): LocalSkillGroup[] {
  return groups.filter((group) => group.workspaceRecord !== null);
}
