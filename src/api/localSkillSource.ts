import type { LocalSkillRecord } from "./contracts";

export type LocalSkillSource = "agents" | "claude" | "codex";
export type LocalSkillFilter = "all" | Exclude<LocalSkillSource, "agents">;

function normalizedPath(record: LocalSkillRecord): string {
  return record.installPath.replace(/\\/g, "/").toLowerCase();
}

export function getLocalSkillSource(
  record: LocalSkillRecord,
): LocalSkillSource {
  const path = normalizedPath(record);
  if (path.includes("/.claude/skills/")) return "claude";
  if (path.includes("/.codex/skills/")) return "codex";
  return "agents";
}

export function filterLocalSkills(
  records: LocalSkillRecord[],
  filter: LocalSkillFilter,
): LocalSkillRecord[] {
  if (filter === "all") return records;
  return records.filter(
    (record) => getLocalSkillSource(record) === filter,
  );
}
