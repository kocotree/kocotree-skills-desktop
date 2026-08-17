import JSZip, { type JSZipObject } from "jszip";
import { parse as parseYaml } from "yaml";
import { SkillApiError, type SkillFileEntryDto } from "./contracts";

const MAX_FILE_COUNT = 2_000;
const MAX_TREE_ENTRY_COUNT = 5_000;
const MAX_UNCOMPRESSED_SIZE = 200 * 1024 * 1024;
const MAX_PREVIEW_SIZE = 1024 * 1024;
const SKILL_MD_NAME = "SKILL.md";
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const TEXT_MEDIA_TYPES: Record<string, string> = {
  ".css": "text/css",
  ".csv": "text/csv",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".jsx": "text/javascript",
  ".md": "text/markdown",
  ".ps1": "text/plain",
  ".py": "text/x-python",
  ".rs": "text/x-rust",
  ".sh": "text/x-shellscript",
  ".sql": "text/x-sql",
  ".toml": "application/toml",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
};

interface ZipObjectWithSize extends JSZipObject {
  unsafeOriginalName?: string;
  _data?: {
    uncompressedSize?: number;
  };
}

export interface SkillArchiveSource {
  archive: JSZip;
  files: SkillFileEntryDto[];
  originalPathByNormalized: Map<string, string>;
}

export interface ZipInspectionResult extends SkillArchiveSource {
  skillName: string;
  skillDescription: string;
  skillMd: string;
  contentHash: string;
  ignoredSystemPaths: string[];
}

function invalidPackage(message: string, details?: Record<string, unknown>): never {
  throw new SkillApiError("INVALID_SKILL_PACKAGE", message, details);
}

function getOriginalPath(entry: ZipObjectWithSize): string {
  return (entry.unsafeOriginalName ?? entry.name).replace(/\/$/, "");
}

function validateArchivePath(path: string): string {
  if (path.length > 1_024) {
    return invalidPackage("ZIP 中的文件路径不能超过 1024 个字符", { path });
  }
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    return invalidPackage("ZIP 中包含不安全的文件路径", { path });
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return invalidPackage("ZIP 中包含路径穿越或无效路径", { path });
  }
  return segments.join("/");
}

export function isIgnoredUploadPath(path: string): boolean {
  const segments = path.split("/").map((segment) => segment.toLocaleLowerCase());
  const fileName = segments[segments.length - 1] ?? "";
  return segments.includes("__macosx")
    || segments.includes("__pycache__")
    || fileName === ".ds_store"
    || fileName === ".kocotree-skill.json"
    || fileName === ".kocotree-managed-copy.json"
    || fileName === "thumbs.db"
    || fileName === "desktop.ini"
    || fileName.startsWith("._")
    || fileName.endsWith(".pyc")
    || fileName.endsWith(".pyo");
}

function isSymbolicLink(entry: JSZipObject): boolean {
  const permissions = entry.unixPermissions;
  if (permissions === null || permissions === undefined) return false;
  const mode = typeof permissions === "string" ? Number.parseInt(permissions, 8) : permissions;
  return Number.isFinite(mode) && (mode & 0o170000) === 0o120000;
}

function getUncompressedSize(entry: ZipObjectWithSize): number | null {
  const size = entry._data?.uncompressedSize;
  return typeof size === "number" && Number.isFinite(size) ? size : null;
}

function getMediaType(path: string): string | null {
  const dotIndex = path.lastIndexOf(".");
  if (dotIndex < 0) return null;
  return TEXT_MEDIA_TYPES[path.slice(dotIndex).toLocaleLowerCase()] ?? null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSkillFrontmatter(skillMd: string): { skillName: string; skillDescription: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skillMd);
  if (!match) {
    return invalidPackage("SKILL.md 缺少合法的 YAML frontmatter");
  }

  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(match[1], { maxAliasCount: 50 });
  } catch {
    return invalidPackage("SKILL.md 的 YAML frontmatter 无法解析");
  }
  if (!isPlainObject(frontmatter)) {
    return invalidPackage("SKILL.md 的 frontmatter 必须是对象");
  }
  const skillName = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  const skillDescription = typeof frontmatter.description === "string"
    ? frontmatter.description.trim()
    : "";
  if (!skillName || skillName.length > 64 || !SKILL_NAME_PATTERN.test(skillName)) {
    return invalidPackage("SKILL.md 的 name 必须使用小写字母、数字和单个连字符，且不能超过 64 个字符");
  }
  if (!skillDescription || skillDescription.length > 1_000) {
    return invalidPackage("SKILL.md 的 description 必须为 1 至 1000 个字符");
  }
  return { skillName, skillDescription };
}

