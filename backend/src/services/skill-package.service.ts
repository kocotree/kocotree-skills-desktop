import { createHash } from "node:crypto";
import path from "node:path";
import { buffer as streamToBuffer } from "node:stream/consumers";
import { parse as parseYaml } from "yaml";
import yauzl from "yauzl";
import yazl from "yazl";
import { config } from "../config";

const MAX_FILE_COUNT = 2_000;
const MAX_TREE_ENTRY_COUNT = 5_000;
const MAX_UNCOMPRESSED_SIZE = 200 * 1024 * 1024;
const MAX_SKILL_MD_SIZE = 1024 * 1024;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const textExtensions = new Set([
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".css",
  ".html",
  ".xml",
  ".toml",
  ".ini",
  ".env",
  ".gitignore",
]);

export type PreparedSkillFile = {
  path: string;
  buffer: Buffer;
  sizeBytes: number;
  checksumSha256: string;
};

export type PreparedSkillEntry =
  | {
      path: string;
      type: "FOLDER";
      sizeBytes: null;
      checksumSha256: null;
      sortOrder: number;
    }
  | {
      path: string;
      type: "FILE";
      sizeBytes: number;
      checksumSha256: string;
      sortOrder: number;
    };

export type PreparedSkillPackage = {
  packageBuffer: Buffer;
  packageChecksumSha256: string;
  files: PreparedSkillFile[];
  entries: PreparedSkillEntry[];
  skillName: string;
  skillDescription: string;
  skillMd: string;
  ignoredSystemEntryCount: number;
};

export class SkillPackageError extends Error {
  constructor(
    readonly code: "INVALID_SKILL_PACKAGE" | "PACKAGE_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "SkillPackageError";
  }
}

type CollectedEntry = {
  path: string;
  directory: boolean;
  buffer: Buffer | null;
};

function packageError(
  message: string,
  code: SkillPackageError["code"] = "INVALID_SKILL_PACKAGE",
): never {
  throw new SkillPackageError(code, message);
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function normalizePackagePath(value: string): string | null {
  const cleaned = value.replace(/\\/g, "/").replace(/^\/+/, "");
  const normalized = path.posix.normalize(cleaned);
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    return null;
  }
  return normalized;
}

function validateArchivePath(value: string): string {
  const withoutTrailingSlash = value.replace(/\/+$/, "");
  if (
    withoutTrailingSlash.length > 1_024 ||
    !withoutTrailingSlash ||
    withoutTrailingSlash.includes("\0") ||
    withoutTrailingSlash.includes("\\") ||
    withoutTrailingSlash.startsWith("/") ||
    /^[A-Za-z]:/.test(withoutTrailingSlash)
  ) {
    return packageError("ZIP 中包含不安全的文件路径");
  }
  const segments = withoutTrailingSlash.split("/");
  if (
    segments.some(
      (segment) =>
        !segment || segment === "." || segment === "..",
    )
  ) {
    return packageError("ZIP 中包含路径穿越或无效路径");
  }
  return segments.join("/");
}

function isIgnoredSystemPath(filePath: string): boolean {
  const segments = filePath
    .split("/")
    .map((segment) => segment.toLocaleLowerCase());
  const fileName = segments[segments.length - 1] ?? "";
  return (
    segments.includes("__macosx") ||
    segments.includes("__pycache__") ||
    fileName === ".ds_store" ||
    fileName === ".kocotree-skill.json" ||
    fileName === "thumbs.db" ||
    fileName === "desktop.ini" ||
    fileName.startsWith("._") ||
    fileName.endsWith(".pyc") ||
    fileName.endsWith(".pyo")
  );
}

function isSymbolicLink(entry: yauzl.Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (unixMode & 0o170000) === 0o120000;
}

export function isPreviewableTextPath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return (
    textExtensions.has(path.posix.extname(normalized)) ||
    textExtensions.has(path.posix.basename(normalized))
  );
}

function openZip(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, autoClose: false },
      (error, zipFile) => {
        if (error || !zipFile) {
          reject(
            new SkillPackageError(
              "INVALID_SKILL_PACKAGE",
              "ZIP 已损坏或无法读取",
            ),
          );
          return;
        }
        resolve(zipFile);
      },
    );
  });
}

function readEntry(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(
          new SkillPackageError(
            "INVALID_SKILL_PACKAGE",
            "ZIP 中的文件无法解压",
          ),
        );
        return;
      }
      void streamToBuffer(stream).then(resolve, reject);
    });
  });
}

