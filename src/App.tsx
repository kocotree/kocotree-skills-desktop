import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Dropdown, Modal, Tooltip, Toast, ToastViewport } from "./components/ui";
import {
  skillApi,
  installer,
  localSkillService,
  usesRealInstaller,
  SkillApiError,
  type SkillSummaryDto,
  type SkillVersionDto,
  type TagDto,
  type UserDto,
} from "./api";
import { AppIcon } from "./components/AppIcon";
import { SkillDetailModal } from "./components/SkillDetailModal";
import { UploadPage } from "./components/UploadPage";
import { MySkillsPage } from "./components/MySkillsPage";
import { NotificationPanel } from "./components/NotificationPanel";
import { InstallConfirmModal } from "./components/InstallConfirmModal";
import { InstallFeedbackModal, type InstallFeedbackState } from "./components/InstallFeedbackModal";
import "./App.css";

type PageKey = "browse" | "my-skills" | "upload";
type SortKey = "created" | "updated" | "popular";

interface InstallPromptState {
  skill: SkillSummaryDto;
  version: SkillVersionDto;
  warnings: string[];
  forceRequired: boolean;
  promptTitle?: string;
}

const logoTones = ["dark", "blue", "orange", "violet", "green"] as const;

function getSkillShortCode(skill: SkillSummaryDto): string {
  const words = skill.skillName.split("-").filter(Boolean);
  return words.length > 1
    ? words.slice(0, 2).map((word) => word[0]).join("").toLocaleUpperCase()
    : skill.skillName.slice(0, 2).toLocaleUpperCase();
}

/**
 * 功能说明：渲染单个 Skill 卡片，并通过卡片操作进入详情确认安装。
 * @param skill - 当前卡片展示的技能信息。
 * @param installed - 当前技能是否已安装。
 * @param onOpen - 用户打开详情时调用的回调。
 * @param highlighted - 当前卡片是否作为派生来源被定位高亮。
 * @param cardRef - 高亮卡片的元素引用回调。
 * @returns Skill 卡片的 React 元素。
 */
function SkillCard({
  skill,
  installed,
  onOpen,
  highlighted,
  cardRef,
}: {
  skill: SkillSummaryDto;
  installed: boolean;
  onOpen: (skill: SkillSummaryDto) => void;
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
        <Tooltip className="skill-card-action-tooltip" content={installed ? "已安装，查看详情" : "查看并安装"}>
          <button
            className={installed ? "install-button installed" : "install-button"}
            type="button"
            onClick={(event) => { event.stopPropagation(); onOpen(skill); }}
            aria-label={installed ? `${skill.displayName} 已安装，查看详情` : `查看并安装 ${skill.displayName}`}
          >
            <AppIcon name={installed ? "check" : "plus"} size={17} />
          </button>
        </Tooltip>
      </div>
    </article>
  );
}

/**
 * 功能说明：渲染 Skill 浏览页面，支持排序、搜索、来源筛选和安装状态演示。
 * @param installedSkillIds - 已安装 Skill 的编号集合。
 * @param onOpen - 用户打开 Skill 详情时调用的回调。
 * @param refreshKey - 触发列表重新加载的刷新编号。
 * @param highlightedSkillId - 需要定位并高亮的来源 Skill 编号。
 * @param onHighlightComplete - 来源卡片高亮结束后的回调。
 * @returns Skill 浏览页面的 React 元素。
 */
