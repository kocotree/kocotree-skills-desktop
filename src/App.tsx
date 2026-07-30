import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Dropdown, Modal, Tooltip, Toast, ToastViewport } from "./components/ui";
import {
  AUTH_INVALIDATED_EVENT,
  skillApi,
  installer,
  localSkillService,
  usesRealInstaller,
  SkillApiError,
  countActiveLocalSkills,
  filterWorkspaceSkillGroups,
  getLocalSkillLocation,
  getUninstallableSkillRecords,
  groupLocalSkills,
  type LocalSkillFilter,
  type LocalSkillRecord,
  type SetLocalSkillEnabledInput,
  type SkillSummaryDto,
  type SkillVersionDto,
  type TagDto,
  type UserDto,
} from "./api";
import { AppIcon } from "./components/AppIcon";
import { SkillDetailModal } from "./components/SkillDetailModal";
import { UploadPage } from "./components/UploadPage";
import { MySkillsPage } from "./components/MySkillsPage";
import { LocalSkillsPage } from "./components/LocalSkillsPage";
import { AllAgentsSkillsPage } from "./components/AllAgentsSkillsPage";
import { NotificationPanel } from "./components/NotificationPanel";
import { InstallConfirmModal } from "./components/InstallConfirmModal";
import { InstallFeedbackModal, type InstallFeedbackState } from "./components/InstallFeedbackModal";
import { TagFilter } from "./components/TagFilter";
import { getSkillPageCount, SkillPagination } from "./components/LocalSkillPagination";
import { UninstallConfirmModal } from "./components/UninstallConfirmModal";
import "./App.css";

type PageKey =
  | "browse"
  | "published"
  | "upload"
  | "local-all"
  | "local-claude"
  | "local-codex";
type SortKey = "created" | "updated" | "popular";
const BROWSE_PAGE_SIZE = 18;

interface InstallPromptState {
  skill: SkillSummaryDto;
  version: SkillVersionDto;
  warnings: string[];
  forceRequired: boolean;
  promptTitle?: string;
}

interface UninstallPromptState {
  skill: SkillSummaryDto;
  record: LocalSkillRecord;
}

const logoTones = ["dark", "blue", "orange", "violet", "green"] as const;

function localFilterForPage(page: PageKey): LocalSkillFilter | null {
  if (page === "local-claude") return "claude";
  if (page === "local-codex") return "codex";
  return null;
}

function installedSkillIdsFromRecords(
  records: LocalSkillRecord[],
): Set<string> {
  return new Set(
    records.flatMap((record) =>
      getLocalSkillLocation(record) !== "MANAGER"
      && record.skillId
        ? [record.skillId]
        : [],
    ),
  );
}

function getSkillShortCode(skill: SkillSummaryDto): string {
  const words = skill.skillName.split("-").filter(Boolean);
  return words.length > 1
    ? words.slice(0, 2).map((word) => word[0]).join("").toLocaleUpperCase()
    : skill.skillName.slice(0, 2).toLocaleUpperCase();
}

/**
 * 功能说明：渲染单个 Skill 卡片，支持查看详情和一键安装最新版。
 * @param skill - 当前卡片展示的技能信息。
 * @param installed - 当前技能是否已安装。
 * @param installing - 当前技能是否正在安装。
 * @param installDisabled - 是否暂时禁止发起新的安装。
 * @param onOpen - 用户打开详情时调用的回调。
 * @param onInstall - 用户一键安装最新版时调用的回调。
 * @param highlighted - 当前卡片是否作为派生来源被定位高亮。
 * @param cardRef - 高亮卡片的元素引用回调。
 * @returns Skill 卡片的 React 元素。
 */
