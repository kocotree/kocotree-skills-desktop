import type { FastifyReply, FastifyRequest } from "fastify";
import { authService } from "./services/auth.service";

export function success<T>(data: T, code = 200) {
  return {
    code,
    data,
    msg: "success",
  };
}

export function failure(
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

export function readBearerToken(
  authorization?: string,
): string | null {
  if (!authorization) return null;
  const [scheme, token] = authorization.split(" ");
  return scheme === "Bearer" && token ? token : null;
}

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const token = readBearerToken(request.headers.authorization);
  if (!token) {
    failure(reply, 401, "UNAUTHENTICATED", "未提供登录凭证");
    return null;
  }

  const auth = await authService.authenticate(token);
  if (!auth) {
    failure(reply, 401, "UNAUTHENTICATED", "登录凭证无效或已过期");
    return null;
  }
  return auth;
}