function BrowsePage({
  installedSkillIds,
  onOpen,
  refreshKey,
  highlightedSkillId,
  onHighlightComplete,
}: {
  installedSkillIds: Set<string>;
  onOpen: (skill: SkillSummaryDto) => void;
  refreshKey: number;
  highlightedSkillId: string | null;
  onHighlightComplete: () => void;
}) {
  const [query, setQuery] = useState("");
  const [tagId, setTagId] = useState("all");
  const [sort, setSort] = useState<SortKey>("updated");
  const [skills, setSkills] = useState<SkillSummaryDto[]>([]);
  const [tags, setTags] = useState<TagDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const highlightedCardRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!highlightedSkillId) return;
    setQuery("");
    setTagId("all");
  }, [highlightedSkillId]);

  useEffect(() => {
    if (!highlightedSkillId || loading || !skills.some((skill) => skill.id === highlightedSkillId)) return;
    highlightedCardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    const timer = window.setTimeout(onHighlightComplete, 2200);
    return () => window.clearTimeout(timer);
  }, [highlightedSkillId, loading, onHighlightComplete, skills]);

  useEffect(() => {
    let active = true;
    skillApi.listTags().then((items) => {
      if (active) setTags(items);
    }).catch((reason: unknown) => {
      console.error("[KocotreeSkills] Tag 加载失败", reason);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      const apiSort = sort === "popular" ? "INSTALLS_DESC" : sort === "created" ? "CREATED_DESC" : "UPDATED_DESC";
      skillApi.listSkills({ query: query || undefined, tagId: tagId === "all" ? undefined : tagId, sort: apiSort })
        .then((result) => {
          if (active) setSkills(result.items);
        })
        .catch((reason: unknown) => {
          if (!active) return;
          console.error("[KocotreeSkills] Skill 列表加载失败", reason);
          setError(reason instanceof SkillApiError ? reason.message : "列表加载失败，请稍后重试");
        })
        .finally(() => { if (active) setLoading(false); });
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, refreshKey, sort, tagId]);

  return (
    <main className="page-content browse-page">
      <header className="page-heading">
        <h1>Skill 浏览</h1>
      </header>

      <section className="filter-panel" aria-label="Skill 筛选条件">
        <div className="filter-first-row">
          <div className="sort-tabs" role="group" aria-label="排序方式">
            <button
              className={sort === "updated" ? "active" : ""}
              type="button"
              aria-pressed={sort === "updated"}
              onClick={() => setSort("updated")}
            >
              <AppIcon name="clock" size={16} />最近更新
            </button>
            <button
              className={sort === "created" ? "active" : ""}
              type="button"
              aria-pressed={sort === "created"}
              onClick={() => setSort("created")}
            >
              <AppIcon name="trend" size={16} />最近创建
            </button>
            <button
              className={sort === "popular" ? "active" : ""}
              type="button"
              aria-pressed={sort === "popular"}
              onClick={() => setSort("popular")}
            >
              <AppIcon name="hot" size={16} />热门
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

        <div className="source-row">
          <span>标签</span>
          <button
            className={tagId === "all" ? "source-chip active" : "source-chip"}
            type="button"
            onClick={() => setTagId("all")}
          >
            全部标签
          </button>
          {tags.map((item) => (
            <button
              className={tagId === item.id ? "source-chip active" : "source-chip"}
              type="button"
              key={item.id}
              onClick={() => setTagId(item.id)}
            >
              {item.name}
            </button>
          ))}
        </div>
      </section>

      {loading ? (
        <section className="empty-state"><span className="loading-dot" /><strong>正在加载 Skill</strong></section>
      ) : error ? (
        <section className="empty-state"><strong>暂时无法加载</strong><span>{error}</span></section>
      ) : skills.length > 0 ? (
        <section className="skill-grid" aria-label="Skill 列表">
          {skills.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              installed={installedSkillIds.has(skill.id)}
              onOpen={onOpen}
              highlighted={skill.id === highlightedSkillId}
              cardRef={skill.id === highlightedSkillId ? (node) => { highlightedCardRef.current = node; } : undefined}
            />
          ))}
        </section>
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
  const [highlightedBrowseSkillId, setHighlightedBrowseSkillId] = useState<string | null>(null);
  const [uploadTargetSkill, setUploadTargetSkill] = useState<SkillSummaryDto | null>(null);
  const [browseRefreshKey, setBrowseRefreshKey] = useState(0);
  const [currentUser, setCurrentUser] = useState<UserDto | null>(null);
  const [loginVisible, setLoginVisible] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const sidebarUserAreaRef = useRef<HTMLDivElement>(null);
  const protectedActionRef = useRef<(() => void) | null>(null);
  const [installedSkillIds, setInstalledSkillIds] = useState(
    () => new Set(usesRealInstaller
      ? []
      : ["0c9c2f8d-3e84-4c0c-8a15-d41d87fd1001", "0c9c2f8d-3e84-4c0c-8a15-d41d87fd1002"]),
  );
  const [installPrompt, setInstallPrompt] = useState<InstallPromptState | null>(null);
  const [installFeedback, setInstallFeedback] = useState<InstallFeedbackState | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    skillApi.getCurrentUser().then(setCurrentUser).catch((reason: unknown) => {
      console.error("[KocotreeSkills] 当前用户状态加载失败", reason);
    });
  }, []);

  useEffect(() => {
    if (usesRealInstaller) return;
    localSkillService.scanSkills().then((items) => {
      setInstalledSkillIds(new Set(items.flatMap((item) => item.skillId ? [item.skillId] : [])));
    }).catch((reason: unknown) => {
      console.error("[KocotreeSkills] 本地安装状态加载失败", reason);
    });
  }, []);

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
    }
  }

  function handleInstallVersion(skill: SkillSummaryDto, version: SkillVersionDto): void {
    requireAuth(() => {
      prepareInstall(skill, version);
    });
  }

  function handleUploadVersion(skill: SkillSummaryDto): void {
    requireAuth(() => {
      console.info("[KocotreeSkills] 进入新版本上传流程", { skillId: skill.id });
      setSelectedSkill(null);
      setUploadTargetSkill(skill);
      setActivePage("upload");
    });
  }

  function handlePublished(skill: SkillSummaryDto): void {
    setBrowseRefreshKey((current) => current + 1);
    setUploadTargetSkill(null);
    setActivePage("browse");
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
      setSelectedSkill(skill);
    }).catch((reason: unknown) => {
      console.error("[KocotreeSkills] 通知关联 Skill 加载失败", reason);
      Toast.error("关联的 Skill 当前不可查看");
    });
  }, []);

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
            onClick={() => requireAuth(() => { setUploadTargetSkill(null); setActivePage("upload"); })}
          >
            <AppIcon name="upload" size={20} />
            <span>上传 Skill</span>
          </button>
          <button
            className={activePage === "my-skills" ? "active" : ""}
            type="button"
            aria-label="我的 Skill"
            title="我的 Skill"
            onClick={() => setActivePage("my-skills")}
          >
            <AppIcon name="library" size={20} />
            <span>我的 Skill</span>
          </button>
        </nav>

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
              <span><strong>未登录</strong><small>浏览无需登录 · 点击登录</small></span>
            </button>
          )}
        </div>
      </aside>

      <div className="main-area">
        {activePage === "browse" ? (
          <BrowsePage
            installedSkillIds={installedSkillIds}
            onOpen={handleOpenSkill}
            refreshKey={browseRefreshKey}
            highlightedSkillId={highlightedBrowseSkillId}
            onHighlightComplete={handleBrowseHighlightComplete}
          />
        ) : activePage === "my-skills" ? (
          <MySkillsPage
            currentUser={currentUser}
            onLogin={() => setLoginVisible(true)}
            onOpenSkill={handleOpenSkill}
          />
        ) : (
          currentUser ? <UploadPage
            targetSkill={uploadTargetSkill}
            currentUser={currentUser}
            onCancel={() => { setUploadTargetSkill(null); setActivePage("browse"); }}
            onPublished={handlePublished}
            onSwitchToCreate={() => setUploadTargetSkill(null)}
          /> : null
        )}
      </div>

      <SkillDetailModal
        skill={selectedSkill}
        installedSkillIds={installedSkillIds}
        currentUser={currentUser}
        onClose={() => setSelectedSkill(null)}
        onInstall={handleInstallVersion}
        onUploadVersion={handleUploadVersion}
        onOpenDerivedSource={handleOpenDerivedSource}
        onChanged={(skill) => {
          setSelectedSkill(skill);
          setBrowseRefreshKey((current) => current + 1);
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