function SkillCard({
  skill,
  installed,
  installing,
  uninstallable,
  uninstalling,
  installDisabled,
  onOpen,
  onInstall,
  onUninstall,
  highlighted,
  cardRef,
}: {
  skill: SkillSummaryDto;
  installed: boolean;
  installing: boolean;
  uninstallable: boolean;
  uninstalling: boolean;
  installDisabled: boolean;
  onOpen: (skill: SkillSummaryDto) => void;
  onInstall: (skill: SkillSummaryDto) => void;
  onUninstall: (skill: SkillSummaryDto) => void;
  highlighted: boolean;
  cardRef?: (node: HTMLElement | null) => void;
}) {
  const tone = logoTones[skill.skillName.length % logoTones.length];
  return (
    <article
      className={highlighted ? "skill-card skill-card-highlighted" : "skill-card"}
      ref={cardRef}
      onClick={() => onOpen(skill)}
    >
      <div className="skill-card-topline">
        <button
          className="skill-title-group card-title-button"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpen(skill);
          }}
        >
          <span className={`skill-logo skill-logo-${tone}`}>
            {getSkillShortCode(skill)}
          </span>
          <span className="skill-card-copy">
            <Tooltip className="skill-text-tooltip" content={skill.displayName} onlyWhenTruncated>
              <strong className="skill-display-name">{skill.displayName}</strong>
            </Tooltip>
            <Tooltip className="skill-text-tooltip" content={skill.skillName} onlyWhenTruncated>
              <code className="skill-internal-name">{skill.skillName}</code>
            </Tooltip>
            {skill.tags.length > 0 && (
              <span className="skill-card-tags" aria-label={`标签：${skill.tags.map((tag) => tag.name).join("、")}`}>
                {skill.tags.slice(0, 2).map((tag) => <span key={tag.id}>{tag.name}</span>)}
                {skill.tags.length > 2 && <span className="skill-card-tag-count">+{skill.tags.length - 2}</span>}
              </span>
            )}
            <span className="skill-description">{skill.displayDescription}</span>
          </span>
        </button>
      </div>

      <div className="skill-card-meta">
        <Tooltip content={`Owner：${skill.owner.name}`}>
          <span className="skill-card-owner-avatar" role="img" aria-label={`Owner：${skill.owner.name}`}>
            {skill.owner.avatarUrl ? <img src={skill.owner.avatarUrl} alt="" /> : skill.owner.name.slice(0, 1)}
          </span>
        </Tooltip>
        <span className="download-count">
          <AppIcon name="download" size={14} />
          {skill.installCount.toLocaleString("zh-CN")}
        </span>
        <Tooltip
          className="skill-card-action-tooltip"
          content={uninstallable
            ? "从本地设备卸载此 Skill"
            : installed
              ? "已在本地发现，查看详情"
            : installing
              ? `正在安装最新版 v${skill.currentVersion.version}`
              : `安装最新版 v${skill.currentVersion.version}`}
        >
          <button
            className={uninstallable
              ? "install-button uninstall"
              : installed
                ? "install-button installed"
              : installing
                ? "install-button installing"
                : "install-button"}
            type="button"
            disabled={(uninstallable || !installed) && installDisabled}
            aria-busy={installing || uninstalling}
            onClick={(event) => {
              event.stopPropagation();
              if (uninstallable) {
                onUninstall(skill);
              } else if (installed) {
                onOpen(skill);
              } else {
                onInstall(skill);
              }
            }}
            aria-label={uninstallable
              ? `${skill.displayName} 一键卸载`
              : installed
                ? `${skill.displayName} 已在本地发现，查看详情`
              : `一键安装 ${skill.displayName} 最新版 v${skill.currentVersion.version}`}
          >
            {uninstalling
              ? "卸载中…"
              : uninstallable
                ? "一键卸载"
                : installed
              ? <AppIcon name="check" size={17} />
              : installing
                ? "安装中…"
                : "一键安装"}
          </button>
        </Tooltip>
      </div>
    </article>
  );
}

/**
 * 功能说明：渲染 Skill 浏览页面，支持排序、搜索、来源筛选和安装状态演示。
 * @param installedSkillIds - 已安装 Skill 的编号集合。
 * @param installingSkillId - 当前正在安装的 Skill 编号。
 * @param onOpen - 用户打开 Skill 详情时调用的回调。
 * @param onInstall - 用户一键安装最新版时调用的回调。
 * @param refreshKey - 触发列表重新加载的刷新编号。
 * @param highlightedSkillId - 需要定位并高亮的来源 Skill 编号。
 * @param onHighlightComplete - 来源卡片高亮结束后的回调。
 * @returns Skill 浏览页面的 React 元素。
 */
