import type { Prisma } from "@prisma/client";
import { prisma } from "../db";

export interface ListSkillsInput {
  query?: string;
  tagIds?: string[];
  departmentPath?: string[];
  sort: "UPDATED_DESC" | "CREATED_DESC" | "INSTALLS_DESC";
  page: number;
  pageSize: number;
}

const userSummarySelect = {
  id: true,
  name: true,
  avatarUrl: true,
  departmentPath: true,
  status: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

const skillSummarySelect = {
  id: true,
  slug: true,
  name: true,
  description: true,
  installCount: true,
  createdAt: true,
  updatedAt: true,
  creator: {
    select: userSummarySelect,
  },
  tags: {
    select: {
      tag: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  },
  latestVersion: {
    select: {
      id: true,
      version: true,
      status: true,
      manifestJson: true,
      readmeMd: true,
      changelog: true,
      packageSize: true,
      checksumSha256: true,
      publishedAt: true,
      createdAt: true,
      creator: {
        select: userSummarySelect,
      },
    },
  },
} satisfies Prisma.SkillSelect;

const skillDetailInclude = {
  creator: true,
  tags: {
    include: {
      tag: true,
    },
  },
  latestVersion: {
    include: {
      creator: true,
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

  listPublishedSkillDepartmentPaths() {
    return prisma.user.findMany({
      where: {
        departmentPath: {
          isEmpty: false,
        },
        createdSkills: {
          some: {
            status: "PUBLISHED",
            latestVersionId: {
              not: null,
            },
          },
        },
      },
      select: {
        departmentPath: true,
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
      ...(input.tagIds?.length
        ? {
            tags: {
              some: {
                tagId: {
                  in: input.tagIds,
                },
              },
            },
          }
        : {}),
      ...(input.departmentPath
        ? {
            creator: {
              is: {
                departmentPath: {
                  equals: input.departmentPath,
                },
              },
            },
          }
        : {}),
    };
    const orderBy: Prisma.SkillOrderByWithRelationInput | Prisma.SkillOrderByWithRelationInput[] =
      input.sort === "INSTALLS_DESC"
        ? [
            { installCount: "desc" },
            { updatedAt: "desc" },
            { createdAt: "desc" },
            { id: "desc" },
          ]
        : input.sort === "CREATED_DESC"
          ? [
              { createdAt: "desc" },
              { id: "desc" },
            ]
          : [
              { updatedAt: "desc" },
              { id: "desc" },
            ];

    // 浏览列表允许在极短的并发写入窗口内由下一次刷新收敛，避免只读事务
    // 将关系加载和总数统计串行绑定到同一个远程数据库连接。
    const [items, total] = await Promise.all([
      prisma.skill.findMany({
        where,
        orderBy,
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
        select: skillSummarySelect,
      }),
      prisma.skill.count({ where }),
    ]);

    return { items, total };
  },

  async listOwnedSkills(
    userId: string,
    page: number,
    pageSize: number,
  ) {
    const where: Prisma.SkillWhereInput = {
      createdBy: userId,
      status: "PUBLISHED",
      latestVersionId: {
        not: null,
      },
    };
    const [items, total] = await Promise.all([
      prisma.skill.findMany({
        where,
        orderBy: [
          { updatedAt: "desc" },
          { id: "desc" },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: skillSummarySelect,
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
      include: skillDetailInclude,
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
        },
      }),
      prisma.skillVersion.count({ where }),
    ]);

    return { skill, items, total };
  },

  listVersionHashFiles(versionIds: string[]) {
    return prisma.skillFile.findMany({
      where: {
        versionId: {
          in: versionIds,
        },
      },
      select: {
        versionId: true,
        type: true,
        path: true,
        checksumSha256: true,
        sizeBytes: true,
      },
    });
  },

  getSkillVersionFiles(skillId: string, versionId: string) {
    return prisma.skillVersion.findFirst({
      where: {
        id: versionId,
        skillId,
        status: {
          in: ["PUBLISHED", "REVOKED"],
        },
        skill: {
          status: "PUBLISHED",
        },
      },
      select: {
        id: true,
        ossBucket: true,
        ossObjectKey: true,
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
};
