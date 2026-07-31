/**
 * 将 Tag 输入草稿按中英文逗号拆分为非空名称。
 */
export function parseTagNames(value: string): string[] {
  return value.split(/[,，]/).map((name) => name.trim()).filter(Boolean);
}

/**
 * 将输入草稿合并到已提交的新 Tag，并按不区分大小写的名称去重。
 */
export function mergeTagNames(current: string[], draft: string): string[] {
  const merged = [...current];
  const normalizedNames = new Set(current.map((name) => name.toLocaleLowerCase()));
  for (const name of parseTagNames(draft)) {
    const normalized = name.toLocaleLowerCase();
    if (normalizedNames.has(normalized)) continue;
    normalizedNames.add(normalized);
    merged.push(name);
  }
  return merged;
}
