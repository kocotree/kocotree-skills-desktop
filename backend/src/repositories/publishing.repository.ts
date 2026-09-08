import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import type { PreparedSkillEntry } from "../services/skill-package.service";

type NewTag = {
  slug: string;
  name: string;
};

type StoredVersionInput = {
  id: string;
  version: string;
  ossBucket: string;
  ossObjectKey: string;
  ossEtag: string | null;
  packageSize: number;
  checksumSha256: string;
  manifestJson: Prisma.InputJsonValue;
  readmeMd: string;
  changelog: string;
  createdBy: string;
  entries: PreparedSkillEntry[];
};

export class PublishingPersistenceError extends Error {
  constructor(
    readonly code:
      | "VERSION_CONFLICT"
      | "TAG_NOT_FOUND"
      | "BUSINESS_SCENARIO_NOT_FOUND"
      | "OWNER_REQUIRED",
  ) {
    super(code);
    this.name = "PublishingPersistenceError";
  }
}

async function replaceTags(
  tx: Prisma.TransactionClient,
  skillId: string,
  tagIds: string[],
  newTags: NewTag[],
): Promise<void> {
  const uniqueTagIds = [...new Set(tagIds)];
  if (uniqueTagIds.length > 0) {
    const existingCount = await tx.tag.count({
      where: {
        id: {
          in: uniqueTagIds,
        },
      },
    });
    if (existingCount !== uniqueTagIds.length) {
      throw new PublishingPersistenceError("TAG_NOT_FOUND");
    }
  }

  for (const tag of newTags) {
    const stored = await tx.tag.upsert({
      where: {
        slug: tag.slug,
      },
      create: tag,
      update: {},
      select: {
        id: true,
      },
    });
    uniqueTagIds.push(stored.id);
  }

  const resolvedTagIds = [...new Set(uniqueTagIds)];
  if (resolvedTagIds.length > 5) {
    throw new PublishingPersistenceError("TAG_NOT_FOUND");
  }

  await tx.skillTag.deleteMany({
    where: {
      skillId,
    },
  });
  if (resolvedTagIds.length > 0) {
    await tx.skillTag.createMany({
      data: resolvedTagIds.map((tagId) => ({
        skillId,
        tagId,
      })),
      skipDuplicates: true,
    });
  }
}

async function createVersionFiles(
  tx: Prisma.TransactionClient,
  versionId: string,
  entries: PreparedSkillEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  await tx.skillFile.createMany({
    data: entries.map((entry) => ({
      versionId,
      path: entry.path,
      type: entry.type,
      sizeBytes:
        entry.sizeBytes === null ? null : BigInt(entry.sizeBytes),
      checksumSha256: entry.checksumSha256,
      sortOrder: entry.sortOrder,
    })),
  });
}

