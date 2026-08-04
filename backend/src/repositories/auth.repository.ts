import type { Prisma, UserStatus } from "@prisma/client";
import { prisma } from "../db";

const TOKEN_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export const authRepository = {
  upsertFeishuUser(input: {
    feishuOpenId: string;
    feishuUnionId?: string | null;
    name: string;
    email?: string | null;
    avatarUrl?: string | null;
    departmentPath?: string[];
    isCompanyUser: boolean;
    status?: UserStatus;
  }) {
    return prisma.user.upsert({
      where: {
        feishuOpenId: input.feishuOpenId,
      },
      create: {
        ...input,
        departmentPath: input.departmentPath || [],
        status: input.status || "ACTIVE",
        lastLoginAt: new Date(),
      },
      update: {
        feishuUnionId: input.feishuUnionId,
        name: input.name,
        email: input.email,
        avatarUrl: input.avatarUrl,
        ...(input.departmentPath !== undefined
          ? { departmentPath: input.departmentPath }
          : {}),
        isCompanyUser: input.isCompanyUser,
        lastLoginAt: new Date(),
      },
    });
  },

  replaceDesktopAuthCode(
    data: Prisma.UserTokenUncheckedCreateInput,
  ) {
    return prisma.$transaction(async (tx) => {
      await tx.userToken.updateMany({
        where: {
          userId: data.userId,
          clientType: "desktop-auth-code",
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });
      return tx.userToken.create({ data });
    });
  },

  findUserTokenByHash(tokenHash: string) {
    return prisma.userToken.findUnique({
      where: {
        tokenHash,
      },
      include: {
        user: true,
      },
    });
  },

  touchUserToken(id: string) {
    const now = new Date();
    return prisma.userToken.updateMany({
      where: {
        id,
        OR: [
          {
            lastUsedAt: null,
          },
          {
            lastUsedAt: {
              lt: new Date(now.getTime() - TOKEN_TOUCH_INTERVAL_MS),
            },
          },
        ],
      },
      data: {
        lastUsedAt: now,
      },
    });
  },

  revokeUserTokenByHash(tokenHash: string) {
    return prisma.userToken.updateMany({
      where: {
        tokenHash,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
  },

  async exchangeDesktopAuthCode(input: {
    codeHash: string;
    tokenHash: string;
    expiresAt: Date;
  }) {
    return prisma.$transaction(async (tx) => {
      const authCode = await tx.userToken.findUnique({
        where: {
          tokenHash: input.codeHash,
        },
        include: {
          user: true,
        },
      });

      if (
        !authCode ||
        authCode.clientType !== "desktop-auth-code" ||
        authCode.revokedAt ||
        !authCode.scopes.includes("auth:exchange") ||
        (authCode.expiresAt && authCode.expiresAt <= new Date()) ||
        authCode.user.status !== "ACTIVE" ||
        !authCode.user.isCompanyUser
      ) {
        return null;
      }

      const consumed = await tx.userToken.updateMany({
        where: {
          id: authCode.id,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });
      if (consumed.count !== 1) {
        return null;
      }

      await tx.userToken.updateMany({
        where: {
          userId: authCode.userId,
          clientType: "desktop",
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });

      const token = await tx.userToken.create({
        data: {
          userId: authCode.userId,
          tokenHash: input.tokenHash,
          name: "Kocotree Skills Desktop",
          clientType: "desktop",
          platform: "desktop",
          scopes: ["user:read", "skill:install"],
          expiresAt: input.expiresAt,
        },
      });

      return {
        user: authCode.user,
        token,
      };
    });
  },
};
