import { useEffect, useState } from "react";
import {
  skillApi,
  SkillApiError,
  type SkillSummaryDto,
  type UserDto,
} from "../api";
import { AppIcon } from "./AppIcon";
import { Button, Modal, Spin, Toast } from "./ui";

const PAGE_SIZE = 100;

async function loadAllOwnedSkills(): Promise<SkillSummaryDto[]> {
  const items: SkillSummaryDto[] = [];
  let page = 1;
  let total = 0;
  do {
    const result = await skillApi.listMySkills({
      relation: "OWNED",
      page,
      pageSize: PAGE_SIZE,
    });
    items.push(...result.items);
    total = result.total;
    if (result.items.length === 0) break;
    page += 1;
  } while (items.length < total);
  return items;
}

/**
 * 功能说明：展示当前登录用户在平台中创建的真实 Skill，并提供永久删除入口。
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [deleteTarget, setDeleteTarget] =
    useState<SkillSummaryDto | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  useEffect(() => {
    if (!currentUser) {
      setSkills([]);
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
          "[KocotreeSkills] 我的 Skill 加载失败",
          reason,
        );
        if (active) {
          setError(
            reason instanceof SkillApiError
              ? reason.message
              : "我的 Skill 暂时无法读取",
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
            <h1>我的 Skill</h1>
            <p>这里显示由你创建并发布到平台的 Skill</p>
          </div>
        </header>

        {!currentUser ? (
          <section className="empty-state my-skills-login">
            <AppIcon name="library" size={30} />
            <strong>登录后查看我的 Skill</strong>
            <span>登录后可以查看和管理自己发布的 Skill</span>
            <Button
              theme="solid"
              type="primary"
              onClick={onLogin}
            >
              飞书登录
            </Button>
          </section>
        ) : (
          <>
            <section className="my-skills-toolbar">
              <span>
                共 <strong>{skills.length}</strong> 个 Skill
              </span>
              <Button
                size="small"
                loading={loading}
                onClick={() =>
                  setRefreshKey((current) => current + 1)
                }
              >
                刷新
              </Button>
            </section>

            {loading ? (
              <section className="empty-state">
                <Spin />
                <strong>正在读取我的 Skill</strong>
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
                {skills.map((skill) => (
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
                {skills.length === 0 && (
                  <div className="empty-state my-skills-empty">
                    <strong>这里还没有 Skill</strong>
                    <span>发布第一个 Skill 后会显示在这里</span>
                  </div>
                )}
              </section>
            )}
          </>
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
            <label>
              <span>
                输入 <code>{deleteTarget.skillName}</code>{" "}
                确认删除
              </span>
              <input
                autoFocus
                value={deleteConfirmation}
                disabled={deleting}
                onChange={(event) =>
                  setDeleteConfirmation(event.currentTarget.value)
                }
              />
            </label>
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