async function digestHex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function readEntryBytes(entry: JSZipObject): Promise<Uint8Array> {
  try {
    return await entry.async("uint8array");
  } catch {
    return invalidPackage("ZIP 中的文件无法解压", { path: entry.name });
  }
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SkillApiError("FILE_PREVIEW_UNAVAILABLE", "文件不是有效的 UTF-8 文本", { path });
  }
}

/**
 * 功能说明：解析并校验 Skill ZIP，生成发布元数据、规范化文件清单和目录内容哈希。
 * @param buffer - 原始 ZIP 的完整字节数据。
 * @returns 可用于发布和后续文件预览的 ZIP 解析结果。
 */
export async function inspectSkillZip(buffer: ArrayBuffer): Promise<ZipInspectionResult> {
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(buffer, { createFolders: true });
  } catch {
    return invalidPackage("ZIP 已损坏或无法读取");
  }

  const validatedEntries = Object.values(archive.files)
    .map((entry) => ({
      entry,
      originalPath: validateArchivePath(getOriginalPath(entry)),
    }));
  const ignoredSystemPaths = validatedEntries
    .filter(({ originalPath }) => isIgnoredUploadPath(originalPath))
    .map(({ entry }) => entry.name);
  const safeEntries = validatedEntries
    .filter(({ originalPath }) => !isIgnoredUploadPath(originalPath));

  if (safeEntries.some(({ entry }) => isSymbolicLink(entry))) {
    return invalidPackage("ZIP 不能包含符号链接或其他链接文件");
  }

  const regularFiles = safeEntries.filter(({ entry }) => !entry.dir);
  if (regularFiles.length > MAX_FILE_COUNT) {
    throw new SkillApiError("PACKAGE_TOO_LARGE", `ZIP 中的普通文件不能超过 ${MAX_FILE_COUNT} 个`);
  }

  const skillMdCandidates = regularFiles.filter(({ originalPath }) => {
    const segments = originalPath.split("/");
    return segments[segments.length - 1] === SKILL_MD_NAME && segments.length <= 2;
  });
  if (skillMdCandidates.length !== 1) {
    return invalidPackage("ZIP 根目录或单层外包装目录中必须且只能包含一个 SKILL.md");
  }

  const skillMdOriginalPath = skillMdCandidates[0].originalPath;
  const skillMdSegments = skillMdOriginalPath.split("/");
  const rootPrefix = skillMdSegments.length === 2 ? `${skillMdSegments[0]}/` : "";
  const contentEntries = safeEntries.filter(({ originalPath }) => {
    if (!rootPrefix) return true;
    if (originalPath === rootPrefix.slice(0, -1)) return false;
    if (!originalPath.startsWith(rootPrefix)) {
      return invalidPackage("ZIP 的单层外包装目录之外不能包含其他文件", { path: originalPath });
    }
    return true;
  });

  const originalPathByNormalized = new Map<string, string>();
  const normalizedPathKeys = new Map<string, string>();
  const directoryPaths = new Set<string>();
  const fileEntries: SkillFileEntryDto[] = [];
  let totalUncompressedSize = 0;

  for (const { entry, originalPath } of contentEntries) {
    const normalizedPath = rootPrefix ? originalPath.slice(rootPrefix.length) : originalPath;
    if (!normalizedPath) continue;
    const collisionKey = normalizedPath.toLocaleLowerCase();
    const existingPath = normalizedPathKeys.get(collisionKey);
    if (existingPath && existingPath !== normalizedPath) {
      return invalidPackage("ZIP 中包含大小写冲突的路径", { paths: [existingPath, normalizedPath] });
    }
    normalizedPathKeys.set(collisionKey, normalizedPath);

    const segments = normalizedPath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directoryPaths.add(segments.slice(0, index).join("/"));
    }
    if (entry.dir) {
      directoryPaths.add(normalizedPath);
      continue;
    }

    const size = getUncompressedSize(entry as ZipObjectWithSize);
    if (size !== null) totalUncompressedSize += size;
    const mediaType = getMediaType(normalizedPath);
    fileEntries.push({
      path: normalizedPath,
      type: "FILE",
      size,
      sha256: null,
      mediaType,
      previewable: mediaType !== null,
    });
    originalPathByNormalized.set(normalizedPath, originalPath);
  }

  if (totalUncompressedSize > MAX_UNCOMPRESSED_SIZE) {
    throw new SkillApiError("PACKAGE_TOO_LARGE", "ZIP 解压后的总大小不能超过 200 MB");
  }
  if (directoryPaths.size + fileEntries.length > MAX_TREE_ENTRY_COUNT) {
    throw new SkillApiError("PACKAGE_TOO_LARGE", `ZIP 文件树不能超过 ${MAX_TREE_ENTRY_COUNT} 个条目`);
  }

  const manifestLines: string[] = [];
  for (const fileEntry of [...fileEntries].sort((left, right) => left.path.localeCompare(right.path))) {
    const originalPath = originalPathByNormalized.get(fileEntry.path)!;
    const bytes = await readEntryBytes(archive.file(originalPath)!);
    if (fileEntry.size === null) fileEntry.size = bytes.byteLength;
    totalUncompressedSize += getUncompressedSize(archive.file(originalPath)! as ZipObjectWithSize) === null
      ? bytes.byteLength
      : 0;
    if (totalUncompressedSize > MAX_UNCOMPRESSED_SIZE) {
      throw new SkillApiError("PACKAGE_TOO_LARGE", "ZIP 解压后的总大小不能超过 200 MB");
    }
    const fileHash = await digestHex(toArrayBuffer(bytes));
    fileEntry.sha256 = `sha256:${fileHash}`;
    manifestLines.push(`${fileEntry.path}\0${fileHash}\n`);
  }

  const skillMdEntry = archive.file(skillMdOriginalPath);
  if (!skillMdEntry) return invalidPackage("ZIP 中没有找到 SKILL.md");
  const skillMdBytes = await readEntryBytes(skillMdEntry);
  if (skillMdBytes.byteLength > MAX_PREVIEW_SIZE) {
    return invalidPackage("SKILL.md 不能超过 1 MB");
  }
  let skillMd: string;
  try {
    skillMd = decodeUtf8(skillMdBytes, SKILL_MD_NAME);
  } catch {
    return invalidPackage("SKILL.md 必须是 UTF-8 文本");
  }
  const { skillName, skillDescription } = parseSkillFrontmatter(skillMd);
  const contentHash = `sha256:${await digestHex(toArrayBuffer(new TextEncoder().encode(manifestLines.join(""))))}`;
  const files: SkillFileEntryDto[] = [
    ...Array.from(directoryPaths, (path): SkillFileEntryDto => ({
      path,
      type: "DIRECTORY",
      size: null,
      sha256: null,
      mediaType: null,
      previewable: false,
    })),
    ...fileEntries,
  ].sort((left, right) => left.path.localeCompare(right.path) || left.type.localeCompare(right.type));

  return {
    archive,
    files,
    originalPathByNormalized,
    skillName,
    skillDescription,
    skillMd,
    contentHash,
    ignoredSystemPaths,
  };
}

