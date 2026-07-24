import type { FastifyPluginAsync } from "fastify";
import { failure, requireAuth, success } from "../http";
import { catalogService } from "../services/catalog.service";

const SORTS = new Set([
  "UPDATED_DESC",
  "CREATED_DESC",
  "INSTALLS_DESC",
]);
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

export const catalogRoutes: FastifyPluginAsync = async (app) => {
  app.get("/tags", async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return;

    const query = request.query as { query?: unknown };
    const keyword =
      typeof query.query === "string" ? query.query.trim() : undefined;
    const items = await catalogService.listTags(keyword || undefined);
    return success(items);
  });

  app.get("/skills", async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return;

    const query = request.query as Record<string, unknown>;
    const sort =
      typeof query.sort === "string" && SORTS.has(query.sort)
        ? (query.sort as
            | "UPDATED_DESC"
            | "CREATED_DESC"
            | "INSTALLS_DESC")
        : "UPDATED_DESC";
    const page = positiveInteger(query.page, 1, 1_000_000);
    const pageSize = positiveInteger(query.pageSize, 20, 100);
    const keyword =
      typeof query.query === "string" ? query.query.trim() : undefined;
    const tagId =
      typeof query.tagId === "string" ? query.tagId.trim() : undefined;

    if (tagId && tagId.length > 100) {
      return failure(reply, 400, "INVALID_REQUEST", "Tag ID 无效");
    }

    const result = await catalogService.listSkills({
      query: keyword || undefined,
      tagId: tagId || undefined,
      sort,
      page,
      pageSize,
    });
    return success(result);
  });

  app.get("/skills/:skillId", async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return;

    const params = request.params as { skillId?: string };
    const skillId = params.skillId?.trim() || "";
    if (!UUID_PATTERN.test(skillId)) {
      return failure(reply, 404, "SKILL_NOT_FOUND", "没有找到该 Skill");
    }

    const skill = await catalogService.getSkill(skillId);
    if (!skill) {
      return failure(reply, 404, "SKILL_NOT_FOUND", "没有找到该 Skill");
    }
    return success(skill);
  });

  app.get("/skills/:skillId/versions", async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return;

    const params = request.params as { skillId?: string };
    const skillId = params.skillId?.trim() || "";
    if (!UUID_PATTERN.test(skillId)) {
      return failure(reply, 404, "SKILL_NOT_FOUND", "没有找到该 Skill");
    }

    const query = request.query as Record<string, unknown>;
    const page = positiveInteger(query.page, 1, 1_000_000);
    const pageSize = positiveInteger(query.pageSize, 20, 100);
    const result = await catalogService.listSkillVersions(
      skillId,
      page,
      pageSize,
    );
    if (!result) {
      return failure(reply, 404, "SKILL_NOT_FOUND", "没有找到该 Skill");
    }
    return success(result);
  });
};
