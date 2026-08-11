import JSZip from "jszip";
import {
  SkillApiError,
  type CreateSkillDto,
  type DeleteSkillResultDto,
  type DeleteSkillVersionResultDto,
  type DownloadTicketDto,
  type FileEntryDto,
  type InstallationEventDto,
  type InstallationResolutionDto,
  type InstallationStatusDto,
  type ListMySkillsQuery,
  type ListNotificationsQuery,
  type ListSkillsQuery,
  type ListVersionsQuery,
  type NotificationPageDto,
  type PublishSkillVersionDto,
  type PublishedSkillDepartmentDto,
  type SkillApi,
  type SkillDetailDto,
  type SkillFileContentDto,
  type SkillPageDto,
  type SignInOptions,
  type SkillVersionDetailDto,
  type SkillVersionDto,
  type TagDto,
  type UpdateSkillMetadataDto,
  type UserDto,
  type VersionPageDto,
} from "./contracts";
import {
  mockNotifications,
  mockInstallScenarios,
  mockSkillDetails,
  mockTags,
  mockUsers,
  mockVersionFiles,
  mockVersions,
  type MockVersionFileSource,
} from "./mockData";
import { parseSkillPackage } from "./skillPackage";
import { readArchiveText, type SkillArchiveSource } from "./zipInspector";
import {
  DATE_SKILL_VERSION_PATTERN,
  nextDateSkillVersion,
} from "./skillVersion";

export interface MockSkillApiOptions {
  delayMs?: number;
  initialUser?: UserDto | null;
}

type StoredVersionFileSource = SkillArchiveSource | MockVersionFileSource;

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

function toBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function compareSemVer(left: string, right: string): number {
  const leftParts = left.split(/[+-]/)[0].split(".").map(Number);
  const rightParts = right.split(/[+-]/)[0].split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  const leftDateVersion = left.match(DATE_SKILL_VERSION_PATTERN);
  const rightDateVersion = right.match(DATE_SKILL_VERSION_PATTERN);
  if (leftDateVersion && rightDateVersion) {
    return Number(leftDateVersion[4]) - Number(rightDateVersion[4]);
  }
  return left.localeCompare(right);
}

function comparePopularSkills(left: SkillDetailDto, right: SkillDetailDto): number {
  return right.installCount - left.installCount
    || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    || Date.parse(right.createdAt) - Date.parse(left.createdAt)
    || right.id.localeCompare(left.id);
}

/**
 * 功能说明：提供与正式 HTTP 接口相同业务边界的内存模拟服务。
 * @param options - 模拟延迟和初始登录用户配置。
 * @returns 可注入 React 页面使用的 SkillApi 实例。
 */
export class MockSkillApi implements SkillApi {
  private readonly delayMs: number;
  private readonly skills = clone(mockSkillDetails);
  private readonly versions = new Map(Object.entries(mockVersions).map(([id, items]) => [id, clone(items)]));
  private readonly tags = clone(mockTags);
  private readonly versionFiles = new Map<string, StoredVersionFileSource>(Object.entries(mockVersionFiles).map(([id, source]) => [id, clone(source)]));
  private readonly versionSkillMd = new Map(Object.entries(mockVersionFiles).map(([id, source]) => [id, source.skillMd]));
  private readonly installationEvents = new Set<string>();
  private readonly notifications = clone(mockNotifications);
  private currentUser: UserDto | null;

  constructor(options: MockSkillApiOptions = {}) {
    this.delayMs = options.delayMs ?? 220;
    this.currentUser = options.initialUser ?? null;
  }

  /** 真实身份接入阶段用于同步 Mock 业务接口的当前用户。 */
  setCurrentUser(user: UserDto | null): void {
    this.currentUser = user ? clone(user) : null;
  }

  private async wait(): Promise<void> {
    await new Promise((resolve) => globalThis.setTimeout(resolve, this.delayMs));
  }

  private requireUser(): UserDto {
    if (!this.currentUser) throw new SkillApiError("UNAUTHENTICATED", "请先登录后再继续操作");
    if (this.currentUser.status === "DISABLED") throw new SkillApiError("USER_DISABLED", "当前用户已停用，请联系管理员");
    return this.currentUser;
  }

  private findSkill(skillId: string): SkillDetailDto {
    const skill = this.skills.find((item) => item.id === skillId);
    if (!skill) throw new SkillApiError("SKILL_NOT_FOUND", "没有找到该 Skill");
    return skill;
  }

