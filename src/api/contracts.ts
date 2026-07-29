import type { components, operations } from "./schema";

/** HTTP 成功响应外层；真实客户端完成校验后向页面返回 data。 */
export type ApiSuccessDto<T> = (
  | components["schemas"]["ApiOkMeta"]
  | components["schemas"]["ApiCreatedMeta"]
) & { data: T };
/** HTTP 失败响应外层；data 保存结构化错误详情。 */
export type ApiErrorDto = components["schemas"]["ErrorResponse"];
export type UserDto = components["schemas"]["User"];
export type TagDto = components["schemas"]["Tag"];
export type DerivedSourceDto = components["schemas"]["DerivedSource"];
export type SkillSummaryDto = components["schemas"]["SkillSummary"];
export type SkillDetailDto = components["schemas"]["SkillDetail"];
export type SkillVersionDto = components["schemas"]["SkillVersion"];
export type SkillVersionDetailDto = components["schemas"]["SkillVersionDetail"];
export type SkillPageDto = components["schemas"]["SkillPage"];
export type VersionPageDto = components["schemas"]["VersionPage"];
export type FileEntryDto = components["schemas"]["FileEntry"];
export type FileContentDto = components["schemas"]["FileContent"];
/** 本地 ZIP 解析额外保留媒体类型，提交平台时会映射为 FileEntry。 */
export interface SkillFileEntryDto extends FileEntryDto {
  mediaType: string | null;
}
/** 文件预览适配模型，媒体类型和字节数仅供客户端展示。 */
export interface SkillFileContentDto extends FileContentDto {
  mediaType?: string;
  encoding?: "UTF-8";
  size?: number;
}
export type DownloadTicketDto = components["schemas"]["DownloadTicket"];
export type InstallationStatusDto = components["schemas"]["InstallationStatus"];
export type InstallationResolutionDto = components["schemas"]["InstallationResolution"];
export type NotificationDto = components["schemas"]["Notification"];
export type NotificationPageDto = components["schemas"]["NotificationPage"];
export type OwnershipTransferDto = components["schemas"]["OwnershipTransfer"];
export type ReasonDto = components["schemas"]["ReasonRequest"];
export type CreateOwnershipTransferDto = components["schemas"]["CreateOwnershipTransferRequest"];
export interface CreateSkillDto {
  file: File;
  displayName: string;
  displayDescription: string;
  tagIds?: string[];
  newTagNames?: string[];
  forkedFromSkillId?: string;
  forkedFromVersionId?: string;
  confirmDuplicateDisplayName?: boolean;
}
export interface PublishSkillVersionDto {
  file: File;
  baseVersionId: string;
  version: string;
  changelog: string;
  displayName?: string;
  displayDescription?: string;
  tagIds?: string[];
  newTagNames?: string[];
  confirmDuplicateDisplayName?: boolean;
}
export interface UpdateSkillMetadataDto {
  displayName?: string;
  displayDescription?: string;
  tagIds?: string[];
  newTagNames?: string[];
  confirmDuplicateDisplayName?: boolean;
}
export interface DeleteSkillResultDto {
  id: string;
  deletedObjectCount: number;
  objectCount: number;
  ossCleaned: boolean;
}
export type ResolveInstallationDto = components["schemas"]["ResolveInstallationRequest"];
export type InstallationEventDto = components["schemas"]["InstallationEventRequest"];

export type ListSkillsQuery = NonNullable<operations["listSkills"]["parameters"]["query"]>;
export type ListMySkillsQuery = NonNullable<operations["listMySkills"]["parameters"]["query"]>;
export type ListVersionsQuery = NonNullable<operations["listSkillVersions"]["parameters"]["query"]>;
export type ListNotificationsQuery = NonNullable<operations["listNotifications"]["parameters"]["query"]>;

/** 客户端本地安装状态，不属于服务端 Skill DTO。 */
export type LocalSkillStatus =
  | "PLATFORM_INSTALLED"
  | "PLATFORM_MODIFIED"
  | "PLATFORM_MATCHED"
  | "LOCAL_UNKNOWN"
  | "MISSING";

export type LocalSkillLocation =
  | "MANAGER"
  | "AGENTS"
  | "CLAUDE"
  | "CODEX";

export type LocalSkillEntryKind =
  | "DIRECTORY"
  | "SYMLINK"
  | "JUNCTION"
  | "COPY";

export type LocalSkillAgent = "agents" | "claude" | "codex";