async function collectEntries(buffer: Buffer): Promise<{
  entries: CollectedEntry[];
  ignoredSystemEntryCount: number;
}> {
  const zipFile = await openZip(buffer);
  const entries: CollectedEntry[] = [];
  let ignoredSystemEntryCount = 0;
  let fileCount = 0;
  let totalUncompressedSize = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      zipFile.once("error", reject);
      zipFile.once("end", resolve);
      zipFile.on("entry", (entry) => {
        void (async () => {
          try {
            const entryPath = validateArchivePath(entry.fileName);
            if (isIgnoredSystemPath(entryPath)) {
              ignoredSystemEntryCount += 1;
              zipFile.readEntry();
              return;
            }
            if (isSymbolicLink(entry)) {
              packageError("ZIP 不能包含符号链接或其他链接文件");
            }

            const directory = entry.fileName.endsWith("/");
            if (directory) {
              entries.push({
                path: entryPath,
                directory: true,
                buffer: null,
              });
              zipFile.readEntry();
              return;
            }

            fileCount += 1;
            totalUncompressedSize += entry.uncompressedSize;
            if (fileCount > MAX_FILE_COUNT) {
              packageError(
                `ZIP 中的普通文件不能超过 ${MAX_FILE_COUNT} 个`,
                "PACKAGE_TOO_LARGE",
              );
            }
            if (totalUncompressedSize > MAX_UNCOMPRESSED_SIZE) {
              packageError(
                "ZIP 解压后的总大小不能超过 200 MB",
                "PACKAGE_TOO_LARGE",
              );
            }

            const content = await readEntry(zipFile, entry);
            entries.push({
              path: entryPath,
              directory: false,
              buffer: content,
            });
            zipFile.readEntry();
          } catch (error) {
            reject(error);
          }
        })();
      });
      zipFile.readEntry();
    });
  } catch (error) {
    if (error instanceof SkillPackageError) throw error;
    throw new SkillPackageError(
      "INVALID_SKILL_PACKAGE",
      "ZIP 中的文件无法解压",
    );
  } finally {
    zipFile.close();
  }

  return { entries, ignoredSystemEntryCount };
}

function normalizeEntries(entries: CollectedEntry[]): CollectedEntry[] {
  const skillMdCandidates = entries.filter(({ directory, path }) => {
    if (directory) return false;
    const segments = path.split("/");
    return (
      segments[segments.length - 1] === "SKILL.md" &&
      segments.length <= 2
    );
  });
  if (skillMdCandidates.length !== 1) {
    return packageError(
      "ZIP 根目录或单层外包装目录中必须且只能包含一个 SKILL.md",
    );
  }

  const skillMdSegments = skillMdCandidates[0].path.split("/");
  const wrapper =
    skillMdSegments.length === 2 ? skillMdSegments[0] : null;
  const normalizedEntries: CollectedEntry[] = [];
  const normalizedKeys = new Map<
    string,
    { path: string; directory: boolean }
  >();

  for (const entry of entries) {
    let normalizedPath = entry.path;
    if (wrapper) {
      if (entry.path === wrapper && entry.directory) continue;
      if (!entry.path.startsWith(`${wrapper}/`)) {
        return packageError(
          "ZIP 的单层外包装目录之外不能包含其他文件",
        );
      }
      normalizedPath = entry.path.slice(wrapper.length + 1);
    }
    if (!normalizedPath) continue;

    const collisionKey = normalizedPath.toLocaleLowerCase();
    const existing = normalizedKeys.get(collisionKey);
    if (
      existing &&
      (existing.path !== normalizedPath ||
        !existing.directory ||
        !entry.directory)
    ) {
      return packageError("ZIP 中包含重复或大小写冲突的路径");
    }
    normalizedKeys.set(collisionKey, {
      path: normalizedPath,
      directory: entry.directory,
    });
    normalizedEntries.push({
      ...entry,
      path: normalizedPath,
    });
  }

  return normalizedEntries;
}

function decodeSkillMd(buffer: Buffer): string {
  if (buffer.byteLength > MAX_SKILL_MD_SIZE) {
    return packageError("SKILL.md 不能超过 1 MB");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return packageError("SKILL.md 必须是 UTF-8 文本");
  }
}

function parseSkillFrontmatter(skillMd: string): {
  skillName: string;
  skillDescription: string;
} {
  const match =
    /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skillMd);
  if (!match) {
    return packageError("SKILL.md 缺少合法的 YAML frontmatter");
  }

  let value: unknown;
  try {
    value = parseYaml(match[1], { maxAliasCount: 50 });
  } catch {
    return packageError("SKILL.md 的 YAML frontmatter 无法解析");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return packageError("SKILL.md 的 frontmatter 必须是对象");
  }

  const frontmatter = value as Record<string, unknown>;
  const skillName =
    typeof frontmatter.name === "string"
      ? frontmatter.name.trim()
      : "";
  const skillDescription =
    typeof frontmatter.description === "string"
      ? frontmatter.description.trim()
      : "";
  if (
    !skillName ||
    skillName.length > 64 ||
    !SKILL_NAME_PATTERN.test(skillName)
  ) {
    return packageError(
      "SKILL.md 的 name 必须使用小写字母、数字和单个连字符，且不能超过 64 个字符",
    );
  }
  if (
    !skillDescription ||
    skillDescription.length > 1_000
  ) {
    return packageError(
      "SKILL.md 的 description 必须为 1 至 1000 个字符",
    );
  }
  return { skillName, skillDescription };
}

