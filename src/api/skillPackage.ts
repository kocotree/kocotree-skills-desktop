import JSZip from "jszip";
import { SkillApiError } from "./contracts";
import {
  inspectSkillZip,
  parseSkillFrontmatter,
  type SkillArchiveSource,
} from "./zipInspector";

const MAX_PACKAGE_SIZE = 50 * 1024 * 1024;
const MAX_FOLDER_FILE_COUNT = 2_000;
const MAX_FOLDER_SIZE = 200 * 1024 * 1024;

/** 客户端本地展示的 ZIP 解析结果，不属于服务端 DTO。 */
export interface SkillPackageInspection {
  originalFileName: string;
  skillName: string;
  skillDescription: string;
  skillMd: string;
  packageSize: number;
  fileCount: number;
  packageSha256: string;
  contentHash: string;
  warnings: string[];
}

/** ZIP 校验后的元数据、文件读取来源，以及清理系统元数据后的实际上传文件。 */
export interface ParsedSkillPackage {
  inspection: SkillPackageInspection;
  uploadFile: File;
  source: SkillArchiveSource;
}

/** 上传页只依赖解析摘要和 ZIP 文件；桌面端自动打包无需再次展开全部文件。 */
export interface PreparedSkillUpload {
  inspection: SkillPackageInspection;
  uploadFile: File;
}

async function sha256(buffer: ArrayBuffer): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", buffer);
  const value = Array.from(
    new Uint8Array(result),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `sha256:${value}`;
}

const LOCAL_CONTENT_HASH_COMMENT_PREFIX = "kocotree-content-hash:";

/**
 * 快速读取桌面端刚生成的 ZIP，仅展开 SKILL.md，不重复解压并哈希每个文件。
 * 完整包校验仍由发布接口执行。
 */
export async function inspectPreparedLocalSkillPackage(
  file: File,
): Promise<PreparedSkillUpload> {
  if (!file.name.toLocaleLowerCase().endsWith(".zip")) {
    throw new SkillApiError("INVALID_SKILL_PACKAGE", "请选择 ZIP 格式的 Skill 包");
  }
  if (file.size > MAX_PACKAGE_SIZE) {
    throw new SkillApiError("PACKAGE_TOO_LARGE", "ZIP 不能超过 50 MB");
  }

  const buffer = await file.arrayBuffer();
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(buffer);
  } catch {
    throw new SkillApiError("INVALID_SKILL_PACKAGE", "无法读取本地 Skill ZIP");
  }
  const skillMdEntry = archive.file("SKILL.md");
  if (!skillMdEntry) {
    throw new SkillApiError("INVALID_SKILL_PACKAGE", "ZIP 中没有找到 SKILL.md");
  }
  const skillMdBytes = await skillMdEntry.async("uint8array");
  if (skillMdBytes.byteLength > 1024 * 1024) {
    throw new SkillApiError("INVALID_SKILL_PACKAGE", "SKILL.md 不能超过 1 MB");
  }
  let skillMd: string;
  try {
    skillMd = new TextDecoder("utf-8", { fatal: true }).decode(skillMdBytes);
  } catch {
    throw new SkillApiError("INVALID_SKILL_PACKAGE", "SKILL.md 必须是 UTF-8 文本");
  }
  const { skillName, skillDescription } = parseSkillFrontmatter(skillMd);
  const contentHash = archive.comment?.startsWith(
    LOCAL_CONTENT_HASH_COMMENT_PREFIX,
  )
    ? archive.comment.slice(LOCAL_CONTENT_HASH_COMMENT_PREFIX.length)
    : "";

  return {
    inspection: {
      originalFileName: file.name.replace(/\.zip$/i, ""),
      skillName,
      skillDescription,
      skillMd,
      packageSize: file.size,
      fileCount: Object.values(archive.files).filter((entry) => !entry.dir).length,
      packageSha256: await sha256(buffer),
      contentHash,
      warnings: [],
    },
    uploadFile: file,
  };
}

/**
 * 功能说明：在当前进程中读取并校验 Skill ZIP，生成页面预览或发布入库所需的数据。
 * @param file - 用户选择或提交的原始 ZIP 文件。
 * @returns ZIP 元数据、后续读取版本文件所需的解析来源，以及可安全上传的 ZIP。
 */
