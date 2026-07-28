import { prisma } from "../db";

export type DeleteOwnedSkillResult =
  | {
      status: "DELETED";
      objectKeys: Array<{ bucket: string; objectKey: string }>;
    }
  | {
      status: "SKILL_NOT_FOUND" | "OWNER_REQUIRED";
    };

export const skillDeletionRepository = {
  deleteOwnedSkill(
    skillId: string,
    userId: string,
  ): Promise<DeleteOwnedSkillResult> {
    return prisma.$transaction(async (tx) => {
      const skill = await tx.skill.findUnique({
        where: {
          id: skillId,
        },
        select: {
          createdBy: true,
          versions: {
            select: {
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

      await tx.skill.delete({
        where: {
          id: skillId,
        },
      });
      return {
        status: "DELETED",
        objectKeys: skill.versions.map((version) => ({
          bucket: version.ossBucket,
          objectKey: version.ossObjectKey,
        })),
      };
    });
  },
};
