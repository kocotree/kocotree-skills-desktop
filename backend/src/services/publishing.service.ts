import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { config } from "../config";
import {
  PublishingPersistenceError,
  publishingRepository,
} from "../repositories/publishing.repository";
import { catalogService } from "./catalog.service";
import {
  prepareSkillPackage,
  type PreparedSkillPackage,
} from "./skill-package.service";
import { readStoredVersionMetadata } from "./skill-metadata";
import { computeVersionContentHash } from "./skill-version-hash";
import { storageService } from "./storage.service";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class PublishingError extends Error {
  constructor(
    readonly statusCode: 400 | 403 | 404 | 409 | 413 | 500 | 503,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PublishingError";
  }
}

export type CreateSkillInput = {
  file: Buffer;
  displayName: string;
  displayDescription: string;
  changelog?: string;
  tagIds: string[];
  newTagNames: string[];
  forkedFromSkillId?: string;
  forkedFromVersionId?: string;
  confirmDuplicateDisplayName: boolean;
  userId: string;
};

export type PublishVersionInput = {
  skillId: string;
  file: Buffer;
  baseVersionId: string;
  version: string;
  changelog: string;
  displayName?: string;
  displayDescription?: string;
  tagIds?: string[];
  newTagNames?: string[];
  confirmDuplicateDisplayName: boolean;
  userId: string;
};

export type UpdateSkillMetadataInput = {
  skillId: string;
  displayName?: string;
  displayDescription?: string;
  tagIds?: string[];
  newTagNames?: string[];
  confirmDuplicateDisplayName: boolean;
  userId: string;
};

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right);
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }
  return left.localeCompare(right);
}

function compareSemVer(left: string, right: string): number {
  const leftMatch = SEMVER_PATTERN.exec(left);
  const rightMatch = SEMVER_PATTERN.exec(right);
  if (!leftMatch || !rightMatch) return 0;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(leftMatch[index]) - Number(rightMatch[index]);
    if (difference !== 0) return difference;
  }
  const leftPrerelease = leftMatch[4];
  const rightPrerelease = rightMatch[4];
  if (!leftPrerelease && !rightPrerelease) return 0;
  if (!leftPrerelease) return 1;
  if (!rightPrerelease) return -1;
  const leftParts = leftPrerelease.split(".");
  const rightParts = rightPrerelease.split(".");
  for (
    let index = 0;
    index < Math.max(leftParts.length, rightParts.length);
    index += 1
  ) {
    if (leftParts[index] === undefined) return -1;
    if (rightParts[index] === undefined) return 1;
    const difference = compareIdentifiers(
      leftParts[index],
      rightParts[index],
    );
    if (difference !== 0) return difference;
  }
  return 0;
}

function validateText(
  value: string,
  fieldName: string,
  maximum: number,
): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new PublishingError(
      400,
      "INVALID_REQUEST",
      `${fieldName}必须为 1 至 ${maximum} 个字符`,
    );
  }
  return normalized;
}

function toTagSlug(name: string): string {
  const normalized = name
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (normalized) return normalized.slice(0, 80);
  return `tag-${createHash("sha256")
    .update(name)
    .digest("hex")
    .slice(0, 16)}`;
}

function normalizeTags(
  tagIds: string[],
  newTagNames: string[],
): {
  tagIds: string[];
  newTags: Array<{ slug: string; name: string }>;
} {
  const normalizedTagIds = [...new Set(tagIds.map((id) => id.trim()))];
  if (normalizedTagIds.some((id) => !UUID_PATTERN.test(id))) {
    throw new PublishingError(
      400,
      "INVALID_REQUEST",
      "Tag ID 无效",
    );
  }

  const newTags = new Map<
    string,
    { slug: string; name: string }
  >();
  for (const value of newTagNames) {
    const name = validateText(value, "Tag 名称", 50);
    const slug = toTagSlug(name);
    if (!newTags.has(slug)) {
      newTags.set(slug, { slug, name });
    }
  }
  if (normalizedTagIds.length + newTags.size > 5) {
    throw new PublishingError(
      400,
      "INVALID_REQUEST",
      "每个 Skill 最多选择或创建 5 个 Tag",
    );
  }
  return {
    tagIds: normalizedTagIds,
    newTags: [...newTags.values()],
  };
}