export async function parseSkillPackage(file: File): Promise<ParsedSkillPackage> {
  if (!file.name.toLocaleLowerCase().endsWith(".zip")) {
    throw new SkillApiError("INVALID_SKILL_PACKAGE", "请选择 ZIP 格式的 Skill 包");
  }
  if (file.size > MAX_PACKAGE_SIZE) {
    throw new SkillApiError("PACKAGE_TOO_LARGE", "ZIP 不能超过 50 MB");
  }

  const originalBuffer = await file.arrayBuffer();
  const originalParsed = await inspectSkillZip(originalBuffer);
  let uploadBuffer = originalBuffer;
  let parsed = originalParsed;

  if (originalParsed.ignoredSystemPaths.length > 0) {
    for (const ignoredPath of originalParsed.ignoredSystemPaths) {
      originalParsed.archive.remove(ignoredPath);
    }
    uploadBuffer = await originalParsed.archive.generateAsync({
      type: "arraybuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    parsed = await inspectSkillZip(uploadBuffer);
  }

  const uploadFile = uploadBuffer === originalBuffer
    ? file
    : new File([uploadBuffer], file.name, {
        type: file.type || "application/zip",
        lastModified: file.lastModified,
      });
  if (uploadFile.size > MAX_PACKAGE_SIZE) {
    throw new SkillApiError(
      "PACKAGE_TOO_LARGE",
      "清理 macOS 系统文件后的 ZIP 不能超过 50 MB",
    );
  }

  return {
    inspection: {
      originalFileName: file.name,
      skillName: parsed.skillName,
      skillDescription: parsed.skillDescription,
      skillMd: parsed.skillMd,
      packageSize: uploadFile.size,
      fileCount: parsed.files.filter((entry) => entry.type === "FILE").length,
      packageSha256: await sha256(uploadBuffer),
      contentHash: parsed.contentHash,
      warnings: originalParsed.ignoredSystemPaths.length > 0
        ? [`已自动清理 ${originalParsed.ignoredSystemPaths.length} 条 macOS 系统元数据`]
        : [],
    },
    source: {
      archive: parsed.archive,
      files: parsed.files,
      originalPathByNormalized: parsed.originalPathByNormalized,
    },
    uploadFile,
  };
}

/**
 * 功能说明：保留用户所选目录的相对路径，在内存中生成临时 ZIP，并复用标准 Skill 包校验流程。
 * @param files - 浏览器目录选择器返回的全部普通文件。
 * @returns 与手工 ZIP 上传相同的解析结果和可上传文件。
 */
export async function parseSkillFolder(
  files: readonly File[],
): Promise<ParsedSkillPackage> {
  if (files.length === 0) {
    throw new SkillApiError(
      "INVALID_SKILL_PACKAGE",
      "所选文件夹中没有可上传的文件",
    );
  }
  if (files.length > MAX_FOLDER_FILE_COUNT) {
    throw new SkillApiError(
      "PACKAGE_TOO_LARGE",
      `文件夹中的普通文件不能超过 ${MAX_FOLDER_FILE_COUNT} 个`,
    );
  }

  const entries = files.map((file) => {
    const relativePath = file.webkitRelativePath.replace(/\\/g, "/");
    const segments = relativePath.split("/");
    if (
      !relativePath
      || segments.length < 2
      || segments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new SkillApiError(
        "INVALID_SKILL_PACKAGE",
        "无法读取文件夹中的相对路径",
        { path: relativePath || file.name },
      );
    }
    return {
      file,
      relativePath,
      rootDirectory: segments[0],
    };
  });
  const rootDirectory = entries[0].rootDirectory;
  if (entries.some((entry) => entry.rootDirectory !== rootDirectory)) {
    throw new SkillApiError(
      "INVALID_SKILL_PACKAGE",
      "一次只能上传一个 Skill 文件夹",
    );
  }

  const totalSize = entries.reduce(
    (sum, entry) => sum + entry.file.size,
    0,
  );
  if (totalSize > MAX_FOLDER_SIZE) {
    throw new SkillApiError(
      "PACKAGE_TOO_LARGE",
      "文件夹中的文件总大小不能超过 200 MB",
    );
  }

  const archive = new JSZip();
  for (const { file, relativePath } of entries) {
    archive.file(relativePath, await file.arrayBuffer(), {
      binary: true,
      createFolders: true,
      date: new Date(file.lastModified),
    });
  }
  const buffer = await archive.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  const safeFolderName = rootDirectory
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .trim() || "skill-folder";
  const parsed = await parseSkillPackage(new File(
    [buffer],
    `${safeFolderName}.zip`,
    { type: "application/zip" },
  ));

  return {
    ...parsed,
    inspection: {
      ...parsed.inspection,
      originalFileName: rootDirectory,
    },
  };
}
