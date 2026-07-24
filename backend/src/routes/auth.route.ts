import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { authService } from "../services/auth.service";
import { feishuService } from "../services/feishu.service";

function success<T>(data: T, code = 200) {
  return {
    code,
    data,
    msg: "success",
  };
}

function failure(
  reply: FastifyReply,
  statusCode: number,
  errorCode: string,
  msg: string,
) {
  return reply.code(statusCode).send({
    code: statusCode,
    data: { errorCode },
    msg,
  });
}

function unauthenticated(reply: FastifyReply, msg: string) {
  return failure(reply, 401, "UNAUTHENTICATED", msg);
}

function readBearerToken(authorization?: string): string | null {
  if (!authorization) return null;
  const [scheme, token] = authorization.split(" ");
  return scheme === "Bearer" && token ? token : null;
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.get("/auth/feishu/login", async (request, reply) => {
    const query = request.query as {
      desktopCallbackUrl?: string;
    };
    const prepared = authService.prepareFeishuLogin(
      query.desktopCallbackUrl,
    );
    if (!prepared) {
      return failure(
        reply,
        400,
        "INVALID_DESKTOP_CALLBACK",
        "桌面回调地址无效",
      );
    }
    return reply.redirect(feishuService.buildAuthorizeUrl(prepared.state));
  });

  app.get("/auth/feishu/callback", async (request, reply) => {
    const query = request.query as {
      code?: string;
      state?: string;
    };
    if (!query.code || !query.state) {
      return failure(
        reply,
        400,
        "INVALID_OAUTH_CALLBACK",
        "飞书授权回调缺少 code 或 state",
      );
    }

    const feishuUser = await feishuService.getUserInfo(query.code);
    const result = await authService.completeFeishuLogin(
      query.state,
      feishuUser,
    );
    if (!result) {
      return failure(
        reply,
        400,
        "INVALID_OAUTH_STATE",
        "登录请求无效或已过期",
      );
    }

    const callbackUrl = new URL(result.callbackUrl);
    callbackUrl.searchParams.set("code", result.code);
    return reply.redirect(callbackUrl.toString());
  });

  app.post("/auth/desktop/exchange", async (request, reply) => {
    const body = request.body as {
      code?: string;
    };
    if (!body?.code) {
      return failure(reply, 400, "INVALID_REQUEST", "缺少桌面授权码");
    }

    const result = await authService.exchangeCode(body.code);
    if (!result) {
      return failure(
        reply,
        400,
        "INVALID_DESKTOP_AUTH_CODE",
        "桌面授权码无效、已过期或已使用",
      );
    }

    return reply.code(200).send(success(result));
  });

  app.post("/auth/logout", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (!token) {
      return unauthenticated(reply, "未提供登录凭证");
    }

    await authService.logout(token);
    return success({});
  });

  app.get("/users/me", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (!token) {
      return unauthenticated(reply, "未提供登录凭证");
    }

    const auth = await authService.authenticate(token);
    if (!auth) {
      return unauthenticated(reply, "登录凭证无效或已过期");
    }

    return success(auth.user);
  });
};
