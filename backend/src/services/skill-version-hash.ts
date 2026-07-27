import { createHash } from "node:crypto";
type HashableSkillFile = {
  type: string;
  path: string;
  checksumSha256: string | null;
  sizeBytes: bigint | number | null;
};

export function normalizeSha256(value: string): string {
  return /^sha256:/i.test(value)
    ? value.replace(/^sha256:/i, "sha256:")
    : `sha256:${value}`;
}

/**
 * 当前服务端使用 skill_files 元数据生成稳定的版本内容哈希。
 * 后续 Rust 安装器开始校验解压目录时，双方必须切换到同一套字节级算法。
 */
export function computeVersionContentHash(
  files: HashableSkillFile[],
): string {
  const canonical = files
    .map(
      (file) =>
        `${file.type}:${file.path}:${file.checksumSha256 || ""}:${file.sizeBytes ?? 0}`,
    )
    .sort()
    .join("\n");
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