/**
 * 功能说明：按规范化路径读取已解析 ZIP 中的单个 UTF-8 文本文件。
 * @param source - ZIP 解析后保留的文件来源。
 * @param path - 文件树接口返回的规范化相对路径。
 * @returns 文件内容、媒体类型和实际字节数。
 */
export async function readArchiveText(
  source: SkillArchiveSource,
  path: string,
): Promise<{ content: string; mediaType: string; size: number }> {
  const file = source.files.find((entry) => entry.path === path && entry.type === "FILE");
  if (!file) throw new SkillApiError("FILE_NOT_FOUND", "没有找到该版本中的文件", { path });
  if (!file.previewable || !file.mediaType) {
    throw new SkillApiError("FILE_PREVIEW_UNAVAILABLE", "该文件类型不支持文本预览", { path });
  }
  if (file.size !== null && file.size > MAX_PREVIEW_SIZE) {
    throw new SkillApiError("FILE_PREVIEW_UNAVAILABLE", "文本文件超过 1 MB 预览上限", { path });
  }
  const originalPath = source.originalPathByNormalized.get(path);
  const entry = originalPath ? source.archive.file(originalPath) : null;
  if (!entry) throw new SkillApiError("FILE_NOT_FOUND", "没有找到该版本中的文件", { path });
  const bytes = await readEntryBytes(entry);
  if (bytes.byteLength > MAX_PREVIEW_SIZE) {
    throw new SkillApiError("FILE_PREVIEW_UNAVAILABLE", "文本文件超过 1 MB 预览上限", { path });
  }
  return { content: decodeUtf8(bytes, path), mediaType: file.mediaType, size: bytes.byteLength };
}
