import { createHash } from "node:crypto";
import type { SkillFile, User } from "@prisma/client";
import {
  catalogRepository,
  type ListSkillsInput,
} from "../repositories/catalog.repository";

type SkillRecord = Awaited<
  ReturnType<typeof catalogRepository.listSkills>
>["items"][number];

function normalizeSha256(value: string): string {
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

function toUserDto(user: User | null) {
  if (!user) {
    return {
      id: "unknown",
      name: "未知用户",
      avatarUrl: null,
      departmentPath: [] as string[],
      status: "DISABLED" as const,
      role: "USER" as const,
      syncedAt: new Date(0).toISOString(),
    };
  }
  return {
    id: user.id,
    name: user.name,
    avatarUrl: user.avatarUrl,
    departmentPath: [] as string[],
    status: user.status,
    role: "USER" as const,
    syncedAt: user.updatedAt.toISOString(),
  };
}

function extractSkillName(skill: SkillRecord): string {
  const frontmatterName = skill.latestVersion?.readmeMd?.match(
    /^name:\s*["']?([^"'\r\n]+)["']?\s*$/im,
  )?.[1]?.trim();
  if (frontmatterName) {
    return frontmatterName;
  }

  const skillMd = skill.latestVersion?.files.find(
    (file) => file.path.toLowerCase().endsWith("skill.md"),
  );
  const firstSegment = skillMd?.path.split("/").filter(Boolean)[0];
  return firstSegment && firstSegment.toLowerCase() !== "skill.md"
    ? firstSegment
    : skill.slug;
}

function contentHash(files: SkillFile[]): string {
  const canonical = files
    .map(
      (file) =>
        `${file.type}:${file.path}:${file.checksumSha256 || ""}:${file.sizeBytes || 0}`,
    )
    .sort()
    .join("\n");
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function toSkillSummary(skill: SkillRecord) {
  const version = skill.latestVersion;
  if (!version) {
    throw new Error(`Skill ${skill.id} is missing latest version`);
  }
  const owner = toUserDto(skill.creator);
  const uploadedBy = toUserDto(version.creator || skill.creator);
  const skillDescription = skill.description || "暂无描述";
  const publishedAt = (
    version.publishedAt ||
    version.createdAt
  ).toISOString();

  return {
    id: skill.id,
    skillName: extractSkillName(skill),
    displayName: skill.name,
    skillDescription,
    displayDescription: skillDescription,
    status: "ACTIVE" as const,
    owner,
    tags: skill.tags.map(({ tag }) => ({
      id: tag.id,
      name: tag.name,
    })),
    currentVersion: {
      id: version.id,
      skillId: skill.id,
      version: version.version,
      status: "PUBLISHED" as const,
      skillName: extractSkillName(skill),
      skillDescription,
      changelog: version.changelog || "首次发布",
      baseVersionId: null,
      packageSize: Number(version.packageSize || 0),
      packageSha256: normalizeSha256(version.checksumSha256),
      contentHash: contentHash(version.files),
      uploadedBy,
      publishedAt,
      withdrawnBy: null,
      withdrawnAt: null,
      withdrawalReason: null,
    },
    installCount: skill.installCount,
    derivedFrom: null,
    updatedBy: uploadedBy,
    archivedAt: null,
    archiveReason: null,
    nameConflictReason: null,
    createdAt: skill.createdAt.toISOString(),
    updatedAt: skill.updatedAt.toISOString(),
  };
}

export const catalogService = {
  async listTags(query?: string) {
    const items = await catalogRepository.listTags(query);
    return items.map((tag) => ({
      id: tag.id,
      name: tag.name,
    }));
  },

  async listSkills(input: ListSkillsInput) {
    const result = await catalogRepository.listSkills(input);
    return {
      items: result.items.map(toSkillSummary),
      total: result.total,
      page: input.page,
      pageSize: input.pageSize,
    };
  },
};
