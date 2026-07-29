import { useEffect, useRef, useState } from "react";
import {
  skillApi,
  SkillApiError,
  type SkillSummaryDto,
  type UserDto,
} from "../api";
import { AppIcon } from "./AppIcon";
import { Button, Modal, Spin, Toast } from "./ui";

const PAGE_SIZE = 100;

export function filterPublishedSkills<
  T extends Pick<SkillSummaryDto, "displayName" | "skillName">,
>(skills: T[], query: string): T[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return skills;
  return skills.filter(
    (skill) =>
      skill.displayName.toLocaleLowerCase().includes(normalizedQuery)
      || skill.skillName.toLocaleLowerCase().includes(normalizedQuery),
  );
}

async function loadAllOwnedSkills(): Promise<SkillSummaryDto[]> {
  const firstPage = await skillApi.listMySkills({
    relation: "OWNED",
    page: 1,
    pageSize: PAGE_SIZE,
  });
  const pageCount = Math.ceil(firstPage.total / PAGE_SIZE);
  if (pageCount <= 1) return firstPage.items;

  const remainingPages = await Promise.all(
    Array.from({ length: pageCount - 1 }, (_, index) =>
      skillApi.listMySkills({
        relation: "OWNED",
        page: index + 2,
        pageSize: PAGE_SIZE,
      }),
    ),
  );
  return [
    ...firstPage.items,
    ...remainingPages.flatMap((page) => page.items),
  ];
}

/**
 * 功能说明：展示当前用户发布的平台 Skill，并提供查看和管理入口。
 * @param currentUser - 当前登录用户，未登录时显示登录引导。
 * @param onLogin - 用户请求登录时触发。
 * @param onOpenSkill - 打开 Skill 详情的回调。
 * @returns 当前用户拥有的 Skill 列表。
 */
