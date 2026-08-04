import { useEffect, useState } from "react";
import { Button, Modal, Select, Spin, TabPane, Tabs, Tag, Toast } from "./ui";
import {
  skillApi,
  SkillApiError,
  type FileEntryDto,
  type SkillDetailDto,
  type SkillFileContentDto,
  type SkillSummaryDto,
  type SkillVersionDto,
  type UserDto,
} from "../api";
import { AppIcon } from "./AppIcon";

interface SkillDetailModalProps {
  skill: SkillSummaryDto | null;
  installedSkillIds: Set<string>;
  uninstallableSkillIds: Set<string>;
  uninstallingSkillId: string | null;
  currentUser: UserDto | null;
  onClose: () => void;
  onInstall: (skill: SkillSummaryDto, version: SkillVersionDto) => void;
  onUninstall: (skill: SkillSummaryDto) => void;
  onVersionDeleted: (skill: SkillDetailDto) => void;
  onOpenDerivedSource: (skillId: string) => void;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 功能说明：把扁平文件清单整理为目录在前、子项紧随目录的树形展示顺序。
 * @param entries - 接口返回的规范化文件条目。
 * @returns 适合从上到下渲染的文件条目数组。
 */
function orderFileEntries(entries: FileEntryDto[]): FileEntryDto[] {
  const childrenByParent = new Map<string, FileEntryDto[]>();
  for (const entry of entries) {
    const separatorIndex = entry.path.lastIndexOf("/");
    const parentPath = separatorIndex >= 0 ? entry.path.slice(0, separatorIndex) : "";
    const children = childrenByParent.get(parentPath) ?? [];
    children.push(entry);
    childrenByParent.set(parentPath, children);
  }

  const ordered: FileEntryDto[] = [];
  function appendChildren(parentPath: string): void {
    const children = [...(childrenByParent.get(parentPath) ?? [])].sort((left, right) => {
      if (left.type !== right.type) return left.type === "DIRECTORY" ? -1 : 1;
      return left.path.localeCompare(right.path);
    });
    for (const child of children) {
      ordered.push(child);
      if (child.type === "DIRECTORY") appendChildren(child.path);
    }
  }
  appendChildren("");
  return ordered;
}

/**
 * 功能说明：展示 Skill 平台信息、版本历史、版本文件树和文本文件预览。
 * @param skill - 当前打开的 Skill 摘要，为 null 时关闭模态框。
 * @param installedSkillIds - 客户端已安装 Skill 编号集合。
 * @param uninstallableSkillIds - 客户端可安全卸载的 Skill 编号集合。
 * @param uninstallingSkillId - 当前正在卸载的 Skill 编号。
 * @param currentUser - 当前登录用户，匿名状态为 null。
 * @param onClose - 关闭详情模态框的回调。
 * @param onInstall - 安装指定历史版本的回调。
 * @param onUninstall - 卸载当前 Skill 的回调。
 * @param onVersionDeleted - 云端版本删除后同步刷新上层页面的回调。
 * @param onOpenDerivedSource - 返回浏览页并定位来源 Skill 的回调。
 * @returns Skill 详情模态框。
 */
export function SkillDetailModal({
  skill,
  installedSkillIds,
  uninstallableSkillIds,
  uninstallingSkillId,
  currentUser,
  onClose,
  onInstall,
  onUninstall,
  onVersionDeleted,
  onOpenDerivedSource,
}: SkillDetailModalProps) {
  const [detail, setDetail] = useState<SkillDetailDto | null>(null);
  const [versions, setVersions] = useState<SkillVersionDto[]>([]);
  const [versionTotal, setVersionTotal] = useState(0);
  const [activeTabKey, setActiveTabKey] = useState("overview");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fileVersionId, setFileVersionId] = useState("");
  const [fileEntries, setFileEntries] = useState<FileEntryDto[]>([]);
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [fileContent, setFileContent] = useState<SkillFileContentDto | null>(null);
  const [fileTreeLoading, setFileTreeLoading] = useState(false);
  const [filePreviewLoading, setFilePreviewLoading] = useState(false);
  const [fileError, setFileError] = useState("");
  const [deleteVersionTarget, setDeleteVersionTarget] = useState<SkillVersionDto | null>(null);
  const [deletingVersionId, setDeletingVersionId] = useState<string | null>(null);
  const [deleteVersionError, setDeleteVersionError] = useState("");