export const publishingRepository = {
  findPublishTargetBySkillName(skillName: string) {
    return prisma.skill.findFirst({
      where: {
        slug: {
          equals: skillName,
          mode: "insensitive",
        },
      },
      select: {
        id: true,
        createdBy: true,
        status: true,
        latestVersionId: true,
      },
    });
  },

  listIdentityCandidates() {
    return prisma.skill.findMany({
      select: {
        id: true,
        slug: true,
        latestVersion: {
          select: {
            readmeMd: true,
            manifestJson: true,
          },
        },
      },
    });
  },

  listDisplayNameConflicts(
    displayName: string,
    excludedSkillId?: string,
  ) {
    return prisma.skill.findMany({
      where: {
        name: {
          equals: displayName,
          mode: "insensitive",
        },
        ...(excludedSkillId
          ? {
              id: {
                not: excludedSkillId,
              },
            }
          : {}),
      },
      select: {
        id: true,
        slug: true,
        name: true,
        latestVersion: {
          select: {
            readmeMd: true,
            manifestJson: true,
          },
        },
      },
      take: 10,
    });
  },

  getForkSource(skillId: string, versionId: string) {
    return prisma.skillVersion.findFirst({
      where: {
        id: versionId,
        skillId,
      },
      select: {
        id: true,
      },
    });
  },

  getSkillForPublishing(skillId: string) {
    return prisma.skill.findUnique({
      where: {
        id: skillId,
      },
      include: {
        latestVersion: {
          include: {
            files: true,
          },
        },
        versions: {
          include: {
            files: true,
          },
        },
      },
    });
  },

  getSkillForMetadataUpdate(skillId: string) {
    return prisma.skill.findUnique({
      where: {
        id: skillId,
      },
      select: {
        id: true,
        createdBy: true,
      },
    });
  },

  async createPublishedSkill(input: {
    skillId: string;
    slug: string;
    displayName: string;
    displayDescription: string;
    readmeTitle: string;
    version: StoredVersionInput;
    tagIds: string[];
    newTags: NewTag[];
    businessScenarioIds: string[];
    assignedBy: string;
  }): Promise<string> {
    return prisma.$transaction(async (tx) => {
      const skill = await tx.skill.create({
        data: {
          id: input.skillId,
          slug: input.slug,
          name: input.displayName,
          description: input.displayDescription,
          readmeTitle: input.readmeTitle,
          status: "DRAFT",
          createdBy: input.version.createdBy,
        },
      });
      await tx.skillVersion.create({
        data: {
          id: input.version.id,
          skillId: skill.id,
          version: input.version.version,
          ossBucket: input.version.ossBucket,
          ossObjectKey: input.version.ossObjectKey,
          ossEtag: input.version.ossEtag,
          packageSize: BigInt(input.version.packageSize),
          checksumSha256: input.version.checksumSha256,
          manifestJson: input.version.manifestJson,
          readmeMd: input.version.readmeMd,
          changelog: input.version.changelog,
          status: "PUBLISHED",
          publishedAt: new Date(),
          createdBy: input.version.createdBy,
        },
      });
      await createVersionFiles(
        tx,
        input.version.id,
        input.version.entries,
      );
      await replaceTags(
        tx,
        skill.id,
        input.tagIds,
        input.newTags,
      );
      if (input.businessScenarioIds.length > 0) {
        const scenarios = await tx.businessScenario.findMany({
          where: { id: { in: input.businessScenarioIds }, status: "ACTIVE" },
          select: { id: true },
        });
        if (scenarios.length !== input.businessScenarioIds.length) {
          throw new PublishingPersistenceError("BUSINESS_SCENARIO_NOT_FOUND");
        }
        await tx.skillBusinessScenario.createMany({
          data: input.businessScenarioIds.map((scenarioId) => ({
            skillId: skill.id,
            scenarioId,
            assignedBy: input.assignedBy,
          })),
        });
      }
      await tx.skill.update({
        where: {
          id: skill.id,
        },
        data: {
          latestVersionId: input.version.id,
          status: "PUBLISHED",
        },
      });
      return skill.id;
    });
  },

  async updateSkillMetadata(input: {
    skillId: string;
    ownerId: string;
    displayName?: string;
    displayDescription?: string;
    tagIds?: string[];
    newTags?: NewTag[];
  }): Promise<string> {
    return prisma.$transaction(async (tx) => {
      const updated = await tx.skill.updateMany({
        where: {
          id: input.skillId,
          createdBy: input.ownerId,
        },
        data: {
          ...(input.displayName !== undefined
            ? { name: input.displayName }
            : {}),
          ...(input.displayDescription !== undefined
            ? { description: input.displayDescription }
            : {}),
          updatedAt: new Date(),
        },
      });
      if (updated.count !== 1) {
        throw new PublishingPersistenceError("OWNER_REQUIRED");
      }

      if (input.tagIds !== undefined) {
        await replaceTags(
          tx,
          input.skillId,
          input.tagIds,
          input.newTags || [],
        );
      }
      return input.skillId;
    });
  },

  async publishVersion(input: {
    skillId: string;
    baseVersionId: string;
    ownerId: string;
    version: StoredVersionInput;
    displayName?: string;
    displayDescription?: string;
    tagIds?: string[];
    newTags?: NewTag[];
  }): Promise<string> {
    return prisma.$transaction(async (tx) => {
      await tx.skillVersion.create({
        data: {
          id: input.version.id,
          skillId: input.skillId,
          version: input.version.version,
          ossBucket: input.version.ossBucket,
          ossObjectKey: input.version.ossObjectKey,
          ossEtag: input.version.ossEtag,
          packageSize: BigInt(input.version.packageSize),
          checksumSha256: input.version.checksumSha256,
          manifestJson: input.version.manifestJson,
          readmeMd: input.version.readmeMd,
          changelog: input.version.changelog,
          status: "PUBLISHED",
          publishedAt: new Date(),
          createdBy: input.version.createdBy,
        },
      });
      await createVersionFiles(
        tx,
        input.version.id,
        input.version.entries,
      );

      const updated = await tx.skill.updateMany({
        where: {
          id: input.skillId,
          latestVersionId: input.baseVersionId,
          createdBy: input.ownerId,
        },
        data: {
          latestVersionId: input.version.id,
          ...(input.displayName !== undefined
            ? { name: input.displayName }
            : {}),
          ...(input.displayDescription !== undefined
            ? { description: input.displayDescription }
            : {}),
        },
      });
      if (updated.count !== 1) {
        throw new PublishingPersistenceError("VERSION_CONFLICT");
      }

      if (input.tagIds !== undefined) {
        await replaceTags(
          tx,
          input.skillId,
          input.tagIds,
          input.newTags || [],
        );
      }
      return input.skillId;
    });
  },
};
