import type {
  FastifyPluginAsync,
  FastifyRequest,
} from "fastify";
import { config } from "../config";
import { failure, requireAuth, success } from "../http";
import {
  SkillPackageError,
} from "../services/skill-package.service";
import {
  PublishingError,
  publishingService,
} from "../services/publishing.service";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ParsedMultipart = {
  file: Buffer;
  fields: Map<string, string[]>;
};

function readSingle(
  fields: Map<string, string[]>,
  name: string,
): string | undefined {
  const values = fields.get(name);
  return values?.[values.length - 1];
}

function readMany(
  fields: Map<string, string[]>,
  name: string,
): string[] | undefined {
  return fields.has(name) ? fields.get(name) || [] : undefined;
}

function readBoolean(
  fields: Map<string, string[]>,
  name: string,
): boolean {
  const value = readSingle(fields, name);
  return value === "true" || value === "1";
}

function parseMetadataBody(body: unknown): {
  displayName?: string;
  displayDescription?: string;
  tagIds?: string[];
  newTagNames?: string[];
  confirmDuplicateDisplayName: boolean;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new PublishingError(
      400,
      "INVALID_REQUEST",
      "请求内容必须是 JSON 对象",
    );
  }
  const input = body as Record<string, unknown>;
  const readOptionalString = (name: string): string | undefined => {
    const value = input[name];
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
      throw new PublishingError(
        400,
        "INVALID_REQUEST",
        `${name} 格式无效`,
      );
    }
    return value;
  };
  const readOptionalStrings = (
    name: string,
  ): string[] | undefined => {
    const value = input[name];
    if (value === undefined) return undefined;
    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== "string")
    ) {
      throw new PublishingError(
        400,
        "INVALID_REQUEST",
        `${name} 格式无效`,
      );
    }
    return value as string[];
  };
  const confirmation = input.confirmDuplicateDisplayName;
  if (
    confirmation !== undefined &&
    typeof confirmation !== "boolean"
  ) {
    throw new PublishingError(
      400,
      "INVALID_REQUEST",
      "confirmDuplicateDisplayName 格式无效",
    );
  }

  return {
    displayName: readOptionalString("displayName"),
    displayDescription: readOptionalString(
      "displayDescription",
    ),
    tagIds: readOptionalStrings("tagIds"),
    newTagNames: readOptionalStrings("newTagNames"),
    confirmDuplicateDisplayName: confirmation === true,
  };
}

async function parseMultipart(
  request: FastifyRequest,
): Promise<ParsedMultipart> {
  if (!request.isMultipart()) {
    throw new PublishingError(
      400,
      "INVALID_REQUEST",
      "请求必须使用 multipart/form-data",
    );
  }

  const fields = new Map<string, string[]>();
  let file: Buffer | null = null;
  for await (const part of request.parts()) {
    if (part.type === "file") {
      if (part.fieldname !== "file" || file) {
        throw new PublishingError(
          400,
          "INVALID_REQUEST",
          "每次只能上传一个 ZIP 文件",
        );
      }
      const zipFileName = part.filename.toLocaleLowerCase();
      if (
        !zipFileName.endsWith(".zip") &&
        part.mimetype !== "application/zip" &&
        part.mimetype !== "application/x-zip-compressed"
      ) {
        throw new PublishingError(
          400,
          "INVALID_SKILL_PACKAGE",
          "请选择 ZIP 格式的 Skill 包",
        );
      }
      file = await part.toBuffer();
      continue;
    }

    const current = fields.get(part.fieldname) || [];
    if (part.valueTruncated) {
      throw new PublishingError(
        400,
        "INVALID_REQUEST",
        `表单字段 ${part.fieldname} 超出长度限制`,
      );
    }
    current.push(String(part.value ?? ""));
    fields.set(part.fieldname, current);
  }
  if (!file) {
    throw new PublishingError(
      400,
      "INVALID_REQUEST",
      "请选择要上传的 ZIP 文件",
    );
  }
  return { file, fields };
}

