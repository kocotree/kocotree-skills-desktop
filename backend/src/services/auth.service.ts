import type { User } from "@prisma/client";
import { config } from "../config";
import { authRepository } from "../repositories/auth.repository";
import type { FeishuUser } from "./feishu.service";
import {
  addSeconds,
  createRandomToken,
  hashSecret,
  signValue,
  verifySignature,
} from "../utils/crypto";

type OAuthState = {
  mode: "desktop";
  nonce: string;
  callbackUrl: string;
  expiresAt: string;
};

function expiresAfter(seconds: number): Date {
  return addSeconds(new Date(), seconds);
}

function isExpired(value: Date | null): boolean {
  return value !== null && value.getTime() <= Date.now();
}

function toUserDto(user: User) {
  return {
    id: user.id,
    name: user.name,
    avatarUrl: user.avatarUrl,
    departmentPath: [] as string[],
    status: user.status,
    role: "USER" as const,
    syncedAt: user.updatedAt.toISOString(),
  };
}

function encodeOAuthState(state: OAuthState): string {
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  return `${payload}.${signValue(payload)}`;
}

function decodeOAuthState(state: string): OAuthState | null {
  const [payload, signature] = state.split(".");
  if (!payload || !signature || !verifySignature(payload, signature)) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as OAuthState;
    if (
      parsed.mode !== "desktop" ||
      !parsed.nonce ||
      !parsed.callbackUrl ||
      !parsed.expiresAt ||
      Date.parse(parsed.expiresAt) <= Date.now()
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function resolveDesktopCallbackUrl(value?: string): string | null {
  const candidate = value || config.desktopAuthCallbackUrl;
  let url: URL;
  let configuredUrl: URL;
  try {
    url = new URL(candidate);
    configuredUrl = new URL(config.desktopAuthCallbackUrl);
  } catch {
    return null;
  }

  if (url.toString() === configuredUrl.toString()) {
    return url.toString();
  }

  const isLoopback =
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    Boolean(url.port) &&
    url.pathname === "/auth/callback" &&
    !url.username &&
    !url.password;
  return isLoopback ? url.toString() : null;
}

export const authService = {
  prepareFeishuLogin(callbackUrl?: string) {
    const resolvedCallbackUrl = resolveDesktopCallbackUrl(callbackUrl);
    if (!resolvedCallbackUrl) {
      return null;
    }

    return {
      state: encodeOAuthState({
        mode: "desktop",
        nonce: createRandomToken("desktop_oauth", 24),
        callbackUrl: resolvedCallbackUrl,
        expiresAt: expiresAfter(config.oauthStateTtlSeconds).toISOString(),
      }),
    };
  },

  async completeFeishuLogin(state: string, feishuUser: FeishuUser) {
    const oauthState = decodeOAuthState(state);
    if (!oauthState || !resolveDesktopCallbackUrl(oauthState.callbackUrl)) {
      return null;
    }

    const user = await authRepository.upsertFeishuUser({
      ...feishuUser,
      status: "ACTIVE",
    });
    const code = createRandomToken("koco_desktop_code", 32);
    const expiresAt = expiresAfter(config.desktopAuthCodeTtlSeconds);
    await authRepository.replaceDesktopAuthCode({
      userId: user.id,
      tokenHash: hashSecret(code),
      name: "Desktop authorization code",
      clientType: "desktop-auth-code",
      platform: "desktop",
      scopes: ["auth:exchange"],
      expiresAt,
    });

    return {
      code,
      callbackUrl: oauthState.callbackUrl,
    };
  },

  async exchangeCode(code: string) {
    const token = createRandomToken("koco", 36);
    const expiresAt = expiresAfter(config.desktopTokenTtlSeconds);
    const result = await authRepository.exchangeDesktopAuthCode({
      codeHash: hashSecret(code),
      tokenHash: hashSecret(token),
      expiresAt,
    });
    if (!result) {
      return null;
    }

    return {
      user: toUserDto(result.user),
      token,
      expiresAt: expiresAt.toISOString(),
    };
  },

  async authenticate(token: string) {
    const record = await authRepository.findUserTokenByHash(
      hashSecret(token),
    );
    if (
      !record ||
      record.clientType === "desktop-auth-code" ||
      record.revokedAt ||
      isExpired(record.expiresAt) ||
      record.user.status !== "ACTIVE" ||
      !record.user.isCompanyUser
    ) {
      return null;
    }

    await authRepository.touchUserToken(record.id);
    return {
      user: toUserDto(record.user),
      scopes: record.scopes,
    };
  },

  logout(token: string) {
    return authRepository.revokeUserTokenByHash(hashSecret(token));
  },
};