function readIdentity(candidate: {
  slug: string;
  latestVersion: {
    readmeMd: string | null;
    manifestJson: unknown;
  } | null;
}): string {
  return candidate.latestVersion
    ? readStoredVersionMetadata(candidate.latestVersion).skillName ||
        candidate.slug
    : candidate.slug;
}

async function ensureSkillNameAvailable(
  skillName: string,
): Promise<void> {
  const candidates =
    await publishingRepository.listIdentityCandidates();
  if (
    candidates.some(
      (candidate) =>
        readIdentity(candidate).toLocaleLowerCase() ===
        skillName.toLocaleLowerCase(),
    )
  ) {
    throw new PublishingError(
      409,
      "DUPLICATE_SKILL_NAME",
      "该 Skill 名称已经存在，请发布为新版本",
    );
  }
}

async function ensureDisplayNameConfirmed(
  displayName: string,
  confirmed: boolean,
  excludedSkillId?: string,
): Promise<void> {
  if (confirmed) return;
  const conflicts =
    await publishingRepository.listDisplayNameConflicts(
      displayName,
      excludedSkillId,
    );
  if (conflicts.length === 0) return;
  throw new PublishingError(
    409,
    "DISPLAY_NAME_CONFIRMATION_REQUIRED",
    "平台中存在同名展示名称，请确认后继续",
    {
      conflicts: conflicts.map((conflict) => ({
        id: conflict.id,
        displayName: conflict.name,
        skillName: readIdentity(conflict),
      })),
    },
  );
}

function getContentHash(prepared: PreparedSkillPackage): string {
  return computeVersionContentHash(prepared.entries);
}

function createManifest(
  prepared: PreparedSkillPackage,
  input: {
    contentHash: string;
    baseVersionId: string | null;
    forkedFromSkillId?: string;
    forkedFromVersionId?: string;
  },
): Prisma.InputJsonValue {
  return {
    schemaVersion: 1,
    uploadMode: "zip",
    skillName: prepared.skillName,
    skillDescription: prepared.skillDescription,
    contentHash: input.contentHash,
    baseVersionId: input.baseVersionId,
    ignoredSystemEntryCount: prepared.ignoredSystemEntryCount,
    forkedFrom:
      input.forkedFromSkillId && input.forkedFromVersionId
        ? {
            skillId: input.forkedFromSkillId,
            versionId: input.forkedFromVersionId,
          }
        : null,
    fileCount: prepared.files.length,
    files: prepared.files.map((file) => ({
      path: file.path,
      sizeBytes: file.sizeBytes,
      checksumSha256: file.checksumSha256,
    })),
  };
}

async function deleteUploadedObject(objectKey: string): Promise<void> {
  try {
    await storageService.deleteObject(objectKey);
  } catch {
    // 数据库写入失败时仅做尽力清理，原始错误仍由调用方处理。
  }
}

function mapPersistenceError(
  error: unknown,
  operation: "CREATE" | "PUBLISH" | "UPDATE",
): never {
  if (error instanceof PublishingError) throw error;
  if (error instanceof PublishingPersistenceError) {
    if (error.code === "VERSION_CONFLICT") {
      throw new PublishingError(
        409,
        "VERSION_CONFLICT",
        "发布期间已经出现新版本，请刷新后重试",
      );
    }
    if (error.code === "OWNER_REQUIRED") {
      throw new PublishingError(
        403,
        "OWNER_REQUIRED",
        "只有 Owner 可以修改展示信息",
      );
    }
    throw new PublishingError(
      400,
      "INVALID_REQUEST",
      "选择的 Tag 不存在",
    );
  }
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    if (operation === "CREATE") {
      throw new PublishingError(
        409,
        "DUPLICATE_SKILL_NAME",
        "该 Skill 名称已经存在，请发布为新版本",
      );
    }
    if (operation === "PUBLISH") {
      throw new PublishingError(
        409,
        "VERSION_ALREADY_EXISTS",
        "该版本号已经存在",
      );
    }
    throw new PublishingError(
      400,
      "INVALID_REQUEST",
      "展示信息无法更新",
    );
  }
  throw error;
}

