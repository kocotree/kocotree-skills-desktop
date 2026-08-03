import { Prisma } from "@prisma/client";
import { prisma } from "../db";

export type DeleteOwnedSkillVersionResult =
  | {
      status: "DELETED";
      versionId: string;
      latestVersionId: string;
      bucket: string;
      objectKey: string;
    }
  | {
      status: "SKILL_NOT_FOUND";
    }
  | {
      status: "VERSION_NOT_FOUND";
    }
  | {
      status: "OWNER_REQUIRED";
    }
  | {
      status: "LAST_VERSION_REQUIRED";
    };

export const skillVersionDeletionRepository = {
  deleteOwnedSkillVersion(
    skillId: string,
    versionId: string,
    userId: string,
  ): Promise<DeleteOwnedSkillVersionResult> {
    return prisma.$transaction(
      async (tx) => {
        const skill = await tx.skill.findUnique({
          where: {
            id: skillId,
          },
          select: {
            createdBy: true,
            latestVersionId: true,
            versions: {
              where: {
                status: {
                  in: ["PUBLISHED", "REVOKED"],
                },
              },
              orderBy: [
                { publishedAt: "desc" },
                { createdAt: "desc" },
              ],
              select: {
                id: true,
                ossBucket: true,
                ossObjectKey: true,
              },
            },
          },
        });
        if (!skill) {
          return { status: "SKILL_NOT_FOUND" };
        }
        if (skill.createdBy !== userId) {
          return { status: "OWNER_REQUIRED" };
        }

        const targetVersion = skill.versions.find(
          (version) => version.id === versionId,
        );
        if (!targetVersion) {
          return { status: "VERSION_NOT_FOUND" };
        }
        if (skill.versions.length <= 1) {
          return { status: "LAST_VERSION_REQUIRED" };
        }

        const replacementVersion = skill.versions.find(
          (version) => version.id !== versionId,
        );
        if (!replacementVersion) {
          return { status: "LAST_VERSION_REQUIRED" };
        }
        const latestVersionId =
          skill.latestVersionId === versionId
            ? replacementVersion.id
            : skill.latestVersionId || replacementVersion.id;

        await tx.skill.update({
          where: {
            id: skillId,
          },
          data: {
            latestVersionId,
            updatedAt: new Date(),
          },
        });
        await tx.skillVersion.delete({
          where: {
            id: versionId,
          },
        });

        return {
          status: "DELETED",
          versionId,
          latestVersionId,
          bucket: targetVersion.ossBucket,
          objectKey: targetVersion.ossObjectKey,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );
  },
};