function sendPublishingError(
  request: { log: { error: (value: unknown, message: string) => void } },
  reply: Parameters<typeof failure>[0],
  error: unknown,
  fallback: {
    logMessage: string;
    userMessage: string;
    errorCode: string;
  } = {
    logMessage: "Skill 发布失败",
    userMessage: "发布暂时失败，请稍后重试",
    errorCode: "PUBLISHING_FAILED",
  },
) {
  if (error instanceof SkillPackageError) {
    return failure(
      reply,
      error.code === "PACKAGE_TOO_LARGE" ? 413 : 400,
      error.code,
      error.message,
    );
  }
  if (error instanceof PublishingError) {
    return failure(
      reply,
      error.statusCode,
      error.code,
      error.message,
      error.details,
    );
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "FST_REQ_FILE_TOO_LARGE" ||
      error.code === "FST_FILES_LIMIT")
  ) {
    return failure(
      reply,
      413,
      "PACKAGE_TOO_LARGE",
      `ZIP 不能超过 ${config.skillUploadMaxMb} MB`,
    );
  }
  request.log.error(error, fallback.logMessage);
  return failure(
    reply,
    503,
    fallback.errorCode,
    fallback.userMessage,
  );
}

export const publishingRoutes: FastifyPluginAsync = async (app) => {
  app.post("/skills", async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return;

    try {
      const { file, fields } = await parseMultipart(request);
      const result = await publishingService.createSkill({
        file,
        displayName: readSingle(fields, "displayName") || "",
        displayDescription:
          readSingle(fields, "displayDescription") || "",
        tagIds: readMany(fields, "tagIds") || [],
        newTagNames: readMany(fields, "newTagNames") || [],
        forkedFromSkillId: readSingle(
          fields,
          "forkedFromSkillId",
        ),
        forkedFromVersionId: readSingle(
          fields,
          "forkedFromVersionId",
        ),
        confirmDuplicateDisplayName: readBoolean(
          fields,
          "confirmDuplicateDisplayName",
        ),
        userId: auth.user.id,
      });
      return reply.code(201).send(success(result, 201));
    } catch (error) {
      return sendPublishingError(request, reply, error);
    }
  });

  app.patch("/skills/:skillId", async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return;

    const params = request.params as { skillId?: string };
    const skillId = params.skillId?.trim() || "";
    if (!UUID_PATTERN.test(skillId)) {
      return failure(
        reply,
        404,
        "SKILL_NOT_FOUND",
        "没有找到该 Skill",
      );
    }

    try {
      const input = parseMetadataBody(request.body);
      const result = await publishingService.updateSkillMetadata({
        skillId,
        ...input,
        userId: auth.user.id,
      });
      return success(result);
    } catch (error) {
      return sendPublishingError(request, reply, error, {
        logMessage: "Skill 展示信息更新失败",
        userMessage: "展示信息暂时无法更新，请稍后重试",
        errorCode: "SKILL_METADATA_UPDATE_FAILED",
      });
    }
  });

  app.post(
    "/skills/:skillId/versions",
    async (request, reply) => {
      const auth = await requireAuth(request, reply);
      if (!auth) return;

      const params = request.params as { skillId?: string };
      const skillId = params.skillId?.trim() || "";
      if (!UUID_PATTERN.test(skillId)) {
        return failure(
          reply,
          404,
          "SKILL_NOT_FOUND",
          "没有找到该 Skill",
        );
      }

      try {
        const { file, fields } = await parseMultipart(request);
        const tagIds = readMany(fields, "tagIds");
        const newTagNames = readMany(fields, "newTagNames");
        const replaceTags =
          readBoolean(fields, "replaceTags") ||
          tagIds !== undefined ||
          newTagNames !== undefined;
        const result = await publishingService.publishVersion({
          skillId,
          file,
          baseVersionId:
            readSingle(fields, "baseVersionId") || "",
          version: readSingle(fields, "version") || "",
          changelog: readSingle(fields, "changelog") || "",
          displayName: readSingle(fields, "displayName"),
          displayDescription: readSingle(
            fields,
            "displayDescription",
          ),
          tagIds:
            replaceTags ? tagIds || [] : undefined,
          newTagNames,
          confirmDuplicateDisplayName: readBoolean(
            fields,
            "confirmDuplicateDisplayName",
          ),
          userId: auth.user.id,
        });
        return reply.code(201).send(success(result, 201));
      } catch (error) {
        return sendPublishingError(request, reply, error);
      }
    },
  );
};