  useEffect(() => {
    if (!skill) {
      setDetail(null);
      setVersions([]);
      setVersionTotal(0);
      setActiveTabKey("overview");
      setFileVersionId("");
      setFileEntries([]);
      setSelectedFilePath("");
      setFileContent(null);
      setDeleteVersionTarget(null);
      setDeletingVersionId(null);
      setDeleteVersionError("");
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    Promise.all([skillApi.getSkill(skill.id), skillApi.listSkillVersions(skill.id)])
      .then(([nextDetail, versionPage]) => {
        if (!active) return;
        setDetail(nextDetail);
        setVersions(versionPage.items);
        setVersionTotal(versionPage.total);
        setFileVersionId(nextDetail.currentVersion.id);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        console.error("[KocotreeSkills] Skill 详情加载失败", reason);
        setError(reason instanceof SkillApiError ? reason.message : "详情加载失败，请稍后重试");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [skill]);

  useEffect(() => {
    if (!detail || !fileVersionId || activeTabKey !== "files") return;
    let active = true;
    setFileTreeLoading(true);
    setFileError("");
    setFileEntries([]);
    setSelectedFilePath("");
    setFileContent(null);
    skillApi.listVersionFiles(detail.id, fileVersionId)
      .then((result) => {
        if (!active) return;
        setFileEntries(result);
        const defaultFile = result.find((entry) => entry.path === "SKILL.md")
          ?? result.find((entry) => entry.type === "FILE" && entry.previewable);
        setSelectedFilePath(defaultFile?.path ?? "");
      })
      .catch((reason: unknown) => {
        if (!active) return;
        console.error("[KocotreeSkills] 版本文件树加载失败", reason);
        setFileError(reason instanceof SkillApiError ? reason.message : "文件树加载失败，请稍后重试");
      })
      .finally(() => {
        if (active) setFileTreeLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activeTabKey, detail, fileVersionId]);

  useEffect(() => {
    if (!detail || !fileVersionId || !selectedFilePath || activeTabKey !== "files") return;
    const selectedFile = fileEntries.find((entry) => entry.path === selectedFilePath);
    setFileError("");
    if (!selectedFile?.previewable) {
      setFileContent(null);
      setFilePreviewLoading(false);
      return;
    }
    let active = true;
    setFilePreviewLoading(true);
    setFileError("");
    setFileContent(null);
    skillApi.getVersionFileContent(detail.id, fileVersionId, selectedFilePath)
      .then((content) => {
        if (active) setFileContent(content);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        console.error("[KocotreeSkills] 版本文件内容加载失败", reason);
        setFileError(reason instanceof SkillApiError ? reason.message : "文件内容加载失败，请稍后重试");
      })
      .finally(() => {
        if (active) setFilePreviewLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activeTabKey, detail, fileEntries, fileVersionId, selectedFilePath]);

  const selectedFile = fileEntries.find((entry) => entry.path === selectedFilePath) ?? null;
  const orderedFileEntries = orderFileEntries(fileEntries);
  const canManageSkill = Boolean(detail && currentUser && detail.owner.id === currentUser.id);

  function cancelVersionDelete(): void {
    if (deletingVersionId) return;
    setDeleteVersionTarget(null);
    setDeleteVersionError("");
  }

  async function confirmVersionDelete(): Promise<void> {
    if (!detail || !deleteVersionTarget || deletingVersionId) return;

    const target = deleteVersionTarget;
    setDeletingVersionId(target.id);
    setDeleteVersionError("");
    try {
      const result = await skillApi.deleteSkillVersion(
        detail.id,
        target.id,
      );
      const [nextDetail, versionPage] = await Promise.all([
        skillApi.getSkill(detail.id),
        skillApi.listSkillVersions(detail.id),
      ]);
      setDetail(nextDetail);
      setVersions(versionPage.items);
      setVersionTotal(versionPage.total);
      setFileVersionId((current) =>
        current === target.id ||
        !versionPage.items.some((version) => version.id === current)
          ? nextDetail.currentVersion.id
          : current,
      );
      setDeleteVersionTarget(null);
      onVersionDeleted(nextDetail);
      if (result.ossCleaned) {
        Toast.success(`版本 v${target.version} 已永久删除`);
      } else {
        Toast.info(
          `版本 v${target.version} 已删除，安装包需要后台继续清理`,
        );
      }
    } catch (reason) {
      console.error("[KocotreeSkills] 删除 Skill 版本失败", reason);
      setDeleteVersionError(
        reason instanceof SkillApiError
          ? reason.message
          : "暂时无法删除版本，请稍后重试",
      );
    } finally {
      setDeletingVersionId(null);
    }
  }

  return (
    <>
    <Modal
      className="skill-detail-modal"
      title={detail?.displayName ?? skill?.displayName ?? "Skill 详情"}
      visible={skill !== null}
      width={900}
      centered
      onCancel={onClose}
      footer={skill ? (
        <div className="detail-footer">
          {detail ? (
            <>
              {detail.status === "ACTIVE" && (
                uninstallableSkillIds.has(detail.id) ? (
                  <Button
                    className="detail-install-button"
                    type="danger"
                    loading={uninstallingSkillId === detail.id}
                    disabled={uninstallingSkillId !== null}
                    onClick={() => onUninstall(detail)}
                  >
                    卸载
                  </Button>
                ) : (
                  <Button
                    className="detail-install-button"
                    theme="solid"
                    type="primary"
                    disabled={detail.currentVersion.status !== "PUBLISHED"}
                    icon={installedSkillIds.has(detail.id) ? undefined : <AppIcon name="download" size={16} />}
                    onClick={() => onInstall(detail, detail.currentVersion)}
                  >
                    {installedSkillIds.has(detail.id) ? "重新安装最新版" : "安装最新版"}
                  </Button>
                )
              )}
            </>
          ) : <span className="detail-footer-placeholder" aria-hidden="true" />}
        </div>
      ) : null}
    >
      {loading ? (
        <div className="detail-loading"><Spin size="large" /><span>正在加载详情…</span></div>
      ) : error ? (
        <div className="detail-error"><strong>暂时无法显示详情</strong><span>{error}</span></div>
      ) : detail ? (
        <div className="detail-body">
          {(detail.displayName !== detail.skillName || detail.status !== "ACTIVE") && (
            <div className="detail-identity">
              {detail.displayName !== detail.skillName && (
                <code>{detail.skillName}</code>
              )}
              {detail.status !== "ACTIVE" && (
                <span className={`detail-status detail-status-${detail.status.toLocaleLowerCase()}`}>
                  {detail.status === "ARCHIVED" ? "已归档" : "名称冲突"}
                </span>
              )}
            </div>
          )}
          {detail.tags.length > 0 && (
            <div className="detail-tags">
              {detail.tags.map((tag) => <Tag color="green" key={tag.id}>{tag.name}</Tag>)}
            </div>
          )}
          {detail.status !== "ACTIVE" && (
            <div className="detail-availability-notice" role="status">
              <strong>{detail.status === "ARCHIVED" ? "该 Skill 已归档" : "该 Skill 暂不可安装"}</strong>
              <span>
                {detail.status === "ARCHIVED"
                  ? detail.archiveReason ?? "归档状态下不提供版本下载和安装。"
                  : detail.nameConflictReason ?? "名称存在冲突，请使用新名称创建派生 Skill。"}
              </span>
            </div>
          )}
          {detail.derivedFrom && (
            detail.derivedFrom.linkable ? (
              <button
                className="derived-source derived-source-link"
                type="button"
                aria-label={`查看来源 Skill ${detail.derivedFrom.skillName}`}
                onClick={() => onOpenDerivedSource(detail.derivedFrom!.skillId)}
              >
                <span>派生自</span>
                <strong>{detail.derivedFrom.skillName} · v{detail.derivedFrom.version}</strong>
                <span className="derived-source-action">查看来源</span>
              </button>
            ) : (
              <div className="derived-source">
                <span>派生自</span>
                <strong>{detail.derivedFrom.skillName} · v{detail.derivedFrom.version}</strong>
                <small>来源已归档，无法跳转</small>
              </div>
            )
          )}

          <Tabs type="line" activeKey={activeTabKey} onChange={setActiveTabKey}>
            <TabPane tab="介绍" itemKey="overview">
              <section className="detail-section">
                <h3>Skill 技能描述</h3>
                <p>{detail.skillDescription}</p>
                <dl className="detail-info-grid">
                  <div><dt>最新版本</dt><dd><strong>v{detail.currentVersion.version}</strong></dd></div>
                  <div><dt>安装次数</dt><dd><strong>{detail.installCount.toLocaleString("zh-CN")}</strong></dd></div>
                  <div><dt>创建时间</dt><dd>{formatDate(detail.createdAt)}</dd></div>
                  <div><dt>更新时间</dt><dd>{formatDate(detail.updatedAt)}</dd></div>
                  <div className="detail-info-maintainers">
                    <dt>维护成员</dt>
                    <dd>
                      <div className="maintainer-list">
                        <span
                          className={detail.owner.status === "DISABLED" ? "owner-avatar disabled" : "owner-avatar"}
                          title={`${detail.owner.name} · ${detail.owner.departmentPath.join(" / ") || "部门信息暂无"}${detail.owner.status === "DISABLED" ? " · 账号已停用" : ""}`}
                        >
                          {detail.owner.name.slice(0, 1)}
                          {detail.owner.avatarUrl && (
                            <img
                              src={detail.owner.avatarUrl}
                              alt=""
                              onError={(event) => {
                                event.currentTarget.hidden = true;
                              }}
                            />
                          )}
                        </span>
                        <strong className="owner-name">{detail.owner.name}</strong>
                        <span className="owner-role">Owner</span>
                      </div>
                    </dd>
                  </div>
                  <div><dt>最近更新者</dt><dd>{detail.updatedBy.name}</dd></div>
                  <div><dt>ZIP 大小</dt><dd>{formatFileSize(detail.currentVersion.packageSize)}</dd></div>
                </dl>
              </section>
            </TabPane>
            <TabPane tab={`版本历史 ${versionTotal}`} itemKey="versions">
              <div className="version-list">
                {versions.map((version) => (
                  <article className="version-item" key={version.id}>
                    <button
                      className="version-main version-main-link"
                      type="button"
                      aria-label={`浏览 v${version.version} 的版本文件`}
                      onClick={() => {
                        setFileVersionId(version.id);
                        setActiveTabKey("files");
                      }}
                    >
                      <div>
                        <strong>v{version.version}</strong>
                        {version.id === detail.currentVersion.id && <Tag size="small" color="green">当前</Tag>}
                        {version.status === "WITHDRAWN" && <Tag size="small" color="red">已撤回</Tag>}
                      </div>
                      <p>{version.changelog}</p>
                      <span>{version.uploadedBy.name} · {formatDate(version.publishedAt)} · {formatFileSize(version.packageSize)}</span>
                      {version.status === "WITHDRAWN" && <span className="withdrawal-reason">撤回原因：{version.withdrawalReason}</span>}
                    </button>
                    <div className="version-actions">
                      {canManageSkill && (
                        <Button
                          className="version-delete-button"
                          size="small"
                          theme="borderless"
                          disabled={versionTotal <= 1 || deletingVersionId !== null}
                          aria-label={`删除版本 v${version.version}`}
                          tooltip={versionTotal <= 1 ? "至少需要保留一个版本，无法删除" : "删除此版本"}
                          icon={<AppIcon name="trash" size={17} />}
                          onClick={() => {
                            setDeleteVersionTarget(version);
                            setDeleteVersionError("");
                          }}
                        />
                      )}
                      <Button size="small" disabled={version.status === "WITHDRAWN" || detail.status !== "ACTIVE"} onClick={() => onInstall(detail, version)}>安装</Button>
                    </div>
                  </article>
                ))}
              </div>
            </TabPane>
            <TabPane tab="文件浏览" itemKey="files">
              <div className="file-tab-content">
                <div className="file-browser-toolbar">
                  <span>版本文件</span>
                  <Select
                    size="small"
                    value={fileVersionId}
                    optionList={versions.map((version) => ({
                      label: `v${version.version}`,
                      value: version.id,
                    }))}
                    onChange={(value) => setFileVersionId(String(value))}
                  />
                </div>
                <div className="file-browser">
                  <div className="file-tree" aria-label="版本文件树">
                    {fileTreeLoading ? (
                      <div className="file-pane-state"><Spin size="small" />正在读取文件树</div>
                    ) : fileEntries.length === 0 ? (
                      <div className="file-pane-state">该版本没有可展示的文件</div>
                    ) : orderedFileEntries.map((entry) => {
                      const segments = entry.path.split("/");
                      const label = segments[segments.length - 1];
                      const depth = segments.length - 1;
                      if (entry.type === "DIRECTORY") {
                        return (
                          <div
                            className="file-tree-directory"
                            style={{ paddingLeft: 11 + depth * 15 }}
                            key={entry.path}
                          >
                            <AppIcon name="folder" size={15} />
                            <span title={entry.path}>{label}</span>
                          </div>
                        );
                      }
                      return (
                        <button
                          className={selectedFilePath === entry.path ? "file-tree-file active" : "file-tree-file"}
                          style={{ paddingLeft: 11 + depth * 15 }}
                          type="button"
                          key={entry.path}
                          onClick={() => setSelectedFilePath(entry.path)}
                        >
                          <AppIcon name="file" size={15} />
                          <span title={entry.path}>{label}</span>
                          {entry.size !== null && <small>{formatFileSize(entry.size)}</small>}
                        </button>
                      );
                    })}
                  </div>
                  <div className="file-preview">
                    {selectedFile ? (
                      <header className="file-preview-heading">
                        <strong title={selectedFile.path}>{selectedFile.path}</strong>
                        <span>
                          {selectedFile.previewable ? "文本文件" : "二进制文件"}
                          {selectedFile.size !== null ? ` · ${formatFileSize(selectedFile.size)}` : ""}
                        </span>
                      </header>
                    ) : null}
                    {filePreviewLoading ? (
                      <div className="file-pane-state"><Spin size="small" />正在读取文件</div>
                    ) : fileError ? (
                      <div className="file-pane-state file-pane-error">{fileError}</div>
                    ) : fileContent ? (
                      <pre className="file-content-preview"><code>{fileContent.content}</code></pre>
                    ) : selectedFile && !selectedFile.previewable ? (
                      <div className="file-pane-state">该文件不是可预览的 UTF-8 文本</div>
                    ) : (
                      <div className="file-pane-state">选择左侧文件查看内容</div>
                    )}
                  </div>
                </div>
              </div>
            </TabPane>
          </Tabs>
        </div>
      ) : null}
    </Modal>
    <Modal
      className="delete-version-modal"
      title={deleteVersionTarget ? `删除版本 v${deleteVersionTarget.version}` : "删除版本"}
      visible={deleteVersionTarget !== null}
      width={480}
      centered
      maskClosable={!deletingVersionId}
      closeOnEsc={!deletingVersionId}
      onCancel={cancelVersionDelete}
      footer={
        <div className="delete-version-actions">
          <Button disabled={Boolean(deletingVersionId)} onClick={cancelVersionDelete}>
            取消
          </Button>
          <Button
            theme="solid"
            type="danger"
            loading={Boolean(deletingVersionId)}
            onClick={() => void confirmVersionDelete()}
          >
            永久删除
          </Button>
        </div>
      }
    >
      {deleteVersionTarget && detail && (
        <div className="delete-version-content">
          <p>
            确定永久删除 <strong>{detail.displayName}</strong> 的版本{" "}
            <strong>v{deleteVersionTarget.version}</strong> 吗？版本记录、文件和云端安装包都将被删除，且无法恢复。
          </p>
          {deleteVersionTarget.id === detail.currentVersion.id && (
            <p className="delete-version-current-notice">
              这是当前版本。删除后，剩余的最新版本会自动成为当前版本。
            </p>
          )}
          {deleteVersionError && (
            <div className="delete-version-error" role="alert">
              {deleteVersionError}
            </div>
          )}
        </div>
      )}
    </Modal>
    </>
  );
}