/** 客户端扫描和合并展示用的本地 Skill 记录。 */
export interface LocalSkillRecord {
  id: string;
  skillId: string | null;
  versionId: string | null;
  version: string | null;
  skillName: string;
  displayName: string;
  installPath: string;
  contentHash: string;
  installedAt: string | null;
  status: LocalSkillStatus;
  location?: LocalSkillLocation;
  entryKind?: LocalSkillEntryKind;
  resolvedPath?: string;
  assignedAgents?: LocalSkillAgent[];
}

export interface SetLocalSkillEnabledInput {
  skillName: string;
  sourcePath: string;
  agent: LocalSkillAgent;
  enabled: boolean;
}

export interface RemoveLocalSkillInput {
  skillId: string;
  skillName: string;
}

export interface LocalInstallRequest {
  skill: SkillSummaryDto;
  version: SkillVersionDto;
  ticket?: DownloadTicketDto;
  force?: boolean;
}

export interface LocalInstallResult {
  record: LocalSkillRecord;
  replacedSkillName: string | null;
  backupPath: string | null;
  notices: string[];
}

/**
 * 功能说明：隔离真实 Tauri 安装器与浏览器 Mock 安装器。
 * 返回值：指定平台版本的本地安装结果。
 */
export interface SkillInstaller {
  install(input: LocalInstallRequest): Promise<LocalInstallResult>;
}

/**
 * 功能说明：隔离 Tauri 文件系统实现与 React 页面，浏览器阶段由 Mock 实现。
 * 返回值：本地扫描和安装操作的异步结果。
 */
export interface LocalSkillService extends SkillInstaller {
  scanSkills(): Promise<LocalSkillRecord[]>;
  setSkillEnabled(input: SetLocalSkillEnabledInput): Promise<LocalSkillRecord[]>;
  remove(input: RemoveLocalSkillInput): Promise<LocalSkillRecord[]>;
}

/**
 * 功能说明：约束模拟接口和未来 HTTP 接口共同实现的平台能力。
 * 返回值：各方法均返回 HTTP 响应外层中的 data，页面不直接处理 code 和 msg。
 */
export interface SkillApi {
  listSkills(query?: ListSkillsQuery): Promise<SkillPageDto>;
  listMySkills(query: ListMySkillsQuery): Promise<SkillPageDto>;
  getSkill(skillId: string): Promise<SkillDetailDto>;
  listTags(query?: string): Promise<TagDto[]>;
  listSkillVersions(skillId: string, query?: ListVersionsQuery): Promise<VersionPageDto>;
  getSkillVersion(skillId: string, versionId: string): Promise<SkillVersionDetailDto>;
  listVersionFiles(skillId: string, versionId: string): Promise<FileEntryDto[]>;
  getVersionFileContent(skillId: string, versionId: string, path: string): Promise<SkillFileContentDto>;
  createSkill(input: CreateSkillDto): Promise<SkillDetailDto>;
  deleteSkill(skillId: string): Promise<DeleteSkillResultDto>;
  updateSkillMetadata(skillId: string, input: UpdateSkillMetadataDto): Promise<SkillDetailDto>;
  publishSkillVersion(skillId: string, input: PublishSkillVersionDto): Promise<SkillDetailDto>;
  withdrawSkillVersion(skillId: string, versionId: string, input: ReasonDto): Promise<SkillVersionDto>;
  archiveSkill(skillId: string, input: ReasonDto): Promise<SkillDetailDto>;
  restoreSkill(skillId: string, input: ReasonDto): Promise<SkillDetailDto>;
  getInstallationStatus(skillId: string, versionId?: string): Promise<InstallationStatusDto>;
  createOwnershipTransfer(skillId: string, input: CreateOwnershipTransferDto): Promise<OwnershipTransferDto>;
  acceptOwnershipTransfer(transferId: string): Promise<OwnershipTransferDto>;
  rejectOwnershipTransfer(transferId: string): Promise<OwnershipTransferDto>;
  cancelOwnershipTransfer(transferId: string): Promise<OwnershipTransferDto>;
  getDownloadTicket(skillId: string, versionId: string): Promise<DownloadTicketDto>;
  resolveInstallation(input: ResolveInstallationDto): Promise<InstallationResolutionDto>;
  recordInstallation(event: InstallationEventDto): Promise<void>;
  listNotifications(query?: ListNotificationsQuery): Promise<NotificationPageDto>;
  readNotification(notificationId: string): Promise<void>;
  readAllNotifications(): Promise<void>;
  getCurrentUser(): Promise<UserDto | null>;
  signIn(): Promise<UserDto>;
  signOut(): Promise<void>;
}

/** 模拟接口返回的结构化业务错误。 */
export class SkillApiError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "SkillApiError";
    this.code = code;
    this.details = details;
  }
}
