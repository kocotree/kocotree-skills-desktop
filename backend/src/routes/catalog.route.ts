import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { failure, requireAuth, success } from "../http";
import {
  catalogService,
  decodeDepartmentKey,
} from "../services/catalog.service";
import {
  catalogEventService,
  type CatalogEvent,
} from "../services/catalog-event.service";

const SORTS = new Set([
  "UPDATED_DESC",
  "CREATED_DESC",
  "INSTALLS_DESC",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CATALOG_EVENT_HEARTBEAT_MS = 20_000;

function writeCatalogEvent(
  reply: FastifyReply,
  event: CatalogEvent,
): void {
  reply.raw.write(
    `id: ${event.eventId}\nevent: catalog\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

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

function stringArray(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.flatMap((item) =>
    typeof item === "string" ? item.split(",") : [],
  ).map((item) => item.trim()).filter(Boolean))];
}

export const catalogRoutes: FastifyPluginAsync = async (app) => {
  app.get("/business-scenarios", async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return;
    return success(await catalogService.listBusinessScenarios());
  });

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
    const tagIds = stringArray(query.tagIds ?? query.tagId);
    const departmentKey =
      typeof query.departmentKey === "string"
        ? query.departmentKey.trim()
        : undefined;
    if (
      query.businessScenarioId !== undefined
      && typeof query.businessScenarioId !== "string"
    ) {
      return failure(reply, 400, "INVALID_REQUEST", "业务场景 ID 必须是单个字符串");
    }
    if (
      query.businessScenario !== undefined
      && typeof query.businessScenario !== "string"
    ) {
      return failure(reply, 400, "INVALID_REQUEST", "业务场景筛选必须是单个字符串");
    }
    const businessScenarioId =
      typeof query.businessScenarioId === "string"
        ? query.businessScenarioId.trim()
        : undefined;
    const rawScenarioIds = query.businessScenarioIds;
    if (rawScenarioIds !== undefined && typeof rawScenarioIds !== "string"
      && !(Array.isArray(rawScenarioIds) && rawScenarioIds.every((id) => typeof id === "string"))) {
      return failure(reply, 400, "INVALID_REQUEST", "业务场景 ID 列表无效");
    }
    if (rawScenarioIds !== undefined && query.businessScenarioId !== undefined) {
      return failure(reply, 400, "INVALID_REQUEST", "单场景和多场景参数不能同时使用");
    }
    const businessScenarioIds = stringArray(rawScenarioIds);
    if (businessScenarioIds.length > 100 || businessScenarioIds.some((id) => !UUID_PATTERN.test(id))) {
      return failure(reply, 400, "INVALID_REQUEST", "业务场景 ID 列表无效");
    }
    const businessScenario =
      typeof query.businessScenario === "string"
        ? query.businessScenario.trim()
        : undefined;
    if (businessScenarioId && businessScenario) {
      return failure(reply, 400, "INVALID_REQUEST", "业务场景筛选参数互斥");
    }
    if (businessScenarioId && !UUID_PATTERN.test(businessScenarioId)) {
      return failure(reply, 400, "INVALID_REQUEST", "业务场景 ID 无效");
    }
    if (businessScenario && businessScenario !== "unclassified") {
      return failure(reply, 400, "INVALID_REQUEST", "业务场景筛选参数无效");
    }

    if (tagIds.length > 20 || tagIds.some((tagId) => tagId.length > 100)) {
      return failure(reply, 400, "INVALID_REQUEST", "Tag ID 无效");
    }
    if (departmentKey && departmentKey.length > 2_048) {
      return failure(reply, 400, "INVALID_REQUEST", "发布部门无效");
    }
    const departmentPath = departmentKey
      ? decodeDepartmentKey(departmentKey)
      : undefined;
    if (departmentKey && !departmentPath) {
      return failure(reply, 400, "INVALID_REQUEST", "发布部门无效");
    }

    const result = await catalogService.listSkills({
      query: keyword || undefined,
      tagIds: tagIds.length > 0 ? tagIds : undefined,
      departmentPath: departmentPath ?? undefined,
      businessScenarioId: businessScenarioId || undefined,
      businessScenarioIds: businessScenarioIds.length ? businessScenarioIds : undefined,
      unclassified: businessScenario === "unclassified",
      sort,
      page,
      pageSize,
    });
    return success(result);
  });

  app.get("/skills/departments", async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return;

    const items = await catalogService.listPublishedSkillDepartments();
    return success(items);
  });

  app.get("/skills/events", async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return;

    reply.hijack();
    reply.raw.statusCode = 200;
    reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    request.raw.socket.setKeepAlive(true);

    let closed = false;
    const unsubscribe = catalogEventService.subscribe((event) => {
      if (!closed && !reply.raw.destroyed) {
        writeCatalogEvent(reply, event);
      }
    });
    const heartbeat = setInterval(() => {
      if (!closed && !reply.raw.destroyed) {
        reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
      }
    }, CATALOG_EVENT_HEARTBEAT_MS);
    heartbeat.unref();

    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.once("close", close);
    reply.raw.once("close", close);
    reply.raw.once("error", close);
    reply.raw.flushHeaders();
    reply.raw.write("retry: 1000\n: connected\n\n");
    return reply;
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

  app.get(
    "/skills/:skillId/versions/:versionId/files",
    async (request, reply) => {
      const auth = await requireAuth(request, reply);
      if (!auth) return;

      const params = request.params as {
        skillId?: string;
        versionId?: string;
      };
      const skillId = params.skillId?.trim() || "";
      const versionId = params.versionId?.trim() || "";
      if (
        !UUID_PATTERN.test(skillId) ||
        !UUID_PATTERN.test(versionId)
      ) {
        return failure(
          reply,
          404,
          "VERSION_NOT_FOUND",
          "没有找到该 Skill 版本",
        );
      }

      const files = await catalogService.listVersionFiles(
        skillId,
        versionId,
      );
      if (!files) {
        return failure(
          reply,
          404,
          "VERSION_NOT_FOUND",
          "没有找到该 Skill 版本",
        );
      }
      return success(files);
    },
  );

  app.get(
    "/skills/:skillId/versions/:versionId/files/content",
    async (request, reply) => {
      const auth = await requireAuth(request, reply);
      if (!auth) return;

      const params = request.params as {
        skillId?: string;
        versionId?: string;
      };
      const skillId = params.skillId?.trim() || "";
      const versionId = params.versionId?.trim() || "";
      if (
        !UUID_PATTERN.test(skillId) ||
        !UUID_PATTERN.test(versionId)
      ) {
        return failure(
          reply,
          404,
          "VERSION_NOT_FOUND",
          "没有找到该 Skill 版本",
        );
      }

      const query = request.query as { path?: unknown };
      if (
        typeof query.path !== "string" ||
        !query.path.trim() ||
        query.path.length > 1_000
      ) {
        return failure(
          reply,
          400,
          "INVALID_REQUEST",
          "文件路径无效",
        );
      }

      const result = await catalogService.getVersionFileContent(
        skillId,
        versionId,
        query.path,
      );
      if (result.status === "OK") {
        return success(result.data);
      }
      if (result.status === "INVALID_PATH") {
        return failure(
          reply,
          400,
          "INVALID_REQUEST",
          "文件路径无效",
        );
      }
      if (result.status === "VERSION_NOT_FOUND") {
        return failure(
          reply,
          404,
          "VERSION_NOT_FOUND",
          "没有找到该 Skill 版本",
        );
      }
      if (result.status === "FILE_NOT_FOUND") {
        return failure(
          reply,
          404,
          "FILE_NOT_FOUND",
          "没有找到该版本中的文件",
        );
      }
      return failure(
        reply,
        422,
        "FILE_PREVIEW_UNAVAILABLE",
        result.status === "PREVIEW_TOO_LARGE"
          ? "文件过大，无法在线预览"
          : "该文件类型不支持文本预览",
      );
    },
  );
};
