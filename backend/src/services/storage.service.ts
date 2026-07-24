import OSS from "ali-oss";
import { config } from "../config";

type OssClient = {
  get: (name: string) => Promise<{ content: Buffer }>;
};

let client: OssClient | null = null;

function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function getClient(): OssClient {
  if (config.storageDriver !== "aliyun-oss") {
    throw new Error(
      `Unsupported storage driver: ${config.storageDriver}`,
    );
  }
  if (!config.ossAccessKeyId || !config.ossAccessKeySecret) {
    throw new Error("OSS credentials are not configured");
  }
  if (!client) {
    client = new OSS({
      region: config.ossRegion,
      endpoint: normalizeEndpoint(config.ossEndpoint),
      accessKeyId: config.ossAccessKeyId,
      accessKeySecret: config.ossAccessKeySecret,
      bucket: config.ossBucket,
      secure: true,
    }) as unknown as OssClient;
  }
  return client;
}

export const storageService = {
  async getObject(objectKey: string): Promise<Buffer> {
    const result = await getClient().get(objectKey);
    return result.content;
  },
};
