import type { FastifyPluginAsync } from "fastify";
import { failure, requireAuth, success } from "../http";
import {
  SkillTranslationError,
  skillTranslationService,
} from "../services/skill-translation.service";

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parseBody(body: unknown): {
  skillName: string;
  skillDescription: string;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new SkillTranslationError(
      400,
      "INVALID_REQUEST",
      "请求内容必须是 JSON 对象",
    );
  }
  const input = body as Record<string, unknown>;
  const skillName = typeof input.skillName === "string"
    ? input.skillName.trim()
    : "";
  const skillDescription = typeof input.skillDescription === "string"
    ? input.skillDescription.trim()
    : "";
  if (
    !skillName ||
    skillName.length > 64 ||
    !SKILL_NAME_PATTERN.test(skillName)
  ) {
    throw new SkillTranslationError(
      400,
      "INVALID_REQUEST",
      "Skill 名称格式无效",
    );
  }
  if (!skillDescription || skillDescription.length > 1_000) {
    throw new SkillTranslationError(
      400,
      "INVALID_REQUEST",
      "Skill 描述必须为 1 至 1000 个字符",
    );
  }
  return { skillName, skillDescription };
}

export const skillTranslationRoutes: FastifyPluginAsync = async (app) => {
  app.post("/skill-metadata/translations", async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return;

    try {
      return success(await skillTranslationService.translate(parseBody(request.body)));
    } catch (error) {
      if (error instanceof SkillTranslationError) {
        return failure(
          reply,
          error.statusCode,
          error.code,
          error.message,
        );
      }
      request.log.error(error, "Skill 元数据 AI 翻译失败");
      return failure(
        reply,
        503,
        "TRANSLATION_UNAVAILABLE",
        "AI 翻译服务暂时不可用，请重试",
      );
    }
  });
};
