import OSS from "ali-oss";
import { config } from "../config";

type OssClient = {
  put: (
    name: string,
    content: Buffer,
    options?: { mime?: string },
  ) => Promise<{
    res?: { headers?: Record<string, string> };
  }>;
  get: (name: string) => Promise<{ content: Buffer }>;
  delete: (name: string) => Promise<unknown>;
  signatureUrl: (
    name: string,
    options: { expires: number; method: "GET" },
  ) => string;
};

const clients = new Map<string, OssClient>();

function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function getClient(bucket: string): OssClient {
  if (config.storageDriver !== "aliyun-oss") {
    throw new Error(
      `Unsupported storage driver: ${config.storageDriver}`,
    );
  }
  if (!config.ossAccessKeyId || !config.ossAccessKeySecret) {
    throw new Error("OSS credentials are not configured");
  }
  const existing = clients.get(bucket);
  if (existing) {
    return existing;
  }

  const client = new OSS({
    region: config.ossRegion,
    endpoint: normalizeEndpoint(config.ossEndpoint),
    accessKeyId: config.ossAccessKeyId,
    accessKeySecret: config.ossAccessKeySecret,
    bucket,
    secure: true,
  }) as unknown as OssClient;
  clients.set(bucket, client);
  return client;
}

export const storageService = {
  bucket: config.ossBucket,

  async putObject(
    objectKey: string,
    content: Buffer,
    contentType = "application/zip",
    bucket = config.ossBucket,
  ): Promise<{ objectKey: string; etag: string | null }> {
    const result = await getClient(bucket).put(objectKey, content, {
      mime: contentType,
    });
    return {
      objectKey,
      etag:
        result.res?.headers?.etag?.replace(/"/g, "") || null,
    };
  },

  async getObject(
    objectKey: string,
    bucket = config.ossBucket,
  ): Promise<Buffer> {
    const result = await getClient(bucket).get(objectKey);
    return result.content;
  },

  async deleteObject(
    objectKey: string,
    bucket = config.ossBucket,
  ): Promise<void> {
    await getClient(bucket).delete(objectKey);
  },

  createSignedDownloadUrl(
    objectKey: string,
    expiresSeconds: number,
    bucket = config.ossBucket,
  ): string {
    return getClient(bucket).signatureUrl(objectKey, {
      expires: expiresSeconds,
      method: "GET",
    });
  },
};