function buildEntries(
  files: PreparedSkillFile[],
): PreparedSkillEntry[] {
  const folders = new Set<string>();
  for (const file of files) {
    const segments = file.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      folders.add(segments.slice(0, index).join("/"));
    }
  }

  const folderEntries = Array.from(folders)
    .sort()
    .map((folderPath, index): PreparedSkillEntry => ({
      path: folderPath,
      type: "FOLDER",
      sizeBytes: null,
      checksumSha256: null,
      sortOrder: index,
    }));
  const fileEntries = [...files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file, index): PreparedSkillEntry => ({
      path: file.path,
      type: "FILE",
      sizeBytes: file.sizeBytes,
      checksumSha256: file.checksumSha256,
      sortOrder: folderEntries.length + index,
    }));
  if (folderEntries.length + fileEntries.length > MAX_TREE_ENTRY_COUNT) {
    return packageError(
      `ZIP 文件树不能超过 ${MAX_TREE_ENTRY_COUNT} 个条目`,
      "PACKAGE_TOO_LARGE",
    );
  }
  return [...folderEntries, ...fileEntries];
}

function createCanonicalZip(
  files: PreparedSkillFile[],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zipFile = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    zipFile.outputStream.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    zipFile.outputStream.once("end", () => {
      resolve(Buffer.concat(chunks));
    });
    zipFile.outputStream.once("error", reject);
    for (const file of [...files].sort((left, right) =>
      left.path.localeCompare(right.path),
    )) {
      zipFile.addBuffer(file.buffer, file.path, {
        mtime: new Date(Date.UTC(1980, 0, 1)),
        mode: 0o100644,
        compress: true,
      });
    }
    zipFile.end();
  });
}

export async function prepareSkillPackage(
  inputBuffer: Buffer,
): Promise<PreparedSkillPackage> {
  if (inputBuffer.byteLength > config.skillUploadMaxMb * 1024 * 1024) {
    return packageError(
      `ZIP 不能超过 ${config.skillUploadMaxMb} MB`,
      "PACKAGE_TOO_LARGE",
    );
  }

  const collected = await collectEntries(inputBuffer);
  const normalizedEntries = normalizeEntries(collected.entries);
  const files = normalizedEntries
    .filter(
      (
        entry,
      ): entry is CollectedEntry & { buffer: Buffer } =>
        !entry.directory && entry.buffer !== null,
    )
    .map(
      (entry): PreparedSkillFile => ({
        path: entry.path,
        buffer: entry.buffer,
        sizeBytes: entry.buffer.byteLength,
        checksumSha256: sha256(entry.buffer),
      }),
    );
  if (files.length === 0) {
    return packageError("ZIP 中没有可发布的文件");
  }

  const skillMdFile = files.find(
    (file) => file.path === "SKILL.md",
  );
  if (!skillMdFile) {
    return packageError("ZIP 根目录中没有找到 SKILL.md");
  }
  const skillMd = decodeSkillMd(skillMdFile.buffer);
  const metadata = parseSkillFrontmatter(skillMd);
  const entries = buildEntries(files);
  const packageBuffer = await createCanonicalZip(files);
  if (
    packageBuffer.byteLength >
    config.skillUploadMaxMb * 1024 * 1024
  ) {
    return packageError(
      `清理系统元数据后的 ZIP 不能超过 ${config.skillUploadMaxMb} MB`,
      "PACKAGE_TOO_LARGE",
    );
  }

  return {
    packageBuffer,
    packageChecksumSha256: sha256(packageBuffer),
    files,
    entries,
    skillName: metadata.skillName,
    skillDescription: metadata.skillDescription,
    skillMd,
    ignoredSystemEntryCount: collected.ignoredSystemEntryCount,
  };
}

export async function readFileFromPackage(
  packageBuffer: Buffer,
  requestedPath: string,
): Promise<Buffer | null> {
  const normalizedRequestedPath = normalizePackagePath(requestedPath);
  if (!normalizedRequestedPath) return null;

  const zipFile = await openZip(packageBuffer);
  return new Promise<Buffer | null>((resolve, reject) => {
    let settled = false;
    const finish = (result: Buffer | null) => {
      if (settled) return;
      settled = true;
      zipFile.close();
      resolve(result);
    };
    const fail = (reason: unknown) => {
      if (settled) return;
      settled = true;
      zipFile.close();
      reject(reason);
    };

    zipFile.on("entry", (entry) => {
      const entryPath = normalizePackagePath(entry.fileName);
      if (
        !entryPath ||
        entry.fileName.endsWith("/") ||
        entryPath !== normalizedRequestedPath
      ) {
        zipFile.readEntry();
        return;
      }
      void readEntry(zipFile, entry).then(finish, fail);
    });
    zipFile.once("end", () => finish(null));
    zipFile.once("error", fail);
    zipFile.readEntry();
  });
}
