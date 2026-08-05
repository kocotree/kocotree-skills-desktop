const SKILL_VERSION_TIME_ZONE = "Asia/Shanghai";

export const DATE_SKILL_VERSION_PATTERN =
  /^(\d{4})\.(\d{1,2})\.(\d{1,2})-([1-9]\d*)$/;

function currentDateVersionPrefix(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SKILL_VERSION_TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const value = (type: "year" | "month" | "day"): string =>
    parts.find((part) => part.type === type)?.value || "";
  return `${value("year")}.${Number(value("month"))}.${Number(value("day"))}`;
}

/** 按北京时间生成当天的下一个 Skill 日期版本号。 */
export function nextDateSkillVersion(
  currentVersion?: string,
  now = new Date(),
): string {
  const prefix = currentDateVersionPrefix(now);
  const matched = currentVersion?.match(DATE_SKILL_VERSION_PATTERN);
  const currentPrefix = matched
    ? `${Number(matched[1])}.${Number(matched[2])}.${Number(matched[3])}`
    : "";
  const nextSequence = currentPrefix === prefix
    ? Number(matched?.[4] || 0) + 1
    : 1;
  return `${prefix}-${nextSequence}`;
}
