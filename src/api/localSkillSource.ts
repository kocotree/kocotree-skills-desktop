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

  return [...groups.values()].sort((left, right) =>
    left.primaryRecord.displayName.localeCompare(
      right.primaryRecord.displayName,
      "zh-CN",
    ),
  );
}

/** 返回可由平台安全卸载的本地 Skill，并优先选取私有仓库中的本体记录。 */
export function getUninstallableSkillRecords(
  records: LocalSkillRecord[],
): Map<string, LocalSkillRecord> {
  const locationPriority: Record<LocalSkillLocation, number> = {
    MANAGER: 0,
    CLAUDE: 1,
    CODEX: 2,
    AGENTS: 3,
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

/** 返回私有仓库中可作为 Agent 生效入口来源的 Skill 本体。 */
export function getLocalSkillSourceRecord(
  group: LocalSkillGroup,
): LocalSkillRecord | null {
  if (group.managerRecord?.entryKind === "DIRECTORY") {
    return group.managerRecord;
  }
  return group.workspaceRecord?.entryKind === "DIRECTORY"
    ? group.workspaceRecord
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
      && resolvedKey(record) === resolvedKey(group.workspaceRecord),
  );
}

export function getLocalSkillActivationState(
  group: LocalSkillGroup,
  agent: LocalSkillAgent,
): LocalSkillActivationState {
  if (agent === "agents") {
    return getLocalSkillSourceRecord(group) ? "enabled" : "disabled";
  }
  if (group.workspaceRecord && !group.managerRecord && agent === "codex") {
    return group.workspaceRecord.assignedAgents?.includes("codex")
      ? "enabled"
      : "disabled";
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
  // Agent 扫描目录中真实存在的独立 Skill 已经生效；是否受 Kocotree
  // 管理只决定开关能否操作，不应把实际的开启状态显示为关闭或冲突。
  if (!getLocalSkillSourceRecord(group)) {
    return "enabled";
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
  query = "",
): LocalSkillGroup[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return groups.filter((group) => {
    if (getLocalSkillActivationState(group, filter) === "disabled") {
      return false;
    }
    if (!normalizedQuery) return true;
    const record = group.primaryRecord;
    return record.displayName.toLocaleLowerCase().includes(normalizedQuery)
      || record.skillName.toLocaleLowerCase().includes(normalizedQuery);
  });
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

export function canControlLocalSkill(
  group: LocalSkillGroup,
  agent: LocalSkillFilter,
): boolean {
  if (group.managerRecord?.entryKind === "DIRECTORY") return true;
  return (agent === "claude" || agent === "codex")
    && group.workspaceRecord?.entryKind === "DIRECTORY";
}

/** 返回指向外部 .agents Skill 的旧版 Codex 连接，供界面单独清理。 */
export function getExternalCodexLegacyLink(
  group: LocalSkillGroup,
): LocalSkillRecord | null {
  const record = group.agentRecords.codex;
  return group.workspaceRecord
    && !group.managerRecord
    && record
    && (record.entryKind === "SYMLINK" || record.entryKind === "JUNCTION")
    && resolvedKey(record) === resolvedKey(group.workspaceRecord)
    ? record
    : null;
}

export function filterWorkspaceSkillGroups(
  groups: LocalSkillGroup[],
): LocalSkillGroup[] {
  return groups;
}

/** 返回一个聚合卡片中实际扫描到的全部本地条目，并按记录编号去重。 */
export function getLocalSkillGroupRecords(
  group: LocalSkillGroup,
): LocalSkillRecord[] {
  const records = [
    group.managerRecord,
    group.workspaceRecord,
    ...Object.values(group.agentRecords),
  ].filter((record): record is LocalSkillRecord => Boolean(record));
  return [...new Map(records.map((record) => [record.id, record])).values()];
}