async function loadPublishedSkill(
  skillId: string,
  failureMessage = "发布成功，但无法读取最新 Skill 信息",
) {
  const skill = await catalogService.getSkill(skillId);
  if (!skill) {
    throw new PublishingError(
      500,
      "PUBLISHING_FAILED",
      failureMessage,
    );
  }
  return skill;
}

export const publishingService = {
  async resolvePublishTarget(skillName: string, userId: string) {
    const normalizedName = skillName.trim().toLocaleLowerCase();
    if (
      !SKILL_NAME_PATTERN.test(normalizedName) ||
      normalizedName.length > 64
    ) {
      throw new PublishingError(
        400,
        "INVALID_REQUEST",
        "Skill 名称格式无效",
      );
    }

    const target =
      await publishingRepository.findPublishTargetBySkillName(
        normalizedName,
      );
    if (!target) {
      return { state: "NOT_FOUND" as const, skill: null };
    }
    if (target.createdBy !== userId) {
      return { state: "TAKEN_BY_OTHER" as const, skill: null };
    }
    if (target.status !== "PUBLISHED" || !target.latestVersionId) {
      return { state: "UNAVAILABLE" as const, skill: null };
    }

    const skill = await loadPublishedSkill(
      target.id,
      "无法读取云端 Skill 发布目标",
    );
    return { state: "OWNED" as const, skill };
  },

  async createSkill(input: CreateSkillInput) {
    const displayName = validateText(
      input.displayName,
      "展示名称",
      100,
    );
    const displayDescription = validateText(
      input.displayDescription,
      "展示简介",
      1_000,
    );
    const changelog = input.changelog?.trim()
      ? validateText(input.changelog, "更新说明", 2_000)
      : "首次发布";
    const tags = normalizeTags(input.tagIds, input.newTagNames);
    const prepared = await prepareSkillPackage(input.file);
    await ensureSkillNameAvailable(prepared.skillName);
    await ensureDisplayNameConfirmed(
      displayName,
      input.confirmDuplicateDisplayName,
    );

    if (
      Boolean(input.forkedFromSkillId) !==
      Boolean(input.forkedFromVersionId)
    ) {
      throw new PublishingError(
        400,
        "INVALID_REQUEST",
        "派生来源 Skill 和版本必须同时提供",
      );
    }
    if (input.forkedFromSkillId && input.forkedFromVersionId) {
      if (
        !UUID_PATTERN.test(input.forkedFromSkillId) ||
        !UUID_PATTERN.test(input.forkedFromVersionId) ||
        !(await publishingRepository.getForkSource(
          input.forkedFromSkillId,
          input.forkedFromVersionId,
        ))
      ) {
        throw new PublishingError(
          404,
          "VERSION_NOT_FOUND",
          "没有找到派生来源版本",
        );
      }
    }

    const skillId = randomUUID();
    const versionId = randomUUID();
    const contentHash = getContentHash(prepared);
    const objectKey = `skills/${prepared.skillName}/${versionId}/package.zip`;
    const uploaded = await storageService.putObject(
      objectKey,
      prepared.packageBuffer,
    );
    try {
      await publishingRepository.createPublishedSkill({
        skillId,
        slug: prepared.skillName,
        displayName,
        displayDescription,
        readmeTitle: displayName,
        tagIds: tags.tagIds,
        newTags: tags.newTags,
        version: {
          id: versionId,
          version: "1.0.0",
          ossBucket: config.ossBucket,
          ossObjectKey: uploaded.objectKey,
          ossEtag: uploaded.etag,
          packageSize: prepared.packageBuffer.byteLength,
          checksumSha256: prepared.packageChecksumSha256,
          manifestJson: createManifest(prepared, {
            contentHash,
            baseVersionId: null,
            forkedFromSkillId: input.forkedFromSkillId,
            forkedFromVersionId: input.forkedFromVersionId,
          }),
          readmeMd: prepared.skillMd,
          changelog,
          createdBy: input.userId,
          entries: prepared.entries,
        },
      });
    } catch (error) {
      await deleteUploadedObject(objectKey);
      mapPersistenceError(error, "CREATE");
    }
    return loadPublishedSkill(skillId);
  },

  async updateSkillMetadata(input: UpdateSkillMetadataInput) {
    if (!UUID_PATTERN.test(input.skillId)) {
      throw new PublishingError(
        404,
        "SKILL_NOT_FOUND",
        "没有找到该 Skill",
      );
    }
    if (
      input.displayName === undefined &&
      input.displayDescription === undefined &&
      input.tagIds === undefined &&
      input.newTagNames === undefined
    ) {
      throw new PublishingError(
        400,
        "INVALID_REQUEST",
        "请至少修改一项展示信息",
      );
    }

    const displayName =
      input.displayName === undefined
        ? undefined
        : validateText(input.displayName, "展示名称", 100);
    const displayDescription =
      input.displayDescription === undefined
        ? undefined
        : validateText(
            input.displayDescription,
            "展示简介",
            1_000,
          );
    const shouldReplaceTags =
      input.tagIds !== undefined ||
      input.newTagNames !== undefined;
    const tags = shouldReplaceTags
      ? normalizeTags(
          input.tagIds || [],
          input.newTagNames || [],
        )
      : undefined;

    const skill =
      await publishingRepository.getSkillForMetadataUpdate(
        input.skillId,
      );
    if (!skill) {
      throw new PublishingError(
        404,
        "SKILL_NOT_FOUND",
        "没有找到该 Skill",
      );
    }
    if (skill.createdBy !== input.userId) {
      throw new PublishingError(
        403,
        "OWNER_REQUIRED",
        "只有 Owner 可以修改展示信息",
      );
    }
    if (displayName !== undefined) {
      await ensureDisplayNameConfirmed(
        displayName,
        input.confirmDuplicateDisplayName,
        input.skillId,
      );
    }

    try {
      await publishingRepository.updateSkillMetadata({
        skillId: input.skillId,
        ownerId: input.userId,
        displayName,
        displayDescription,
        tagIds: tags?.tagIds,
        newTags: tags?.newTags,
      });
    } catch (error) {
      mapPersistenceError(error, "UPDATE");
    }
    return loadPublishedSkill(
      input.skillId,
      "展示信息已更新，但无法读取最新 Skill 信息",
    );
  },

  async publishVersion(input: PublishVersionInput) {
    if (!UUID_PATTERN.test(input.skillId)) {
      throw new PublishingError(
        404,
        "SKILL_NOT_FOUND",
        "没有找到该 Skill",
      );
    }
    if (!UUID_PATTERN.test(input.baseVersionId)) {
      throw new PublishingError(
        400,
        "INVALID_REQUEST",
        "当前版本标识无效",
      );
    }
    const version = input.version.trim();
    if (!SEMVER_PATTERN.test(version)) {
      throw new PublishingError(
        400,
        "INVALID_SEMVER",
        "版本号必须使用 SemVer",
      );
    }
    const changelog = validateText(
      input.changelog,
      "更新说明",
      2_000,
    );
    const displayName =
      input.displayName === undefined
        ? undefined
        : validateText(input.displayName, "展示名称", 100);
    const displayDescription =
      input.displayDescription === undefined
        ? undefined
        : validateText(
            input.displayDescription,
            "展示简介",
            1_000,
          );
    const tags =
      input.tagIds === undefined
        ? undefined
        : normalizeTags(input.tagIds, input.newTagNames || []);

    const skill =
      await publishingRepository.getSkillForPublishing(
        input.skillId,
      );
    if (!skill) {
      throw new PublishingError(
        404,
        "SKILL_NOT_FOUND",
        "没有找到该 Skill",
      );
    }
    if (skill.createdBy !== input.userId) {
      throw new PublishingError(
        403,
        "OWNER_REQUIRED",
        "只有 Owner 可以发布新版本",
      );
    }
    if (skill.status !== "PUBLISHED" || !skill.latestVersion) {
      throw new PublishingError(
        409,
        "SKILL_UNAVAILABLE",
        "当前 Skill 状态不允许发布新版本",
      );
    }
    if (skill.latestVersionId !== input.baseVersionId) {
      throw new PublishingError(
        409,
        "VERSION_CONFLICT",
        "发布期间已经出现新版本，请刷新后重试",
      );
    }
    if (skill.versions.some((item) => item.version === version)) {
      throw new PublishingError(
        409,
        "VERSION_ALREADY_EXISTS",
        "该版本号已经存在",
      );
    }
    if (
      skill.versions.some(
        (item) => compareSemVer(version, item.version) <= 0,
      )
    ) {
      throw new PublishingError(
        400,
        "VERSION_NOT_GREATER",
        "新版本必须高于所有历史版本",
      );
    }
    if (displayName !== undefined) {
      await ensureDisplayNameConfirmed(
        displayName,
        input.confirmDuplicateDisplayName,
        input.skillId,
      );
    }

    const prepared = await prepareSkillPackage(input.file);
    const currentSkillName =
      readStoredVersionMetadata(skill.latestVersion).skillName ||
      skill.slug;
    if (
      prepared.skillName.toLocaleLowerCase() !==
      currentSkillName.toLocaleLowerCase()
    ) {
      throw new PublishingError(
        409,
        "SKILL_NAME_MISMATCH",
        "ZIP 中的 Skill 名称与目标 Skill 不一致",
        {
          expectedSkillName: currentSkillName,
          actualSkillName: prepared.skillName,
        },
      );
    }

    const contentHash = getContentHash(prepared);
    if (
      skill.versions.some((storedVersion) => {
        const stored =
          readStoredVersionMetadata(storedVersion).contentHash;
        return (
          (stored ||
            computeVersionContentHash(storedVersion.files)) ===
          contentHash
        );
      })
    ) {
      throw new PublishingError(
        400,
        "CONTENT_UNCHANGED",
        "ZIP 内容与历史版本一致，无需重复发布",
      );
    }

    const versionId = randomUUID();
    const objectKey = `skills/${currentSkillName}/${versionId}/package.zip`;
    const uploaded = await storageService.putObject(
      objectKey,
      prepared.packageBuffer,
    );
    try {
      await publishingRepository.publishVersion({
        skillId: input.skillId,
        baseVersionId: input.baseVersionId,
        ownerId: input.userId,
        displayName,
        displayDescription,
        tagIds: tags?.tagIds,
        newTags: tags?.newTags,
        version: {
          id: versionId,
          version,
          ossBucket: config.ossBucket,
          ossObjectKey: uploaded.objectKey,
          ossEtag: uploaded.etag,
          packageSize: prepared.packageBuffer.byteLength,
          checksumSha256: prepared.packageChecksumSha256,
          manifestJson: createManifest(prepared, {
            contentHash,
            baseVersionId: input.baseVersionId,
          }),
          readmeMd: prepared.skillMd,
          changelog,
          createdBy: input.userId,
          entries: prepared.entries,
        },
      });
    } catch (error) {
      await deleteUploadedObject(objectKey);
      mapPersistenceError(error, "PUBLISH");
    }
    return loadPublishedSkill(input.skillId);
  },
};
