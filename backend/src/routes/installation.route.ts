import type { FastifyPluginAsync } from "fastify";
import { failure, requireAuth, success } from "../http";
import { installationService } from "../services/installation.service";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export const installationRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/skills/:skillId/versions/:versionId/download-tickets",
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

      try {
        const result =
          await installationService.createDownloadTicket(
            skillId,
            versionId,
          );
        if (result.status === "VERSION_NOT_FOUND") {
          return failure(
            reply,
            404,
            "VERSION_NOT_FOUND",
            "没有找到该 Skill 版本",
          );
        }
        if (result.status === "INSTALLATION_UNAVAILABLE") {
          return failure(
            reply,
            409,
            "INSTALLATION_UNAVAILABLE",
            "当前 Skill 版本不可安装",
          );
        }
        return reply.code(201).send(success(result.data, 201));
      } catch (error) {
        request.log.error(
          { err: error, skillId, versionId },
          "签发 Skill 下载凭证失败",
        );
        return failure(
          reply,
          503,
          "DOWNLOAD_UNAVAILABLE",
          "暂时无法生成下载地址，请稍后重试",
        );
      }
    },
  );

  app.post("/installations/events", async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return;

    const body = isRecord(request.body) ? request.body : {};
    const eventId =
      typeof body.eventId === "string" ? body.eventId.trim() : "";
    const skillId =
      typeof body.skillId === "string" ? body.skillId.trim() : "";
    const versionId =
      typeof body.versionId === "string"
        ? body.versionId.trim()
        : "";
    const installedAtValue =
      typeof body.installedAt === "string"
        ? body.installedAt
        : "";
    const installedAt = new Date(installedAtValue);
    if (
      !eventId ||
      !UUID_PATTERN.test(eventId) ||
      !UUID_PATTERN.test(skillId) ||
      !UUID_PATTERN.test(versionId) ||
      !installedAtValue ||
      Number.isNaN(installedAt.getTime())
    ) {
      return failure(
        reply,
        400,
        "INVALID_REQUEST",
        "安装事件参数无效",
      );
    }

    try {
      const result = await installationService.recordInstallation({
        eventId,
        userId: auth.user.id,
        skillId,
        versionId,
        installedAt,
      });
      if (result.status === "VERSION_NOT_FOUND") {
        return failure(
          reply,
          404,
          "VERSION_NOT_FOUND",
          "没有找到该 Skill 版本",
        );
      }
      if (result.status === "IDEMPOTENCY_KEY_REUSED") {
        return failure(
          reply,
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "安装事件编号已用于其他安装记录",
        );
      }
      return success({});
    } catch (error) {
      request.log.error(
        { err: error, eventId, skillId, versionId },
        "记录 Skill 安装事件失败",
      );
      return failure(
        reply,
        503,
        "INSTALLATION_REPORT_UNAVAILABLE",
        "安装已完成，但暂时无法同步安装记录",
      );
    }
  });
};