  private findVersion(skillId: string, versionId: string): SkillVersionDto {
    this.findSkill(skillId);
    const version = (this.versions.get(skillId) ?? []).find((item) => item.id === versionId);
    if (!version) throw new SkillApiError("VERSION_NOT_FOUND", "没有找到该 Skill 版本");
    return version;
  }

  private canCollaborate(skill: SkillDetailDto, user: UserDto): boolean {
    return user.role === "ADMIN" || skill.owner.id === user.id || skill.collaborators.some((item) => item.id === user.id);
  }

  private resolveTags(tagIds: string[] = [], newTagNames: string[] = []): TagDto[] {
    const selected = this.tags.filter((tag) => tagIds.includes(tag.id));
    for (const rawName of newTagNames) {
      const name = rawName.trim();
      if (!name) continue;
      let tag = this.tags.find((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
      if (!tag) {
        tag = { id: crypto.randomUUID(), name };
        this.tags.push(tag);
      }
      if (!selected.some((item) => item.id === tag.id)) selected.push(tag);
    }
    if (selected.length > 5) throw new SkillApiError("INVALID_REQUEST", "每个 Skill 最多选择 5 个 Tag");
    return selected;
  }

  private checkDisplayName(displayName: string, confirmed = false, excludedSkillId?: string): void {
    const conflicts = this.skills.filter((item) => item.id !== excludedSkillId && item.displayName === displayName);
    if (conflicts.length > 0 && !confirmed) {
      throw new SkillApiError("DISPLAY_NAME_CONFIRMATION_REQUIRED", "平台中存在同名展示名称，请确认后继续", {
        conflicts: conflicts.map((item) => ({ id: item.id, displayName: item.displayName, skillName: item.skillName })),
      });
    }
  }

  async listSkills(query: ListSkillsQuery = {}): Promise<SkillPageDto> {
    await this.wait();
    const keyword = query.query?.trim().toLocaleLowerCase() ?? "";
    const tagIds = query.tagIds?.length
      ? query.tagIds
      : query.tagId
        ? [query.tagId]
        : [];
    let items = this.skills.filter(
      (skill) =>
        skill.status === "ACTIVE"
        && (tagIds.length === 0 || skill.tags.some((tag) => tagIds.includes(tag.id)))
        && (
          !query.departmentKey
          || JSON.stringify(skill.owner.departmentPath) === query.departmentKey
        )
        && [
          skill.skillName,
          skill.displayName,
          skill.skillDescription,
          skill.displayDescription,
          ...skill.tags.map((tag) => tag.name),
        ].join(" ").toLocaleLowerCase().includes(keyword),
    );
    items = [...items].sort((left, right) => {
      if (query.sort === "INSTALLS_DESC") return comparePopularSkills(left, right);
      if (query.sort === "CREATED_DESC") return Date.parse(right.createdAt) - Date.parse(left.createdAt);
      return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    });
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    return { items: clone(items.slice((page - 1) * pageSize, page * pageSize)), total: items.length, page, pageSize };
  }

  async listPublishedSkillDepartments(): Promise<
    PublishedSkillDepartmentDto[]
  > {
    await this.wait();
    const paths = new Map<string, string[]>();
    for (const skill of this.skills) {
      if (
        skill.status !== "ACTIVE"
        || skill.owner.departmentPath.length === 0
      ) {
        continue;
      }
      const path = skill.owner.departmentPath
        .map((item) => item.trim())
        .filter(Boolean);
      if (path.length > 0) paths.set(JSON.stringify(path), path);
    }
    return clone(
      [...paths.values()]
        .map((path) => ({
          id: JSON.stringify(path),
          name: path[path.length - 1]
            ?.split(/\s*[-‐‑‒–—]\s*/u)
            .filter(Boolean)
            .pop()
            || "",
          path,
        }))
        .sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
    );
  }

  async listMySkills(query: ListMySkillsQuery): Promise<SkillPageDto> {
    await this.wait();
    const user = this.requireUser();
    const items = this.skills.filter((skill) => {
      if (query.relation === "OWNED") return skill.owner.id === user.id && skill.status !== "ARCHIVED";
      return skill.collaborators.some((item) => item.id === user.id) && skill.status !== "ARCHIVED";
    });
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    return { items: clone(items.slice((page - 1) * pageSize, page * pageSize)), total: items.length, page, pageSize };
  }

  async resolvePublishTarget(skillName: string) {
    await this.wait();
    const user = this.requireUser();
    const target = this.skills.find(
      (skill) =>
        skill.skillName.toLocaleLowerCase() ===
        skillName.trim().toLocaleLowerCase(),
    );
    if (!target) return { state: "NOT_FOUND" as const, skill: null };
    if (target.owner.id !== user.id) {
      return { state: "TAKEN_BY_OTHER" as const, skill: null };
    }
    if (target.status !== "ACTIVE") {
      return { state: "UNAVAILABLE" as const, skill: null };
    }
    return { state: "OWNED" as const, skill: clone(target) };
  }

  async getSkill(skillId: string): Promise<SkillDetailDto> {
    await this.wait();
    const skill = this.findSkill(skillId);
    if (skill.status === "ARCHIVED" && (!this.currentUser || !this.canCollaborate(skill, this.currentUser))) throw new SkillApiError("SKILL_NOT_FOUND", "没有找到该 Skill");
    return clone(skill);
  }

  async listTags(query = ""): Promise<TagDto[]> {
    await this.wait();
    const keyword = query.trim().toLocaleLowerCase();
    return clone(this.tags.filter((tag) => tag.name.toLocaleLowerCase().includes(keyword)));
  }

  async listSkillVersions(skillId: string, query: ListVersionsQuery = {}): Promise<VersionPageDto> {
    await this.wait();
    this.findSkill(skillId);
    const items = this.versions.get(skillId) ?? [];
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    return { items: clone(items.slice((page - 1) * pageSize, page * pageSize)), total: items.length, page, pageSize };
  }

  async getSkillVersion(skillId: string, versionId: string): Promise<SkillVersionDetailDto> {
    await this.wait();
    const version = this.findVersion(skillId, versionId);
    return { ...clone(version), skillMd: this.versionSkillMd.get(versionId) ?? "" };
  }

  async listVersionFiles(skillId: string, versionId: string): Promise<FileEntryDto[]> {
    await this.wait();
    this.findVersion(skillId, versionId);
    const source = this.versionFiles.get(versionId);
    if (!source) throw new SkillApiError("FILE_NOT_FOUND", "没有找到该版本的文件清单");
    return clone(source.files);
  }

  async getVersionFileContent(skillId: string, versionId: string, path: string): Promise<SkillFileContentDto> {
    await this.wait();
    this.findVersion(skillId, versionId);
    const source = this.versionFiles.get(versionId);
    if (!source) throw new SkillApiError("FILE_NOT_FOUND", "没有找到该版本的文件清单");
    const file = source.files.find((entry) => entry.path === path && entry.type === "FILE");
    if (!file) throw new SkillApiError("FILE_NOT_FOUND", "没有找到该版本中的文件", { path });
    if (!file.previewable) throw new SkillApiError("FILE_PREVIEW_UNAVAILABLE", "该文件类型不支持文本预览", { path });
    if ("archive" in source) {
      const result = await readArchiveText(source, path);
      return { path, content: result.content, sha256: file.sha256 ?? "", mediaType: result.mediaType, encoding: "UTF-8", size: result.size };
    }
    const content = source.contents[path];
    if (content === undefined) throw new SkillApiError("FILE_PREVIEW_UNAVAILABLE", "该文件类型不支持文本预览", { path });
    return { path, content, sha256: file.sha256 ?? "", encoding: "UTF-8", size: new TextEncoder().encode(content).byteLength };
  }

  async createSkill(input: CreateSkillDto): Promise<SkillDetailDto> {
    await this.wait();
    const user = this.requireUser();
    console.info("[MockSkillApi] 开始校验新 Skill ZIP", { fileName: input.file.name });
    const parsed = await parseSkillPackage(input.file);
    if (this.skills.some((skill) => skill.skillName === parsed.inspection.skillName)) throw new SkillApiError("DUPLICATE_SKILL_NAME", "该 Skill 名称已经存在，请发布为新版本");
    this.checkDisplayName(input.displayName, input.confirmDuplicateDisplayName);
    const resolvedTags = this.resolveTags(input.tagIds, input.newTagNames);
    const now = new Date().toISOString();
    const skillId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const version: SkillVersionDto = {
      id: versionId, skillId, version: nextDateSkillVersion(), status: "PUBLISHED", skillName: parsed.inspection.skillName,
      skillDescription: parsed.inspection.skillDescription, changelog: input.changelog?.trim() || "首次发布", baseVersionId: null,
      packageSize: parsed.inspection.packageSize, packageSha256: parsed.inspection.packageSha256, contentHash: parsed.inspection.contentHash,
      uploadedBy: user, publishedAt: now, withdrawnBy: null, withdrawnAt: null, withdrawalReason: null,
    };
    const derivedSkill = input.forkedFromSkillId ? this.findSkill(input.forkedFromSkillId) : null;
    const derivedVersion = derivedSkill && input.forkedFromVersionId ? this.findVersion(derivedSkill.id, input.forkedFromVersionId) : null;
    const skill: SkillDetailDto = {
      id: skillId, skillName: version.skillName, displayName: input.displayName, skillDescription: version.skillDescription,
      displayDescription: input.displayDescription, status: "ACTIVE", owner: user, collaborators: [],
      tags: resolvedTags, currentVersion: version, installCount: 0,
      derivedFrom: derivedSkill && derivedVersion ? { skillId: derivedSkill.id, skillName: derivedSkill.skillName, versionId: derivedVersion.id, version: derivedVersion.version, status: derivedSkill.status, linkable: derivedSkill.status === "ACTIVE" } : null,
      derivedChain: derivedSkill && derivedVersion ? [...derivedSkill.derivedChain, { skillId: derivedSkill.id, skillName: derivedSkill.skillName, versionId: derivedVersion.id, version: derivedVersion.version, status: derivedSkill.status, linkable: derivedSkill.status === "ACTIVE" }] : [],
      updatedBy: user, archivedAt: null, archiveReason: null, nameConflictReason: null, createdAt: now, updatedAt: now,
    };
    this.skills.unshift(skill);
    this.versions.set(skillId, [version]);
    this.versionFiles.set(versionId, parsed.source);
    this.versionSkillMd.set(versionId, parsed.inspection.skillMd);
    console.info("[MockSkillApi] Skill 创建完成", { skillId });
    return clone(skill);
  }

  async deleteSkill(skillId: string): Promise<DeleteSkillResultDto> {
    await this.wait();
    const user = this.requireUser();
    const skillIndex = this.skills.findIndex(
      (skill) => skill.id === skillId,
    );
    if (skillIndex < 0) {
      throw new SkillApiError(
        "SKILL_NOT_FOUND",
        "没有找到该 Skill",
      );
    }
    const skill = this.skills[skillIndex];
    if (skill.owner.id !== user.id) {
      throw new SkillApiError(
        "OWNER_REQUIRED",
        "只有 Skill Owner 可以永久删除",
      );
    }
    const objectCount = (this.versions.get(skillId) || []).length;
    this.skills.splice(skillIndex, 1);
    this.versions.delete(skillId);
    return {
      id: skillId,
      deletedObjectCount: objectCount,
      objectCount,
      ossCleaned: true,
    };
  }

  async deleteSkillVersion(
    skillId: string,
    versionId: string,
  ): Promise<DeleteSkillVersionResultDto> {
    await this.wait();
    const user = this.requireUser();
    const skill = this.findSkill(skillId);
    if (skill.owner.id !== user.id) {
      throw new SkillApiError(
        "OWNER_REQUIRED",
        "只有 Skill Owner 可以删除版本",
      );
    }
    const versions = this.versions.get(skillId) ?? [];
    const versionIndex = versions.findIndex(
      (version) => version.id === versionId,
    );
    if (versionIndex < 0) {
      throw new SkillApiError(
        "VERSION_NOT_FOUND",
        "没有找到该 Skill 版本",
      );
    }
    if (versions.length <= 1) {
      throw new SkillApiError(
        "LAST_VERSION_REQUIRED",
        "至少需要保留一个版本，无法删除",
      );
    }

    versions.splice(versionIndex, 1);
    const latestVersion = versions[0];
    if (skill.currentVersion.id === versionId) {
      skill.currentVersion = clone(latestVersion);
      skill.updatedBy = clone(latestVersion.uploadedBy);
    }
    skill.updatedAt = new Date().toISOString();
    this.versionFiles.delete(versionId);
    this.versionSkillMd.delete(versionId);

    return {
      versionId,
      latestVersionId: skill.currentVersion.id,
      ossCleaned: true,
    };
  }

  async updateSkillMetadata(skillId: string, input: UpdateSkillMetadataDto): Promise<SkillDetailDto> {
    await this.wait();
    const user = this.requireUser();
    const skill = this.findSkill(skillId);
    if (skill.owner.id !== user.id) throw new SkillApiError("OWNER_REQUIRED", "只有 Owner 可以修改展示信息");
    if (input.displayName !== undefined) this.checkDisplayName(input.displayName, input.confirmDuplicateDisplayName, skillId);
    const resolvedTags = input.tagIds !== undefined || input.newTagNames !== undefined
      ? this.resolveTags(input.tagIds, input.newTagNames)
      : undefined;
    if (input.displayName !== undefined) skill.displayName = input.displayName;
    if (input.displayDescription !== undefined) skill.displayDescription = input.displayDescription;
    if (resolvedTags) skill.tags = resolvedTags;
    skill.updatedBy = user;
    skill.updatedAt = new Date().toISOString();
    return clone(skill);
  }

  async publishSkillVersion(skillId: string, input: PublishSkillVersionDto): Promise<SkillDetailDto> {
    await this.wait();
    const user = this.requireUser();
    const skill = this.findSkill(skillId);
    if (skill.owner.id !== user.id) throw new SkillApiError("OWNER_REQUIRED", "只有 Owner 可以发布新版本");
    if (skill.status !== "ACTIVE") throw new SkillApiError("SKILL_UNAVAILABLE", "当前 Skill 状态不允许发布新版本");
    const parsed = await parseSkillPackage(input.file);
    if (parsed.inspection.skillName !== skill.skillName) throw new SkillApiError("SKILL_NAME_MISMATCH", "ZIP 中的 Skill 名称与目标 Skill 不一致，建议发布为新的 Skill", { expectedSkillName: skill.skillName, actualSkillName: parsed.inspection.skillName });
    const versions = this.versions.get(skillId) ?? [];
    if (input.baseVersionId !== skill.currentVersion.id) throw new SkillApiError("VERSION_CONFLICT", "发布期间已经出现新版本，请刷新后重试", { currentVersion: skill.currentVersion.version });
    const expectedVersion = nextDateSkillVersion(skill.currentVersion.version);
    if (input.version !== expectedVersion) throw new SkillApiError("VERSION_CONFLICT", "版本号已变化，请刷新后重试", { expectedVersion });
    if (versions.some((version) => version.version === input.version)) throw new SkillApiError("VERSION_ALREADY_EXISTS", "该版本号已经存在");
    if (compareSemVer(input.version, skill.currentVersion.version) <= 0) throw new SkillApiError("VERSION_NOT_GREATER", "新版本必须高于当前版本");
    if (versions.some((version) => version.contentHash === parsed.inspection.contentHash)) throw new SkillApiError("CONTENT_UNCHANGED", "ZIP 内容与历史版本一致，无需重复发布");
    if (input.displayName !== undefined) this.checkDisplayName(input.displayName, input.confirmDuplicateDisplayName, skillId);
    const resolvedTags = input.tagIds !== undefined || input.newTagNames !== undefined
      ? this.resolveTags(input.tagIds, input.newTagNames)
      : undefined;
    const now = new Date().toISOString();
    const version: SkillVersionDto = {
      id: crypto.randomUUID(), skillId, version: input.version, status: "PUBLISHED", skillName: parsed.inspection.skillName,
      skillDescription: parsed.inspection.skillDescription, changelog: input.changelog, baseVersionId: input.baseVersionId,
      packageSize: parsed.inspection.packageSize, packageSha256: parsed.inspection.packageSha256, contentHash: parsed.inspection.contentHash,
      uploadedBy: user, publishedAt: now, withdrawnBy: null, withdrawnAt: null, withdrawalReason: null,
    };
    versions.unshift(version);
    skill.currentVersion = version;
    skill.skillDescription = version.skillDescription;
    if (input.displayName !== undefined) skill.displayName = input.displayName;
    if (input.displayDescription !== undefined) skill.displayDescription = input.displayDescription;
    if (resolvedTags) skill.tags = resolvedTags;
    skill.updatedBy = user;
    skill.updatedAt = now;
    this.versionFiles.set(version.id, parsed.source);
    this.versionSkillMd.set(version.id, parsed.inspection.skillMd);
    return clone(skill);
  }

  async getInstallationStatus(skillId: string, versionId?: string): Promise<InstallationStatusDto> {
    await this.wait();
    const skill = this.findSkill(skillId);
    const installedVersion = versionId ? (this.versions.get(skillId) ?? []).find((version) => version.id === versionId) : undefined;
    const withdrawn = installedVersion?.status === "WITHDRAWN";
    return {
      skillId,
      status: skill.status,
      archivedAt: skill.archivedAt,
      archiveReason: skill.archiveReason,
      nameConflictReason: skill.nameConflictReason,
      versionStatus: installedVersion?.status ?? null,
      withdrawalReason: installedVersion?.withdrawalReason ?? null,
      recommendedVersion: withdrawn
        ? { id: skill.currentVersion.id, version: skill.currentVersion.version }
        : null,
    };
  }

  /**
   * 功能说明：签发模拟下载凭证，并生成可供真实 Tauri 安装器使用的 ZIP data URL。
   * @param skillId - 需要安装的 Skill ID。
   * @param versionId - 需要安装的版本 ID。
   * @returns 包含可下载 ZIP、实际包哈希和内容哈希的模拟凭证。
   */
  async getDownloadTicket(skillId: string, versionId: string): Promise<DownloadTicketDto> {
    await this.wait();
    this.requireUser();
    const skill = this.findSkill(skillId);
    const version = this.findVersion(skillId, versionId);
    if (skill.status !== "ACTIVE" || version.status !== "PUBLISHED") throw new SkillApiError("INSTALLATION_UNAVAILABLE", "当前版本不可安装");
    const scenario = mockInstallScenarios[skillId];
    if (scenario?.downloadError) {
      console.error("[MockSkillApi] 模拟安装包校验失败", { skillId, versionId, code: scenario.downloadError.code });
      throw new SkillApiError(scenario.downloadError.code, scenario.downloadError.message);
    }
    const source = this.versionFiles.get(versionId);
    if (!source) {
      throw new SkillApiError("FILE_NOT_FOUND", "没有找到该版本的安装文件");
    }
    const archive = "archive" in source ? source.archive : new JSZip();
    if (!("archive" in source)) {
      for (const entry of source.files) {
        if (entry.type !== "FILE") continue;
        const content = source.contents[entry.path]
          ?? new Uint8Array(Math.max(0, entry.size ?? 0));
        archive.file(entry.path, content);
      }
    }
    const bytes = await archive.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const packageSha256 = await sha256(bytes);
    console.info("[MockSkillApi] 已生成可安装的模拟 ZIP", {
      skillId,
      versionId,
      packageSize: bytes.byteLength,
    });
    return {
      url: `data:application/zip;base64,${toBase64(bytes)}`,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      packageSha256,
      contentHash: version.contentHash,
    };
  }

  async resolveInstallation(input: { skillName: string; contentHash: string }): Promise<InstallationResolutionDto> {
    await this.wait();
    const skill = this.skills.find((item) => item.skillName === input.skillName);
    const version = skill ? (this.versions.get(skill.id) ?? []).find((item) => item.contentHash === input.contentHash) : null;
    return { matched: Boolean(skill && version), skillId: skill?.id ?? null, versionId: version?.id ?? null, status: skill?.status ?? null, archivedAt: skill?.archivedAt ?? null, archiveReason: skill?.archiveReason ?? null };
  }

  async recordInstallation(event: InstallationEventDto): Promise<void> {
    await this.wait();
    this.requireUser();
    const skill = this.findSkill(event.skillId);
    this.findVersion(event.skillId, event.versionId);
    if (!this.installationEvents.has(event.eventId)) {
      this.installationEvents.add(event.eventId);
      skill.installCount += 1;
    }
  }

  async listNotifications(query: ListNotificationsQuery = {}): Promise<NotificationPageDto> {
    await this.wait();
    this.requireUser();
    const items = this.notifications.filter((item) => !query.unreadOnly || item.readAt === null);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    return { items: clone(items.slice((page - 1) * pageSize, page * pageSize)), total: items.length, unreadCount: this.notifications.filter((item) => item.readAt === null).length, page, pageSize };
  }

  async readNotification(notificationId: string): Promise<void> { await this.wait(); this.requireUser(); const item = this.notifications.find((notification) => notification.id === notificationId); if (item) item.readAt = new Date().toISOString(); }
  async readAllNotifications(): Promise<void> { await this.wait(); this.requireUser(); const now = new Date().toISOString(); this.notifications.forEach((item) => { if (!item.readAt) item.readAt = now; }); }
  async getCurrentUser(): Promise<UserDto | null> { await this.wait(); return clone(this.currentUser); }
  async signIn(_options?: SignInOptions): Promise<UserDto> { await this.wait(); this.currentUser = clone(mockUsers.current); console.info("[MockSkillApi] 模拟飞书登录完成", { userId: this.currentUser.id }); return clone(this.currentUser); }
  cancelSignIn(): void {}
  async signOut(): Promise<void> { await this.wait(); this.currentUser = null; console.info("[MockSkillApi] 模拟用户退出登录"); }
}