export function MySkillsPage({
  currentUser,
  onLogin,
  onOpenSkill,
}: {
  currentUser: UserDto | null;
  onLogin: () => void;
  onOpenSkill: (skill: SkillSummaryDto) => void;
}) {
  const [skills, setSkills] = useState<SkillSummaryDto[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [deleteTarget, setDeleteTarget] =
    useState<SkillSummaryDto | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const deleteInputRef = useRef<HTMLInputElement>(null);
  const visibleSkills = filterPublishedSkills(skills, query);

  useEffect(() => {
    if (!currentUser) {
      setSkills([]);
      setQuery("");
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    setError("");
    void loadAllOwnedSkills()
      .then((items) => {
        if (active) setSkills(items);
      })
      .catch((reason: unknown) => {
        console.error(
          "[KocotreeSkills] 我发布的 Skill 加载失败",
          reason,
        );
        if (active) {
          setError(
            reason instanceof SkillApiError
              ? reason.message
              : "我发布的 Skill 暂时无法读取",
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [currentUser, refreshKey]);

  function beginDelete(skill: SkillSummaryDto): void {
    setDeleteTarget(skill);
    setDeleteConfirmation("");
    setDeleteError("");
  }

  function cancelDelete(): void {
    if (deleting) return;
    setDeleteTarget(null);
    setDeleteConfirmation("");
    setDeleteError("");
  }

  function fillDeleteConfirmation(): void {
    if (!deleteTarget) return;
    setDeleteConfirmation(deleteTarget.skillName);
    window.requestAnimationFrame(() =>
      deleteInputRef.current?.focus(),
    );
  }

  async function confirmDelete(): Promise<void> {
    if (
      !deleteTarget ||
      deleteConfirmation.trim() !== deleteTarget.skillName
    ) {
      return;
    }

    setDeleting(true);
    setDeleteError("");
    try {
      const result = await skillApi.deleteSkill(deleteTarget.id);
      setSkills((current) =>
        current.filter((skill) => skill.id !== deleteTarget.id),
      );
      setDeleteTarget(null);
      setDeleteConfirmation("");
      if (result.ossCleaned) {
        Toast.success("Skill 已永久删除");
      } else {
        Toast.info(
          "Skill 数据已删除，部分 OSS 文件需要后台继续清理",
        );
      }
    } catch (reason) {
      console.error("[KocotreeSkills] 删除 Skill 失败", reason);
      setDeleteError(
        reason instanceof SkillApiError
          ? reason.message
          : "暂时无法删除 Skill，请稍后重试",
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <main className="page-content my-skills-page">
        <header className="page-heading">
          <div>
            <h1>我发布的 Skill</h1>
            <p>查看和管理由你发布到平台的 Skill</p>
          </div>
        </header>

        <section className="my-skills-toolbar">
          <span>
            共 <strong>{skills.length}</strong> 个 Skill
          </span>
          <div className="local-skills-toolbar-actions">
            <label className="local-skills-search">
              <AppIcon name="search" size={15} />
              <input
                type="search"
                value={query}
                placeholder="搜索我发布的 Skill"
                aria-label="搜索我发布的 Skill"
                disabled={!currentUser}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <Button
              size="small"
              loading={loading}
              disabled={!currentUser}
              onClick={() =>
                setRefreshKey((current) => current + 1)
              }
            >
              刷新
            </Button>
          </div>
        </section>

        {!currentUser ? (
          <section className="empty-state my-skills-login">
            <AppIcon name="library" size={30} />
            <strong>登录后查看我发布的 Skill</strong>
            <span>平台发布记录需要验证你的身份</span>
            <Button
              theme="solid"
              type="primary"
              onClick={onLogin}
            >
              飞书登录
            </Button>
          </section>
        ) : loading ? (
          <section className="empty-state">
            <Spin />
            <strong>正在读取我发布的 Skill</strong>
          </section>
        ) : error ? (
          <section className="empty-state">
            <strong>暂时无法加载</strong>
            <span>{error}</span>
            <Button
              size="small"
              onClick={() =>
                setRefreshKey((current) => current + 1)
              }
            >
              重试
            </Button>
          </section>
        ) : (
          <section className="my-skills-list">
            {visibleSkills.map((skill) => (
              <article
                className="my-skill-card online"
                key={skill.id}
              >
                <button
                  className="my-skill-card-open"
                  type="button"
                  onClick={() => onOpenSkill(skill)}
                >
                  <span className="my-skill-card-heading">
                    <span className="skill-logo skill-logo-blue">
                      {skill.skillName
                        .slice(0, 2)
                        .toUpperCase()}
                    </span>
                    <span className="my-skill-main">
                      <strong>{skill.displayName}</strong>
                      <code>{skill.skillName}</code>
                      <small>
                        {skill.displayDescription}
                      </small>
                    </span>
                  </span>
                </button>
                <div className="my-skill-card-footer">
                  <div className="my-skill-statuses">
                    <span className="skill-status">
                      已发布
                    </span>
                    <span className="my-skill-version">
                      v{skill.currentVersion.version}
                    </span>
                    <span className="my-skill-install-count">
                      安装 {skill.installCount.toLocaleString("zh-CN")}
                    </span>
                  </div>
                  <Button
                    size="small"
                    type="danger"
                    onClick={() => beginDelete(skill)}
                  >
                    删除
                  </Button>
                </div>
              </article>
            ))}
            {visibleSkills.length === 0 && (
              <div className="empty-state my-skills-empty">
                <strong>
                  {query.trim() ? "没有匹配的 Skill" : "这里还没有 Skill"}
                </strong>
                <span>
                  {query.trim()
                    ? "换一个名称继续搜索"
                    : "发布第一个 Skill 后会显示在这里"}
                </span>
              </div>
            )}
          </section>
        )}
      </main>

      <Modal
        className="delete-skill-modal"
        title="永久删除 Skill"
        visible={deleteTarget !== null}
        width={500}
        centered
        maskClosable={!deleting}
        closeOnEsc={!deleting}
        onCancel={cancelDelete}
        footer={
          <div className="delete-skill-actions">
            <Button disabled={deleting} onClick={cancelDelete}>
              取消
            </Button>
            <Button
              theme="solid"
              type="danger"
              loading={deleting}
              disabled={
                !deleteTarget ||
                deleteConfirmation.trim() !==
                  deleteTarget.skillName
              }
              onClick={() => void confirmDelete()}
            >
              永久删除
            </Button>
          </div>
        }
      >
        {deleteTarget && (
          <div className="delete-skill-content">
            <p>
              删除后，Skill、全部版本、文件记录和安装包都无法恢复。
            </p>
            <label htmlFor="delete-skill-confirmation">
              <span>
                输入 <code>{deleteTarget.skillName}</code>{" "}
                确认删除
              </span>
            </label>
            <div className="delete-skill-input-row">
              <input
                id="delete-skill-confirmation"
                ref={deleteInputRef}
                autoFocus
                value={deleteConfirmation}
                disabled={deleting}
                onChange={(event) =>
                  setDeleteConfirmation(event.currentTarget.value)
                }
              />
              <Button
                size="small"
                disabled={deleting}
                onClick={fillDeleteConfirmation}
              >
                一键填入
              </Button>
            </div>
            {deleteError && (
              <div className="form-error" role="alert">
                {deleteError}
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