function BrowsePage({
  authenticated,
  authResolved,
  installedSkillIds,
  uninstallableSkillIds,
  installingSkillId,
  uninstallingSkillId,
  onLogin,
  onOpen,
  onInstall,
  onUninstall,
  refreshKey,
  highlightedSkillId,
  onHighlightComplete,
}: {
  authenticated: boolean;
  authResolved: boolean;
  installedSkillIds: Set<string>;
  uninstallableSkillIds: Set<string>;
  installingSkillId: string | null;
  uninstallingSkillId: string | null;
  onLogin: () => void;
  onOpen: (skill: SkillSummaryDto) => void;
  onInstall: (skill: SkillSummaryDto) => void;
  onUninstall: (skill: SkillSummaryDto) => void;
  refreshKey: number;
  highlightedSkillId: string | null;
  onHighlightComplete: () => void;
}) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [tagId, setTagId] = useState("all");
  const [sort, setSort] = useState<SortKey>("popular");
  const [page, setPage] = useState(1);
  const [totalSkills, setTotalSkills] = useState(0);
  const [skills, setSkills] = useState<SkillSummaryDto[]>([]);
  const [tags, setTags] = useState<TagDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const highlightedCardRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!highlightedSkillId) return;
    setQuery("");
    setTagId("all");
    setPage(1);
  }, [highlightedSkillId]);

  useEffect(() => {
    if (query === debouncedQuery) return;
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query);
      setPage(1);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [debouncedQuery, query]);

  useEffect(() => {
    if (!highlightedSkillId || loading || !skills.some((skill) => skill.id === highlightedSkillId)) return;
    highlightedCardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    const timer = window.setTimeout(onHighlightComplete, 2200);
    return () => window.clearTimeout(timer);
  }, [highlightedSkillId, loading, onHighlightComplete, skills]);

  useEffect(() => {
    if (!authenticated) {
      setTags([]);
      return;
    }
    let active = true;
    skillApi.listTags().then((items) => {
      if (active) setTags(items);
    }).catch((reason: unknown) => {
      console.error("[KocotreeSkills] Tag 加载失败", reason);
    });
    return () => { active = false; };
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated) {
      setSkills([]);
      setTotalSkills(0);
      setError("");
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError("");
    const apiSort = sort === "popular" ? "INSTALLS_DESC" : sort === "created" ? "CREATED_DESC" : "UPDATED_DESC";
    skillApi.listSkills({
      query: debouncedQuery || undefined,
      tagId: tagId === "all" ? undefined : tagId,
      sort: apiSort,
      page,
      pageSize: BROWSE_PAGE_SIZE,
    })
      .then((result) => {
        if (!active) return;
        const pageCount = getSkillPageCount(result.total, BROWSE_PAGE_SIZE);
        setTotalSkills(result.total);
        if (page > pageCount) {
          setSkills([]);
          setPage(pageCount);
          return;
        }
        setSkills(result.items);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        console.error("[KocotreeSkills] Skill 列表加载失败", reason);
        setError(reason instanceof SkillApiError ? reason.message : "列表加载失败，请稍后重试");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [authenticated, debouncedQuery, page, refreshKey, sort, tagId]);

  if (!authResolved) {
    return (
      <main className="page-content browse-page">
        <header className="page-heading">
          <h1>Skill 浏览</h1>
        </header>
        <section className="empty-state">
          <span>正在加载登录状态...</span>
        </section>
      </main>
    );
  }

  if (!authenticated) {
    return (
      <main className="page-content browse-page">
        <header className="page-heading">
          <h1>Skill 浏览</h1>
        </header>
        <section className="empty-state">
          <AppIcon name="library" size={30} />
          <strong>登录后浏览 Skill</strong>
          <span>Skill 市场和标签数据仅对已登录用户开放。</span>
          <Button theme="solid" type="primary" onClick={onLogin}>
            使用飞书登录
          </Button>
        </section>
      </main>
    );
  }

  return (
    <main className="page-content browse-page">
      <header className="page-heading">
        <h1>Skill 浏览</h1>
      </header>

      <section className="filter-panel" aria-label="Skill 筛选条件">
        <div className="filter-first-row">
          <div className="sort-tabs" role="group" aria-label="排序方式">
            <button
              className={sort === "popular" ? "active" : ""}
              type="button"
              aria-pressed={sort === "popular"}
              onClick={() => {
                setSort("popular");
                setPage(1);
              }}
            >
              <AppIcon name="hot" size={16} />热门
            </button>
            <button
              className={sort === "updated" ? "active" : ""}
              type="button"
              aria-pressed={sort === "updated"}
              onClick={() => {
                setSort("updated");
                setPage(1);
              }}
            >
              <AppIcon name="clock" size={16} />最近更新
            </button>
            <button
              className={sort === "created" ? "active" : ""}
              type="button"
              aria-pressed={sort === "created"}
              onClick={() => {
                setSort("created");
                setPage(1);
              }}
            >
              <AppIcon name="trend" size={16} />最近创建
            </button>
          </div>

          <label className="search-box">
            <AppIcon name="search" size={19} />
            <input
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="搜索 Skill..."
            />
          </label>
        </div>

        <TagFilter
          tags={tags}
          selectedTagId={tagId}
          onChange={(nextTagId) => {
            setTagId(nextTagId);
            setPage(1);
          }}
        />
      </section>

      {loading ? (
        <section className="empty-state"><span className="loading-dot" /><strong>正在加载 Skill</strong></section>
      ) : error ? (
        <section className="empty-state"><strong>暂时无法加载</strong><span>{error}</span></section>
      ) : skills.length > 0 ? (
        <>
          <section className="skill-grid" aria-label="Skill 列表">
            {skills.map((skill) => (
              <SkillCard
                key={skill.id}
                skill={skill}
                installed={installedSkillIds.has(skill.id)}
                installing={installingSkillId === skill.id}
                uninstallable={uninstallableSkillIds.has(skill.id)}
                uninstalling={uninstallingSkillId === skill.id}
                installDisabled={
                  installingSkillId !== null
                  || uninstallingSkillId !== null
                }
                onOpen={onOpen}
                onInstall={onInstall}
                onUninstall={onUninstall}
                highlighted={skill.id === highlightedSkillId}
                cardRef={skill.id === highlightedSkillId ? (node) => { highlightedCardRef.current = node; } : undefined}
              />
            ))}
          </section>
          <SkillPagination
            page={page}
            total={totalSkills}
            pageSize={BROWSE_PAGE_SIZE}
            ariaLabel="Skill 浏览分页"
            onChange={setPage}
          />
        </>
      ) : (
        <section className="empty-state">
          <AppIcon name="search" size={30} />
          <strong>没有找到匹配的 Skill</strong>
          <span>换一个关键词或标签试试</span>
        </section>
      )}
    </main>
  );
}

/**
 * 功能说明：渲染 Kocotree Skills 客户端外壳，并管理浏览、上传与安装演示状态。
 * @returns 应用主界面的 React 元素。
 */
function App() {
  const [activePage, setActivePage] = useState<PageKey>("browse");
  const [selectedSkill, setSelectedSkill] = useState<SkillSummaryDto | null>(null);
  const [selectedSkillContext, setSelectedSkillContext] = useState<"browse" | "manage">("browse");
  const [highlightedBrowseSkillId, setHighlightedBrowseSkillId] = useState<string | null>(null);
  const [uploadTargetSkill, setUploadTargetSkill] = useState<SkillSummaryDto | null>(null);
  const [uploadSessionKey, setUploadSessionKey] = useState(0);
  const [browseRefreshKey, setBrowseRefreshKey] = useState(0);
  const [publishedRefreshKey, setPublishedRefreshKey] = useState(0);
  const [currentUser, setCurrentUser] = useState<UserDto | null>(null);
  const [authResolved, setAuthResolved] = useState(false);
  const [loginVisible, setLoginVisible] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [localSkills, setLocalSkills] = useState<LocalSkillRecord[]>([]);
  const [localSkillsLoading, setLocalSkillsLoading] = useState(true);
  const [localSkillsError, setLocalSkillsError] = useState("");
  const sidebarUserAreaRef = useRef<HTMLDivElement>(null);
  const protectedActionRef = useRef<(() => void) | null>(null);
  const [installedSkillIds, setInstalledSkillIds] = useState(
    () => new Set(usesRealInstaller
      ? []
      : ["0c9c2f8d-3e84-4c0c-8a15-d41d87fd1001", "0c9c2f8d-3e84-4c0c-8a15-d41d87fd1002"]),
  );
  const [installPrompt, setInstallPrompt] = useState<InstallPromptState | null>(null);
  const [installFeedback, setInstallFeedback] = useState<InstallFeedbackState | null>(null);
  const [uninstallPrompt, setUninstallPrompt] = useState<UninstallPromptState | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installingSkillId, setInstallingSkillId] = useState<string | null>(null);
  const [uninstallingSkillId, setUninstallingSkillId] = useState<string | null>(null);

  const refreshLocalSkills = useCallback(async () => {
    setLocalSkillsLoading(true);
    setLocalSkillsError("");
    try {
      const items = await localSkillService.scanSkills();
      setLocalSkills(items);
      setInstalledSkillIds(installedSkillIdsFromRecords(items));
    } catch (reason) {
      console.error("[KocotreeSkills] 本地 Skill 扫描失败", reason);
      setLocalSkillsError(
        reason instanceof SkillApiError
          ? reason.message
          : "暂时无法读取本地 Skill",
      );
    } finally {
      setLocalSkillsLoading(false);
    }
  }, []);

  const setLocalSkillEnabled = useCallback(
    async (input: SetLocalSkillEnabledInput) => {
      const items = await localSkillService.setSkillEnabled(input);
      setLocalSkills(items);
      setInstalledSkillIds(installedSkillIdsFromRecords(items));
    },
    [],
  );

  useEffect(() => {
    skillApi.getCurrentUser().then(setCurrentUser).catch((reason: unknown) => {
      console.error("[KocotreeSkills] 当前用户状态加载失败", reason);
      setCurrentUser(null);
    }).finally(() => setAuthResolved(true));
  }, []);

  useEffect(() => {
    const handleInvalidated = () => {
      setCurrentUser(null);
      setAuthResolved(true);
      setUnreadCount(0);
      setSelectedSkill(null);
      setLoginVisible(true);
    };
    window.addEventListener(AUTH_INVALIDATED_EVENT, handleInvalidated);
    return () => {
      window.removeEventListener(
        AUTH_INVALIDATED_EVENT,
        handleInvalidated,
      );
    };
  }, []);

  useEffect(() => {
    void refreshLocalSkills();
  }, [refreshLocalSkills]);

  useEffect(() => {
    if (!currentUser) return;
    skillApi.listNotifications({ pageSize: 1 }).then((result) => {
      setUnreadCount(result.unreadCount);
    }).catch((reason: unknown) => {
      console.error("[KocotreeSkills] 未读通知数量加载失败", reason);
    });
  }, [currentUser]);

  useEffect(() => {
    const userArea = sidebarUserAreaRef.current;
    if (!userArea) {
      return;
    }
    const syncPopupWidth = () => {
      userArea.style.setProperty("--sidebar-user-popup-width", `${userArea.getBoundingClientRect().width}px`);
    };
    syncPopupWidth();
    const resizeObserver = new ResizeObserver(syncPopupWidth);
    resizeObserver.observe(userArea);
    return () => resizeObserver.disconnect();
  }, []);

  /**
   * 功能说明：执行需要身份认证的操作，匿名状态下先保留动作并打开登录弹窗。
   * @param action - 登录成功后需要继续执行的动作。
   * @returns 无返回值。
   */
  function requireAuth(action: () => void): void {
    if (currentUser) {
      action();
      return;
    }
    protectedActionRef.current = action;
    setLoginVisible(true);
  }

  /** 打开系统浏览器完成飞书授权，并继续此前被拦截的操作。 */
  async function handleSignIn(): Promise<void> {
    setLoginLoading(true);
    try {
      const user = await skillApi.signIn();
      setCurrentUser(user);
      setLoginVisible(false);
      Toast.success(`已以 ${user.name} 的身份登录`);
      const nextAction = protectedActionRef.current;
      protectedActionRef.current = null;
      nextAction?.();
    } catch (reason) {
      console.error("[KocotreeSkills] 飞书登录失败", reason);
      Toast.error("登录失败，请稍后重试");
    } finally {
      setLoginLoading(false);
    }
  }

  async function handleSignOut(): Promise<void> {
    try {
      await skillApi.signOut();
      setCurrentUser(null);
      setUnreadCount(0);
      setActivePage("browse");
      Toast.success("已退出登录");
    } catch (reason) {
      console.error("[KocotreeSkills] 退出登录失败", reason);
      Toast.error("退出失败，请稍后重试");
    }
  }

  function prepareInstall(skill: SkillSummaryDto, version: SkillVersionDto): void {
    const warnings: string[] = [];
    if (version.id !== skill.currentVersion.id) {
      warnings.push(`你正在从最新版 v${skill.currentVersion.version} 降级到历史版本 v${version.version}。确认后将安装目标版本。`);
    }
    if (warnings.length > 0) {
      setInstallPrompt({ skill, version, warnings, forceRequired: false });
      return;
    }
    void installSkillVersion(skill, version, false);
  }

  function handleOpenSkill(skill: SkillSummaryDto): void {
    console.info("[KocotreeSkills] 准备打开 Skill 详情", { skillId: skill.id });
    setSelectedSkillContext("browse");
    setSelectedSkill(skill);
  }

  function handleOpenManagedSkill(skill: SkillSummaryDto): void {
    console.info("[KocotreeSkills] 准备管理 Skill", { skillId: skill.id });
    setSelectedSkillContext("manage");
    setSelectedSkill(skill);
  }

  /**
   * 功能说明：从派生 Skill 详情返回浏览页，并定位来源 Skill 卡片。
   * @param skillId - 需要在浏览列表中定位并高亮的来源 Skill 编号。
   * @returns 无返回值。
   */
  function handleOpenDerivedSource(skillId: string): void {
    console.info("[KocotreeSkills] 准备定位派生来源 Skill", { skillId });
    setSelectedSkill(null);
    setHighlightedBrowseSkillId(skillId);
    setActivePage("browse");
  }

  /**
   * 功能说明：通过下载凭证完成指定版本的本地安装与幂等上报。
   * @param skill - 需要安装的 Skill。
   * @param version - 需要安装的版本信息。
   * @param force - 是否确认覆盖本地同名目录。
   * @returns 无返回值。
   */
  async function installSkillVersion(skill: SkillSummaryDto, version: SkillVersionDto, force: boolean): Promise<void> {
    setInstalling(true);
    setInstallingSkillId(skill.id);
    Toast.info(`正在准备 ${skill.displayName} v${version.version}`);
    try {
      const ticket = await skillApi.getDownloadTicket(skill.id, version.id);
      const detail = await skillApi.getSkill(skill.id);
      console.info("[KocotreeSkills] 已获取下载凭证", {
        skillId: skill.id,
        versionId: version.id,
        packageSha256: ticket.packageSha256,
        target: "~/.agents/skills",
      });
      const localResult = await installer.install({ skill: detail, version, ticket, force });
      await skillApi.recordInstallation({
        eventId: crypto.randomUUID(),
        skillId: skill.id,
        versionId: version.id,
        installedAt: new Date().toISOString(),
      });
      setInstalledSkillIds((currentIds) => new Set(currentIds).add(skill.id));
      setLocalSkills((current) => [
        ...current.filter(
          (record) =>
            record.installPath !== localResult.record.installPath,
        ),
        localResult.record,
      ]);
      setBrowseRefreshKey((current) => current + 1);
      setInstallPrompt(null);
      if (localResult.notices.length > 0) {
        setInstallFeedback({
          tone: "warning",
          title: "Skill 已安装，Claude 尚未接入",
          summary: "通用 Skill 目录安装成功，Codex 可以继续使用。",
          details: localResult.notices,
        });
      } else {
        Toast.success(`Skill 已安装到 ${localResult.record.installPath}`);
      }
    } catch (reason) {
      console.error("[KocotreeSkills] Skill 安装失败", reason);
      if (reason instanceof SkillApiError && reason.code === "LOCAL_SKILL_CONFLICT") {
        if (reason.details?.forceSupported === false) {
          setInstallPrompt(null);
          setInstallFeedback({
            tone: "warning",
            title: "本地已存在同名 Skill",
            summary: "第一版真实安装暂不覆盖已有目录，本地内容没有发生变化。",
            details: [
              typeof reason.details.targetPath === "string"
                ? `冲突目录：${reason.details.targetPath}`
                : reason.message,
              "请先确认并手工处理同名目录，覆盖安装将在后续版本提供。",
            ],
          });
          return;
        }
        const localStatus = typeof reason.details?.localSkill === "object" && reason.details.localSkill !== null
          ? (reason.details.localSkill as { status?: string }).status
          : undefined;
        const locallyModified = localStatus === "PLATFORM_MODIFIED";
        setInstallPrompt({
          skill,
          version,
          forceRequired: true,
          promptTitle: locallyModified ? "检测到本地内容已修改" : "发现本地同名 Skill",
          warnings: [locallyModified
            ? "本地目录包含平台安装后修改的内容。继续操作会先备份当前目录，再用平台版本替换。"
            : "本地目录中已经存在同名的未知来源 Skill。继续操作会先备份当前目录，再安装平台版本。"],
        });
        return;
      }
      setInstallPrompt(null);
      if (reason instanceof SkillApiError && reason.code === "PACKAGE_HASH_MISMATCH") {
        setInstallFeedback({
          tone: "error",
          title: "安装包校验失败",
          summary: "安装已经中止，本地 Skill 未发生变化。",
          details: [reason.message, "请稍后重新下载；重复失败时联系平台管理员检查版本文件。"],
        });
      } else if (reason instanceof SkillApiError && reason.code === "INSTALL_ROLLBACK_COMPLETED") {
        setInstallFeedback({
          tone: "error",
          title: "安装失败，已自动恢复",
          summary: "新版本没有生效，原 Skill 已恢复到安装前状态。",
          details: [reason.message, "本次失败不会上报安装次数，可以排查原因后重新尝试。"],
        });
      } else {
        Toast.error(reason instanceof SkillApiError ? reason.message : "安装失败，请稍后重试");
      }
    } finally {
      setInstalling(false);
      setInstallingSkillId(null);
    }
  }

  /** 一键安装卡片所对应 Skill 的最新版本。 */
  function handleInstallLatest(skill: SkillSummaryDto): void {
    handleInstallVersion(skill, skill.currentVersion);
  }

  function handleInstallVersion(skill: SkillSummaryDto, version: SkillVersionDto): void {
    requireAuth(() => {
      prepareInstall(skill, version);
    });
  }

  function prepareUninstall(skill: SkillSummaryDto): void {
    const record = getUninstallableSkillRecords(localSkills).get(skill.id);
    if (!record) {
      Toast.error("无法确认这个 Skill 的本地安装归属，请在本地 Skill 管理中检查");
      return;
    }
    setUninstallPrompt({ skill, record });
  }

  async function uninstallSkill(): Promise<void> {
    if (!uninstallPrompt) return;
    const { skill, record } = uninstallPrompt;
    setUninstallingSkillId(skill.id);
    try {
      const items = await localSkillService.remove({
        skillId: skill.id,
        skillName: record.skillName,
      });
      setLocalSkills(items);
      setInstalledSkillIds(installedSkillIdsFromRecords(items));
      setUninstallPrompt(null);
      Toast.success(`${skill.displayName} 已从本地设备卸载`);
    } catch (reason) {
      console.error("[KocotreeSkills] Skill 卸载失败", reason);
      Toast.error(
        reason instanceof SkillApiError
          ? reason.message
          : "卸载失败，请稍后重试",
      );
      await refreshLocalSkills();
    } finally {
      setUninstallingSkillId(null);
    }
  }

  function handleUploadVersion(skill: SkillSummaryDto): void {
    requireAuth(() => {
      console.info("[KocotreeSkills] 进入新版本上传流程", { skillId: skill.id });
      setSelectedSkill(null);
      setUploadTargetSkill(skill);
      setUploadSessionKey((current) => current + 1);
      setActivePage("upload");
    });
  }

  function handlePublished(skill: SkillSummaryDto): void {
    setBrowseRefreshKey((current) => current + 1);
    setUploadTargetSkill(null);
    setUploadSessionKey((current) => current + 1);
    setActivePage("browse");
    setSelectedSkillContext("browse");
    setSelectedSkill(skill);
    Toast.success(`${skill.displayName} v${skill.currentVersion.version} 发布成功`);
  }

  const handleUnreadChange = useCallback((count: number) => {
    setUnreadCount(count);
  }, []);

  const handleBrowseHighlightComplete = useCallback(() => {
    setHighlightedBrowseSkillId(null);
  }, []);

  const handleOpenNotificationSkill = useCallback((skillId: string) => {
    skillApi.getSkill(skillId).then((skill) => {
      setActivePage("browse");
      setSelectedSkillContext("browse");
      setSelectedSkill(skill);
    }).catch((reason: unknown) => {
      console.error("[KocotreeSkills] 通知关联 Skill 加载失败", reason);
      Toast.error("关联的 Skill 当前不可查看");
    });
  }, []);

  const localFilter = localFilterForPage(activePage);
  const localSkillGroups = groupLocalSkills(localSkills);
  const uninstallableSkillIds = new Set(
    getUninstallableSkillRecords(localSkills).keys(),
  );
  const localSkillCounts = {
    all: filterWorkspaceSkillGroups(localSkillGroups).length,
    claude: countActiveLocalSkills(localSkillGroups, "claude"),
    codex: countActiveLocalSkills(localSkillGroups, "codex"),
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img
            className="brand-symbol"
            src="/kocotree-logo.svg"
            alt=""
            width={40}
            height={40}
          />
          <strong>Kocotree 技能广场</strong>
        </div>

        <nav className="sidebar-nav" aria-label="主导航">
          <button
            className={activePage === "browse" ? "active" : ""}
            type="button"
            aria-label="Skill 浏览"
            title="Skill 浏览"
            onClick={() => setActivePage("browse")}
          >
            <AppIcon name="browse" size={20} />
            <span>Skill 浏览</span>
          </button>
          <button
            className={activePage === "upload" ? "active" : ""}
            type="button"
            aria-label="上传 Skill"
            title="上传 Skill"
            onClick={() => requireAuth(() => {
              if (uploadTargetSkill) {
                setUploadTargetSkill(null);
                setUploadSessionKey((current) => current + 1);
              }
              setActivePage("upload");
            })}
          >
            <AppIcon name="upload" size={20} />
            <span>上传 Skill</span>
          </button>
          <button
            className={activePage === "published" ? "active" : ""}
            type="button"
            aria-label="我发布的 Skill"
            title="我发布的 Skill"
            onClick={() => setActivePage("published")}
          >
            <AppIcon name="library" size={20} />
            <span>我发布的 Skill</span>
          </button>
        </nav>

        <section className="sidebar-local-section" aria-labelledby="local-skill-navigation">
          <div className="sidebar-section-heading">
            <span id="local-skill-navigation">本地 Skill 管理</span>
            {localSkillsLoading && <span className="sidebar-scan-dot" aria-label="正在扫描" />}
          </div>
          <nav className="sidebar-nav sidebar-local-nav" aria-label="本地 Skill 管理">
            <button
              className={`local-nav-parent ${activePage === "local-all" ? "active" : ""}`}
              type="button"
              aria-label={`全部 Agents，${localSkillCounts.all} 个 Skill`}
              title="全部 Agents"
              onClick={() => setActivePage("local-all")}
            >
              <i className="local-nav-icon local-nav-icon-agents">
                <AppIcon name="agents" size={16} />
              </i>
              <span className="sidebar-nav-label">全部 Agents</span>
              <span className="local-nav-count">{localSkillCounts.all}</span>
            </button>
            <button
              className={`local-nav-child ${activePage === "local-claude" ? "active" : ""}`}
              type="button"
              aria-label={`Claude Code，${localSkillCounts.claude} 个 Skill`}
              title="Claude Code"
              onClick={() => setActivePage("local-claude")}
            >
              <i className="local-nav-icon local-nav-icon-claude">
                <AppIcon name="claude" size={15} />
              </i>
              <span className="sidebar-nav-label">Claude Code</span>
              <span className="local-nav-count">{localSkillCounts.claude}</span>
            </button>
            <button
              className={`local-nav-child ${activePage === "local-codex" ? "active" : ""}`}
              type="button"
              aria-label={`Codex，${localSkillCounts.codex} 个 Skill`}
              title="Codex"
              onClick={() => setActivePage("local-codex")}
            >
              <i className="local-nav-icon local-nav-icon-codex">
                <AppIcon name="codex" size={15} />
              </i>
              <span className="sidebar-nav-label">Codex</span>
              <span className="local-nav-count">{localSkillCounts.codex}</span>
            </button>
          </nav>
        </section>

        <div className="sidebar-user-area" ref={sidebarUserAreaRef}>
          {currentUser ? (
            <Dropdown
              contentClassName="sidebar-user-dropdown"
              getPopupContainer={() => sidebarUserAreaRef.current ?? document.body}
              position="top"
              trigger="click"
              render={(
                <div className="sidebar-user-popover">
                  <NotificationPanel onUnreadChange={handleUnreadChange} onOpenSkill={handleOpenNotificationSkill} />
                  <Dropdown.Menu>
                    <Dropdown.Item type="danger" icon={<AppIcon name="logout" size={17} />} onClick={() => void handleSignOut()}>
                      退出登录
                    </Dropdown.Item>
                  </Dropdown.Menu>
                </div>
              )}
            >
              <button className="sidebar-user" type="button" aria-label={`${currentUser.name} 账户菜单`}>
                <span className="user-avatar">{currentUser.name.slice(0, 1)}</span>
                <span>
                  <strong>{currentUser.name}</strong>
                  <small>{currentUser.departmentPath?.join(" ") || "部门信息暂无"}</small>
                </span>
                {unreadCount > 0 && <span className="account-unread-dot" aria-label={`${unreadCount} 条未读通知`} />}
              </button>
            </Dropdown>
          ) : (
            <button className="sidebar-user" type="button" aria-label="登录 Kocotree Skills" title="登录 Kocotree Skills" onClick={() => setLoginVisible(true)}>
              <span className="connection-dot" />
              <span><strong>未登录</strong><small>登录后浏览 Skill</small></span>
            </button>
          )}
        </div>
      </aside>

      <div className="main-area">
        {activePage === "browse" ? (
          <BrowsePage
            authenticated={currentUser !== null}
            authResolved={authResolved}
            installedSkillIds={installedSkillIds}
            uninstallableSkillIds={uninstallableSkillIds}
            installingSkillId={installingSkillId}
            uninstallingSkillId={uninstallingSkillId}
            onLogin={() => setLoginVisible(true)}
            onOpen={handleOpenSkill}
            onInstall={handleInstallLatest}
            onUninstall={prepareUninstall}
            refreshKey={browseRefreshKey}
            highlightedSkillId={highlightedBrowseSkillId}
            onHighlightComplete={handleBrowseHighlightComplete}
          />
        ) : activePage === "published" ? (
          <MySkillsPage
            currentUser={currentUser}
            onLogin={() => setLoginVisible(true)}
            onOpenSkill={handleOpenManagedSkill}
            refreshKey={publishedRefreshKey}
          />
        ) : activePage === "local-all" ? (
          <AllAgentsSkillsPage
            skills={localSkills}
            loading={localSkillsLoading}
            error={localSkillsError}
            onRefresh={() => void refreshLocalSkills()}
            onSetEnabled={setLocalSkillEnabled}
          />
        ) : localFilter ? (
          <LocalSkillsPage
            filter={localFilter}
            skills={localSkills}
            loading={localSkillsLoading}
            error={localSkillsError}
            onRefresh={() => void refreshLocalSkills()}
            onSetEnabled={setLocalSkillEnabled}
          />
        ) : null}
        {currentUser && (
          <div className="upload-page-host" hidden={activePage !== "upload"}>
            <UploadPage
              key={uploadSessionKey}
              targetSkill={uploadTargetSkill}
              currentUser={currentUser}
              onCancel={() => {
                setUploadTargetSkill(null);
                setUploadSessionKey((current) => current + 1);
                setActivePage("browse");
              }}
              onPublished={handlePublished}
              onSwitchToCreate={() => setUploadTargetSkill(null)}
            />
          </div>
        )}
      </div>

      <SkillDetailModal
        skill={selectedSkill}
        context={selectedSkillContext}
        installedSkillIds={installedSkillIds}
        currentUser={currentUser}
        onClose={() => setSelectedSkill(null)}
        onInstall={handleInstallVersion}
        onUploadVersion={handleUploadVersion}
        onOpenDerivedSource={handleOpenDerivedSource}
        onChanged={(skill) => {
          setSelectedSkill(skill);
          setBrowseRefreshKey((current) => current + 1);
          setPublishedRefreshKey((current) => current + 1);
        }}
      />

      <InstallConfirmModal
        skill={installPrompt?.skill ?? null}
        version={installPrompt?.version ?? null}
        warnings={installPrompt?.warnings ?? []}
        forceRequired={installPrompt?.forceRequired ?? false}
        promptTitle={installPrompt?.promptTitle}
        loading={installing}
        onCancel={() => setInstallPrompt(null)}
        onConfirm={(force) => {
          if (installPrompt) void installSkillVersion(installPrompt.skill, installPrompt.version, force);
        }}
      />

      <InstallFeedbackModal feedback={installFeedback} onClose={() => setInstallFeedback(null)} />

      <UninstallConfirmModal
        skill={uninstallPrompt?.skill ?? null}
        record={uninstallPrompt?.record ?? null}
        loading={uninstallingSkillId !== null}
        onCancel={() => {
          if (uninstallingSkillId === null) setUninstallPrompt(null);
        }}
        onConfirm={() => void uninstallSkill()}
      />

      <Modal
        className="login-modal"
        title="登录 Kocotree Skills"
        visible={loginVisible}
        onCancel={() => { protectedActionRef.current = null; setLoginVisible(false); }}
        footer={null}
        centered
      >
        <div className="login-content">
          <span className="login-mark">飞</span>
          <div><strong>使用飞书继续</strong><p>安装、上传和发布版本时需要记录操作者身份。</p></div>
          <Button theme="solid" type="primary" loading={loginLoading} block onClick={() => void handleSignIn()}>
            打开飞书授权
          </Button>
          <small>将在系统浏览器中打开飞书，授权完成后自动返回应用。</small>
        </div>
      </Modal>
      <ToastViewport />
    </div>
  );
}

export default App;
