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
type VersionHashFile = Awaited<
  ReturnType<typeof catalogRepository.listVersionHashFiles>
>[number];
type UserSummary = Pick<
  User,
  | "id"
  | "name"
  | "avatarUrl"
  | "departmentPath"
  | "status"
  | "updatedAt"
>;

function encodeDepartmentKey(path: string[]): string {
  return Buffer.from(JSON.stringify(path), "utf8").toString("base64url");
}

function getDepartmentDisplayName(path: string[]): string {
  const storedName = path[path.length - 1] || "";
  const pathName = storedName
    .split(/\s*[\\/／>＞]\s*/u)
    .filter(Boolean)
    .pop()
    || storedName;
  return pathName
    .split(/\s*[-‐‑‒–—]\s*/u)
    .filter(Boolean)
    .pop()
    || pathName;
}

export function decodeDepartmentKey(value: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      !Array.isArray(parsed)
      || parsed.length === 0
      || parsed.some(
        (item) => typeof item !== "string" || !item.trim(),
      )
    ) {
      return null;
    }
    return parsed.map((item) => item.trim());
  } catch {
    return null;
  }
}

function toUserDto(user: UserSummary | null) {
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
    departmentPath: user.departmentPath,
    status: user.status,
    role: "USER" as const,
    syncedAt: user.updatedAt.toISOString(),
  };
}

function extractSkillName(
  slug: string,
  version: Pick<VersionRecord, "manifestJson" | "readmeMd">,
): string {
  const storedName = readStoredVersionMetadata(version).skillName;
  return storedName || slug;
}

function toVersionDto(
  skill: {
    id: string;
    slug: string;
    description: string;
    creator?: UserSummary | null;
  },
  version: VersionRecord,
  fallbackFiles: VersionHashFile[] = [],
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
      computeVersionContentHash(fallbackFiles),
    uploadedBy,
    publishedAt,
    withdrawnBy: null,
    withdrawnAt: null,
    withdrawalReason: null,
  };
}

function toSkillSummary(
  skill: SkillRecord,
  fallbackFiles: VersionHashFile[] = [],
) {
  const version = skill.latestVersion;
  if (!version) {
    throw new Error(`Skill ${skill.id} is missing latest version`);
  }
  const owner = toUserDto(skill.creator);
  const currentVersion = toVersionDto(skill, version, fallbackFiles);
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

async function loadFallbackFiles(
  versions: Array<VersionRecord | null>,
): Promise<Map<string, VersionHashFile[]>> {
  const versionIds = versions
    .filter(
      (version): version is VersionRecord =>
        Boolean(
          version &&
          !readStoredVersionMetadata(version).contentHash,
        ),
    )
    .map((version) => version.id);
  if (versionIds.length === 0) return new Map();

  const files = await catalogRepository.listVersionHashFiles(
    versionIds,
  );
  const filesByVersionId = new Map<string, VersionHashFile[]>();
  for (const file of files) {
    const versionFiles =
      filesByVersionId.get(file.versionId) || [];
    versionFiles.push(file);
    filesByVersionId.set(file.versionId, versionFiles);
  }
  return filesByVersionId;
}

export const catalogService = {
  async listBusinessScenarios() {
    const items = await catalogRepository.listBusinessScenarios();
    return items.map(({ _count, ...item }) => ({
      ...item,
      skillCount: _count.skills,
    }));
  },

  async listTags(query?: string) {
    const items = await catalogRepository.listTags(query);
    return items.map((tag) => ({
      id: tag.id,
      name: tag.name,
    }));
  },

  async listPublishedSkillDepartments() {
    const users =
      await catalogRepository.listPublishedSkillDepartmentPaths();
    const paths = new Map<string, string[]>();
    for (const user of users) {
      const path = user.departmentPath
        .map((item) => item.trim())
        .filter(Boolean);
      if (path.length > 0) {
        paths.set(JSON.stringify(path), path);
      }
    }
    return [...paths.values()]
      .map((path) => ({
        id: encodeDepartmentKey(path),
        name: getDepartmentDisplayName(path),
        path,
      }))
      .sort((left, right) =>
        left.name.localeCompare(right.name, "zh-CN")
      );
  },

  async listSkills(input: ListSkillsInput) {
    const result = await catalogRepository.listSkills(input);
    const fallbackFiles = await loadFallbackFiles(
      result.items.map((skill) => skill.latestVersion),
    );
    return {
      items: result.items.map((skill) =>
        toSkillSummary(
          skill,
          skill.latestVersion
            ? fallbackFiles.get(skill.latestVersion.id)
            : undefined,
        ),
      ),
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
    const fallbackFiles = await loadFallbackFiles(
      result.items.map((skill) => skill.latestVersion),
    );
    return {
      items: result.items.map((skill) =>
        toSkillSummary(
          skill,
          skill.latestVersion
            ? fallbackFiles.get(skill.latestVersion.id)
            : undefined,
        ),
      ),
      total: result.total,
      page,
      pageSize,
    };
  },

  async getSkill(skillId: string) {
    const skill = await catalogRepository.getSkill(skillId);
    if (!skill) return null;
    const fallbackFiles = await loadFallbackFiles([
      skill.latestVersion,
    ]);
    return {
      ...toSkillSummary(
        skill,
        skill.latestVersion
          ? fallbackFiles.get(skill.latestVersion.id)
          : undefined,
      ),
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
    const fallbackFiles = await loadFallbackFiles(result.items);
    return {
      items: result.items.map((version) =>
        toVersionDto(
          skill,
          version,
          fallbackFiles.get(version.id),
        ),
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
