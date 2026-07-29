import type {
  LocalSkillAgent,
  LocalSkillLocation,
  LocalSkillRecord,
} from "./contracts";

export type LocalSkillFilter = Exclude<LocalSkillAgent, "agents">;

export type LocalSkillActivationState =
  | "enabled"
  | "disabled"
  | "legacy"
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

function isManagedConnectionRecord(record: LocalSkillRecord): boolean {
  return (
    record.entryKind === "SYMLINK"
    || record.entryKind === "JUNCTION"
    || record.entryKind === "COPY"
  );
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

  const groupedRecords = [...groups.values()];
  const workspaceGroupsBySkillName = new Map(
    groupedRecords
      .filter((group) => group.workspaceRecord)
      .map((group) => [group.workspaceRecord!.skillName, group]),
  );
  const mergedLegacyGroups = new Set<LocalSkillGroup>();
  for (const legacyGroup of groupedRecords) {
    if (!legacyGroup.managerRecord || legacyGroup.workspaceRecord) continue;
    const workspaceGroup = workspaceGroupsBySkillName.get(
      legacyGroup.managerRecord.skillName,
    );
    if (!workspaceGroup || workspaceGroup.managerRecord) continue;
    const legacyAgentRecords = (["claude", "codex"] as const)
      .map((agent) => [agent, legacyGroup.agentRecords[agent]] as const)
      .filter(
        (
          entry,
        ): entry is readonly [
          "claude" | "codex",
          LocalSkillRecord,
        ] =>
          Boolean(entry[1])
          && isManagedConnectionRecord(entry[1]!)
          && resolvedKey(entry[1]!) === resolvedKey(legacyGroup.managerRecord!),
      );
    if (
      legacyAgentRecords.length === 0
      || legacyAgentRecords.some(
        ([agent]) => Boolean(workspaceGroup.agentRecords[agent]),
      )
    ) {
      continue;
    }
    workspaceGroup.managerRecord = legacyGroup.managerRecord;
    for (const [agent, record] of legacyAgentRecords) {
      workspaceGroup.agentRecords[agent] = record;
    }
    mergedLegacyGroups.add(legacyGroup);
  }

  return groupedRecords
    .filter((group) => !mergedLegacyGroups.has(group))
    .sort((left, right) =>
    left.primaryRecord.displayName.localeCompare(
      right.primaryRecord.displayName,
      "zh-CN",
    ),
    );
}

/**
 * 返回可由平台安全卸载的本地 Skill，并优先选取全部 Agents 工作区中的本体记录。
 */
export function getUninstallableSkillRecords(
  records: LocalSkillRecord[],
): Map<string, LocalSkillRecord> {
  const locationPriority: Record<LocalSkillLocation, number> = {
    AGENTS: 0,
    CLAUDE: 1,
    CODEX: 2,
    MANAGER: 3,
  };
  const candidates = records
    .filter(
      (record) =>
        Boolean(record.skillId)
        && (
          record.status === "PLATFORM_INSTALLED"
          || record.status === "PLATFORM_MODIFIED"
        ),
    )
    .sort(
      (left, right) =>
        locationPriority[getLocalSkillLocation(left)]
        - locationPriority[getLocalSkillLocation(right)],
    );
  const recordsBySkillId = new Map<string, LocalSkillRecord>();
  for (const record of candidates) {
    if (record.skillId && !recordsBySkillId.has(record.skillId)) {
      recordsBySkillId.set(record.skillId, record);
    }
  }
  return recordsBySkillId;
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
      && isManagedConnectionRecord(record)
      && resolvedKey(record) === resolvedKey(sourceRecord),
  );
}

function isLegacyManagedLink(
  group: LocalSkillGroup,
  record: LocalSkillRecord,
): boolean {
  return Boolean(
    group.workspaceRecord
      && group.managerRecord
      && isManagedConnectionRecord(record)
      && resolvedKey(record) === resolvedKey(group.managerRecord),
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
  if (directRecords.every((record) => isManagedLink(group, record))) {
    return "enabled";
  }
  if (directRecords.every((record) => isLegacyManagedLink(group, record))) {
    return "legacy";
  }
  return "unmanaged";
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
