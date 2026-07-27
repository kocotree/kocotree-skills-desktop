import { parse as parseYaml } from "yaml";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readFrontmatter(
  skillMd: string | null | undefined,
): Record<string, unknown> | null {
  if (!skillMd) return null;
  const match =
    /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skillMd);
  if (!match) return null;
  try {
    return asRecord(parseYaml(match[1], { maxAliasCount: 50 }));
  } catch {
    return null;
  }
}

function readString(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim()
    ? value.trim()
    : null;
}

export function readStoredVersionMetadata(version: {
  manifestJson?: unknown;
  readmeMd?: string | null;
}): {
  skillName: string | null;
  skillDescription: string | null;
  contentHash: string | null;
  baseVersionId: string | null;
} {
  const manifest = asRecord(version.manifestJson);
  const frontmatter = readFrontmatter(version.readmeMd);
  return {
    skillName:
      readString(manifest, "skillName") ||
      readString(frontmatter, "name"),
    skillDescription:
      readString(manifest, "skillDescription") ||
      readString(frontmatter, "description"),
    contentHash: readString(manifest, "contentHash"),
    baseVersionId: readString(manifest, "baseVersionId"),
  };
}
