import JSZip from "jszip";
import { SkillApiError } from "./contracts";
import { inspectSkillZip, type SkillArchiveSource } from "./zipInspector";

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
  source: SkillArchiveSource;
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
