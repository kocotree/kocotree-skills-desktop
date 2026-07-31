import { Prisma } from "@prisma/client";
import { prisma } from "../db";

export interface RecordInstallationInput {
  eventId: string;
  userId: string;
  skillId: string;
  versionId: string;
  installedAt: Date;
}

export type RecordInstallationResult =
  | {
      status: "RECORDED" | "DUPLICATE";
    }
  | {
      status: "VERSION_NOT_FOUND" | "IDEMPOTENCY_KEY_REUSED";
    };

function matchesExistingEvent(
  existing: {
    userId: string;
    skillId: string;
    versionId: string;
    status: string;
    clientType: string;
    completedAt: Date | null;
  },
  input: RecordInstallationInput,
): boolean {
  return (
    existing.userId === input.userId &&
    existing.skillId === input.skillId &&
    existing.versionId === input.versionId &&
    existing.status === "SUCCEEDED" &&
    existing.clientType === "CODEX" &&
    existing.completedAt?.getTime() === input.installedAt.getTime()
  );
}

export const installationRepository = {
  getVersionForDownload(skillId: string, versionId: string) {
    return prisma.skillVersion.findFirst({
      where: {
        id: versionId,
        skillId,
      },
      select: {
        id: true,
        status: true,
        ossBucket: true,
        ossObjectKey: true,
        checksumSha256: true,
        skill: {
          select: {
            status: true,
          },
        },
        files: {
          orderBy: [
            {
              sortOrder: "asc",
            },
            {
              path: "asc",
            },
          ],
        },
      },
    });
  },

  async recordInstallation(
    input: RecordInstallationInput,
  ): Promise<RecordInstallationResult> {
    try {
      return await prisma.$transaction(async (tx) => {
        const version = await tx.skillVersion.findFirst({
          where: {
            id: input.versionId,
            skillId: input.skillId,
          },
          select: {
            id: true,
          },
        });
        if (!version) {
          return { status: "VERSION_NOT_FOUND" as const };
        }

        await tx.installSession.create({
          data: {
            id: input.eventId,
            userId: input.userId,
            skillId: input.skillId,
            versionId: input.versionId,
            status: "SUCCEEDED",
            clientType: "CODEX",
            completedAt: input.installedAt,
          },
        });
        await tx.skill.update({
          where: {
            id: input.skillId,
          },
          data: {
            installCount: {
              increment: 1,
            },
          },
        });
        return { status: "RECORDED" as const };
      });
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2002"
      ) {
        throw error;
      }

      const existing =
        await prisma.installSession.findUnique({
          where: {
            id: input.eventId,
          },
          select: {
            userId: true,
            skillId: true,
            versionId: true,
            status: true,
            clientType: true,
            completedAt: true,
          },
        });
      if (!existing) {
        throw error;
      }
      return matchesExistingEvent(existing, input)
        ? { status: "DUPLICATE" }
        : { status: "IDEMPOTENCY_KEY_REUSED" };
    }
  },
};
