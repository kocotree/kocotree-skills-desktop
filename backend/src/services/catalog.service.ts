import { createHash } from "node:crypto";
import type { User } from "@prisma/client";
import { config } from "../config";
import {
  catalogRepository,
  type ListSkillsInput,
} from "../repositories/catalog.repository";
import {
  isPreviewableTextPath,
  normalizePackagePath,
  readFileFromPackage,
} from "./skill-package.service";
import {
  computeVersionContentHash,
  normalizeSha256,
} from "./skill-version-hash";
import { readStoredVersionMetadata } from "./skill-metadata";
import { storageService } from "./storage.service";

type SkillRecord = Awaited<
  ReturnType<typeof catalogRepository.listSkills>
>["items"][number];
type VersionRecord = NonNullable<SkillRecord["latestVersion"]>;

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

function extractSkillName(
  slug: string,
  version: Pick<VersionRecord, "readmeMd" | "files">,
): string {
  const storedName = readStoredVersionMetadata(version).skillName;
  if (storedName) return storedName;

  const skillMd = version.files.find(
    (file) => file.path.toLowerCase().endsWith("skill.md"),
  );
  const firstSegment = skillMd?.path.split("/").filter(Boolean)[0];
  return firstSegment && firstSegment.toLowerCase() !== "skill.md"
    ? firstSegment
    : slug;
}

function toVersionDto(
  skill: {
    id: string;
    slug: string;
    description: string;
    creator?: User | null;
  },
  version: VersionRecord,
) {
  const uploadedBy = toUserDto(version.creator || skill.creator || null);
  const storedMetadata = readStoredVersionMetadata(version);
  const skillDescription =
    storedMetadata.skillDescription ||
    skill.description ||
    "暂无描述";
  const publishedAt = (
    version.publishedAt ||
    version.createdAt
  ).toISOString();

  return {
    id: version.id,
    skillId: skill.id,
    version: version.version,
    status:
      version.status === "REVOKED"
        ? ("WITHDRAWN" as const)
        : ("PUBLISHED" as const),
    skillName: extractSkillName(skill.slug, version),
    skillDescription,
    changelog: version.changelog || "首次发布",
    baseVersionId: storedMetadata.baseVersionId,
    packageSize: Number(version.packageSize || 1),
    packageSha256: normalizeSha256(version.checksumSha256),
    contentHash:
      storedMetadata.contentHash ||
      computeVersionContentHash(version.files),
    uploadedBy,
    publishedAt,
    withdrawnBy: null,
    withdrawnAt: null,
    withdrawalReason: null,
  };
}

function toSkillSummary(skill: SkillRecord) {
  const version = skill.latestVersion;
  if (!version) {
    throw new Error(`Skill ${skill.id} is missing latest version`);
  }
  const owner = toUserDto(skill.creator);
  const currentVersion = toVersionDto(skill, version);
  const uploadedBy = currentVersion.uploadedBy;

  return {
    id: skill.id,
    skillName: currentVersion.skillName,
    displayName: skill.name,
    skillDescription: currentVersion.skillDescription,
    displayDescription: skill.description || "暂无描述",
    status: "ACTIVE" as const,
    owner,
    tags: skill.tags.map(({ tag }) => ({
      id: tag.id,
      name: tag.name,
    })),
    currentVersion,
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

  async listOwnedSkills(
    userId: string,
    page: number,
    pageSize: number,
  ) {
    const result = await catalogRepository.listOwnedSkills(
      userId,
      page,
      pageSize,
    );
    return {
      items: result.items.map(toSkillSummary),
      total: result.total,
      page,
      pageSize,
    };
  },

  async getSkill(skillId: string) {
    const skill = await catalogRepository.getSkill(skillId);
    if (!skill) return null;
    return {
      ...toSkillSummary(skill),
      collaborators: [],
      derivedChain: [],
    };
  },

  async listSkillVersions(
    skillId: string,
    page: number,
    pageSize: number,
  ) {
    const result = await catalogRepository.listSkillVersions(
      skillId,
      page,
      pageSize,
    );
    const skill = result.skill;
    if (!skill) return null;
    return {
      items: result.items.map((version) =>
        toVersionDto(skill, version),
      ),
      total: result.total,
      page,
      pageSize,
    };
  },

  async listVersionFiles(skillId: string, versionId: string) {
    const version = await catalogRepository.getSkillVersionFiles(
      skillId,
      versionId,
    );
    if (!version) return null;

    const maxPreviewBytes = config.skillPreviewTextMaxKb * 1024;
    return version.files.map((file) => ({
      path: file.path,
      type: file.type === "FOLDER"
        ? ("DIRECTORY" as const)
        : ("FILE" as const),
      size:
        file.type === "FOLDER"
          ? null
          : Number(file.sizeBytes || 0),
      sha256: file.checksumSha256
        ? normalizeSha256(file.checksumSha256)
        : null,
      previewable:
        file.type === "FILE" &&
        isPreviewableTextPath(file.path) &&
        (!file.sizeBytes ||
          file.sizeBytes <= BigInt(maxPreviewBytes)),
    }));
  },

  async getVersionFileContent(
    skillId: string,
    versionId: string,
    requestedPath: string,
  ) {
    const filePath = normalizePackagePath(requestedPath);
    if (!filePath) {
      return { status: "INVALID_PATH" as const };
    }

    const version = await catalogRepository.getSkillVersionFiles(
      skillId,
      versionId,
    );
    if (!version) {
      return { status: "VERSION_NOT_FOUND" as const };
    }

    const file = version.files.find(
      (entry) => entry.path === filePath && entry.type === "FILE",
    );
    if (!file) {
      return { status: "FILE_NOT_FOUND" as const };
    }
    if (!isPreviewableTextPath(file.path)) {
      return { status: "PREVIEW_UNAVAILABLE" as const };
    }

    const maxPreviewBytes = config.skillPreviewTextMaxKb * 1024;
    if (
      file.sizeBytes &&
      file.sizeBytes > BigInt(maxPreviewBytes)
    ) {
      return { status: "PREVIEW_TOO_LARGE" as const };
    }

    const packageBuffer = await storageService.getObject(
      version.ossObjectKey,
      version.ossBucket,
    );
    const contentBuffer = await readFileFromPackage(
      packageBuffer,
      filePath,
    );
    if (!contentBuffer) {
      return { status: "FILE_NOT_FOUND" as const };
    }

    const sha256 = file.checksumSha256
      ? normalizeSha256(file.checksumSha256)
      : `sha256:${createHash("sha256")
          .update(contentBuffer)
          .digest("hex")}`;
    return {
      status: "OK" as const,
      data: {
        path: filePath,
        content: contentBuffer.toString("utf8"),
        sha256,
        encoding: "UTF-8" as const,
        size: contentBuffer.byteLength,
      },
    };
  },
};
