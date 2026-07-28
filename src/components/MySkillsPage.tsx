import { useEffect, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  localSkillService,
  skillApi,
  SkillApiError,
  usesRealInstaller,
  type LocalSkillRecord,
  type LocalSkillStatus,
  type SkillSummaryDto,
  type UserDto,
} from "../api";
import { AppIcon } from "./AppIcon";
import { Button, Modal, Spin, Toast } from "./ui";

const PAGE_SIZE = 100;
type SkillDomain = "local" | "published";

const LOCAL_STATUS_LABELS: Record<LocalSkillStatus, string> = {
  PLATFORM_INSTALLED: "平台安装",
  PLATFORM_MODIFIED: "本地已修改",
  PLATFORM_MATCHED: "已匹配平台",
  LOCAL_UNKNOWN: "本地 Skill",
  MISSING: "目录缺失",
};

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
 * 功能说明：展示本机 Skill 与当前用户发布的平台 Skill，并提供对应查看和管理入口。
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
  const [domain, setDomain] = useState<SkillDomain>("local");
  const [localSkills, setLocalSkills] = useState<LocalSkillRecord[]>([]);
  const [localLoading, setLocalLoading] = useState(true);
  const [localError, setLocalError] = useState("");
  const [localRefreshKey, setLocalRefreshKey] = useState(0);
  const [skills, setSkills] = useState<SkillSummaryDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [deleteTarget, setDeleteTarget] =
    useState<SkillSummaryDto | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const deleteInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    setLocalLoading(true);
    setLocalError("");
    void localSkillService.scanSkills()
      .then((items) => {
        if (active) setLocalSkills(items);
      })
      .catch((reason: unknown) => {
        console.error("[KocotreeSkills] 本地 Skill 扫描失败", reason);
        if (active) {
          setLocalError(
            reason instanceof SkillApiError
              ? reason.message
              : "暂时无法读取本地 Skill",
          );
        }
      })
      .finally(() => {
        if (active) setLocalLoading(false);
      });
    return () => {
      active = false;
    };
  }, [localRefreshKey]);

  useEffect(() => {
    if (!currentUser || domain !== "published") {
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
  }, [currentUser, domain, refreshKey]);

  async function openLocalSkill(record: LocalSkillRecord): Promise<void> {
    if (!usesRealInstaller) {
      Toast.info(`本地目录：${record.installPath}`);
      return;
    }
    try {
      await revealItemInDir(record.installPath);
    } catch (reason) {
      console.error("[KocotreeSkills] 打开本地 Skill 目录失败", reason);
      Toast.error("无法在文件管理器中显示本地 Skill");
    }
  }

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
            <h1>我的 Skill</h1>
            <p>查看本机已有的 Skill，以及你发布到平台的 Skill</p>
          </div>
        </header>

        <section className="my-skills-toolbar">
          <div className="domain-tabs" role="tablist" aria-label="Skill 来源">
            <button
              className={domain === "local" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={domain === "local"}
              onClick={() => setDomain("local")}
            >
              本地 Skill
            </button>
            <button
              className={domain === "published" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={domain === "published"}
              onClick={() => setDomain("published")}
            >
              我发布的
            </button>
          </div>
          <span>
            共 <strong>{domain === "local" ? localSkills.length : skills.length}</strong> 个 Skill
          </span>
          <Button
            size="small"
            loading={domain === "local" ? localLoading : loading}
            onClick={() => {
              if (domain === "local") {
                setLocalRefreshKey((current) => current + 1);
              } else {
                setRefreshKey((current) => current + 1);
              }
            }}
          >
            刷新
          </Button>
        </section>

        {domain === "local" ? (
          localLoading ? (
            <section className="empty-state">
              <Spin />
              <strong>正在扫描本地 Skill</strong>
            </section>
          ) : localError ? (
            <section className="empty-state">
              <strong>暂时无法扫描本地 Skill</strong>
              <span>{localError}</span>
              <Button
                size="small"
                onClick={() =>
                  setLocalRefreshKey((current) => current + 1)
                }
              >
                重试
              </Button>
            </section>
          ) : (
            <section className="my-skills-list">
              {localSkills.map((record) => (
                <article className="my-skill-card local" key={record.id}>
                  <button
                    className="my-skill-card-open"
                    type="button"
                    onClick={() => void openLocalSkill(record)}
                  >
                    <span className="my-skill-card-heading">
                      <span className="skill-logo skill-logo-green">
                        {record.skillName.slice(0, 2).toUpperCase()}
                      </span>
                      <span className="my-skill-main">
                        <strong>{record.displayName}</strong>
                        <code>{record.skillName}</code>
                        <small title={record.installPath}>
                          {record.installPath}
                        </small>
                      </span>
                    </span>
                  </button>
                  <div className="my-skill-card-footer">
                    <div className="my-skill-statuses">
                      <span
                        className={`local-status local-status-${record.status.toLocaleLowerCase()}`}
                      >
                        {LOCAL_STATUS_LABELS[record.status]}
                      </span>
                      {record.version && (
                        <span className="my-skill-version">
                          v{record.version}
                        </span>
                      )}
                    </div>
                    <Button
                      size="small"
                      onClick={() => void openLocalSkill(record)}
                    >
                      在目录中显示
                    </Button>
                  </div>
                </article>
              ))}
              {localSkills.length === 0 && (
                <div className="empty-state my-skills-empty">
                  <strong>没有发现本地 Skill</strong>
                  <span>
                    将 Skill 放入 ~/.agents/skills 或 ~/.codex/skills 后刷新
                  </span>
                </div>
              )}
            </section>
          )
        ) : !currentUser ? (
          <section className="empty-state my-skills-login">
            <AppIcon name="library" size={30} />
            <strong>登录后查看我发布的 Skill</strong>
            <span>本地 Skill 无需登录，平台发布记录需要验证身份</span>
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
