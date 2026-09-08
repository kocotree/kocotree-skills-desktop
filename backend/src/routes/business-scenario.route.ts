import type { FastifyPluginAsync } from "fastify";
import { failure, requireAuth, success } from "../http";
import { BusinessScenarioSuggestionError, businessScenarioSuggestionService } from "../services/business-scenario-suggestion.service";

function parseBody(body: unknown): { content: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BusinessScenarioSuggestionError(400, "INVALID_REQUEST", "请求内容必须是 JSON 对象");
  }
  const content = (body as Record<string, unknown>).content;
  if (typeof content !== "string" || !content.trim() || content.length > 20_000) {
    throw new BusinessScenarioSuggestionError(400, "INVALID_REQUEST", "Skill 内容必须为 1 至 20000 个字符");
  }
  return { content: content.trim() };
}

export const businessScenarioRoutes: FastifyPluginAsync = async (app) => {
  app.post("/business-scenarios/suggestions", async (request, reply) => {
    const auth = await requireAuth(request, reply);
    if (!auth) return;
    try {
      return success(await businessScenarioSuggestionService.suggest(parseBody(request.body)));
    } catch (error) {
      if (error instanceof BusinessScenarioSuggestionError) return failure(reply, error.statusCode, error.code, error.message);
      request.log.error(error, "业务场景 AI 建议失败");
      return failure(reply, 503, "SCENARIO_SUGGESTION_UNAVAILABLE", "AI 场景建议服务暂时不可用，请重试");
    }
  });
};
