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

/** 根据云端现有版本生成北京时间当天的下一个日期版本号。 */
export function nextDateSkillVersion(
  versions: readonly string[],
  now = new Date(),
): string {
  const prefix = currentDateVersionPrefix(now);
  const maxSequence = versions.reduce((current, version) => {
    const matched = version.match(DATE_SKILL_VERSION_PATTERN);
    if (!matched) return current;
    const versionPrefix =
      `${Number(matched[1])}.${Number(matched[2])}.${Number(matched[3])}`;
    return versionPrefix === prefix
      ? Math.max(current, Number(matched[4]))
      : current;
  }, 0);
  return `${prefix}-${maxSequence + 1}`;
}
