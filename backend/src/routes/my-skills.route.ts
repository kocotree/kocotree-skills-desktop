import type { FastifyPluginAsync } from "fastify";
import { failure, requireAuth, success } from "../http";
import { catalogService } from "../services/catalog.service";
import { skillDeletionService } from "../services/skill-deletion.service";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function positiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

export const mySkillsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/users/me/skills", async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return;

    const query = request.query as Record<string, unknown>;
    const page = positiveInteger(query.page, 1, 1_000_000);
    const pageSize = positiveInteger(query.pageSize, 20, 100);
    const result = await catalogService.listOwnedSkills(
      auth.user.id,
      page,
      pageSize,
    );
    return success(result);
  });

  app.delete("/skills/:skillId", async (request, reply) => {
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
      const result = await skillDeletionService.deleteOwnedSkill(
        skillId,
        auth.user.id,
      );
      if (result.status === "SKILL_NOT_FOUND") {
        return failure(
          reply,
          404,
          "SKILL_NOT_FOUND",
          "没有找到该 Skill",
        );
      }
      if (result.status === "OWNER_REQUIRED") {
        return failure(
          reply,
          403,
          "OWNER_REQUIRED",
          "只有 Skill Owner 可以永久删除",
        );
      }
      return success({
        id: skillId,
        deletedObjectCount: result.deletedObjectCount,
        objectCount: result.objectCount,
        ossCleaned: result.ossCleaned,
      });
    } catch (error) {
      request.log.error(
        { err: error, skillId },
        "永久删除 Skill 失败",
      );
      return failure(
        reply,
        503,
        "SKILL_DELETE_FAILED",
        "暂时无法删除 Skill，请稍后重试",
      );
    }
  });
};
