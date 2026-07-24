import type { Prisma } from "@prisma/client";
import { prisma } from "../db";

export interface ListSkillsInput {
  query?: string;
  tagId?: string;
  sort: "UPDATED_DESC" | "CREATED_DESC" | "INSTALLS_DESC";
  page: number;
  pageSize: number;
}

const skillInclude = {
  creator: true,
  tags: {
    include: {
      tag: true,
    },
  },
  latestVersion: {
    include: {
      creator: true,
      files: {
        orderBy: [{ type: "asc" }, { path: "asc" }],
      },
    },
  },
} satisfies Prisma.SkillInclude;

export const catalogRepository = {
  listTags(query?: string) {
    return prisma.tag.findMany({
      where: query
        ? {
            name: {
              contains: query,
              mode: "insensitive",
            },
          }
        : undefined,
      orderBy: {
        name: "asc",
      },
    });
  },

  async listSkills(input: ListSkillsInput) {
    const where: Prisma.SkillWhereInput = {
      status: "PUBLISHED",
      latestVersionId: {
        not: null,
      },
      ...(input.query
        ? {
            OR: [
              {
                name: {
                  contains: input.query,
                  mode: "insensitive" as const,
                },
              },
              {
                description: {
                  contains: input.query,
                  mode: "insensitive" as const,
                },
              },
            ],
          }
        : {}),
      ...(input.tagId
        ? {
            tags: {
              some: {
                tagId: input.tagId,
              },
            },
          }
        : {}),
    };
    const orderBy: Prisma.SkillOrderByWithRelationInput =
      input.sort === "INSTALLS_DESC"
        ? { installCount: "desc" }
        : input.sort === "CREATED_DESC"
          ? { createdAt: "desc" }
          : { updatedAt: "desc" };

    const [items, total] = await prisma.$transaction([
      prisma.skill.findMany({
        where,
        orderBy,
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
        include: skillInclude,
      }),
      prisma.skill.count({ where }),
    ]);

    return { items, total };
  },

  getSkill(skillId: string) {
    return prisma.skill.findFirst({
      where: {
        id: skillId,
        status: "PUBLISHED",
        latestVersionId: {
          not: null,
        },
      },
      include: skillInclude,
    });
  },

  async listSkillVersions(
    skillId: string,
    page: number,
    pageSize: number,
  ) {
    const where: Prisma.SkillVersionWhereInput = {
      skillId,
      status: {
        in: ["PUBLISHED", "REVOKED"],
      },
    };
    const [skill, items, total] = await prisma.$transaction([
      prisma.skill.findFirst({
        where: {
          id: skillId,
          status: "PUBLISHED",
        },
        select: {
          id: true,
          slug: true,
          description: true,
        },
      }),
      prisma.skillVersion.findMany({
        where,
        orderBy: [
          {
            publishedAt: "desc",
          },
          {
            createdAt: "desc",
          },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          creator: true,
          files: {
            orderBy: [{ type: "asc" }, { path: "asc" }],
          },
        },
      }),
      prisma.skillVersion.count({ where }),
    ]);

    return { skill, items, total };
  },
};
