import path from "node:path";
import { buffer as streamToBuffer } from "node:stream/consumers";
import yauzl from "yauzl";

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
          reject(error || new Error("Invalid ZIP package"));
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
        reject(error || new Error("Cannot read ZIP entry"));
        return;
      }
      void streamToBuffer(stream).then(resolve, reject);
    });
  });
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
