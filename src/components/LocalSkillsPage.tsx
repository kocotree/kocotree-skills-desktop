import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  filterLocalSkills,
  getLocalSkillSource,
  usesRealInstaller,
  type LocalSkillFilter,
  type LocalSkillRecord,
  type LocalSkillSource,
  type LocalSkillStatus,
} from "../api";
import { AppIcon } from "./AppIcon";
import { Button, Spin, Toast } from "./ui";

const SOURCE_DETAILS: Record<
  LocalSkillFilter,
  {
    title: string;
    description: string;
    emptyTitle: string;
    emptyHint: string;
  }
> = {
  all: {
    title: "本地 Skill 管理",
    description: "集中查看本机 Agents、Claude Code 与 Codex 的 Skill",
    emptyTitle: "没有发现本地 Skill",
    emptyHint: "将 Skill 放入 Agents、Claude Code 或 Codex 的 skills 目录后重新扫描",
  },
  claude: {
    title: "Claude Code Skills",
    description: "来自 ~/.claude/skills 的本地 Skill",
    emptyTitle: "没有发现 Claude Code Skill",
    emptyHint: "将 Skill 放入 ~/.claude/skills 后重新扫描",
  },
  codex: {
    title: "Codex Skills",
    description: "来自 ~/.codex/skills 的本地 Skill",
    emptyTitle: "没有发现 Codex Skill",
    emptyHint: "将 Skill 放入 ~/.codex/skills 后重新扫描",
  },
};

const SOURCE_LABELS: Record<LocalSkillSource, string> = {
  agents: "通用 Agents",
  claude: "Claude Code",
  codex: "Codex",
};

const SOURCE_ICONS: Record<LocalSkillSource, "agents" | "claude" | "codex"> = {
  agents: "agents",
  claude: "claude",
  codex: "codex",
};

const STATUS_LABELS: Record<LocalSkillStatus, string> = {
  PLATFORM_INSTALLED: "平台安装",
  PLATFORM_MODIFIED: "本地已修改",
  PLATFORM_MATCHED: "已匹配平台",
  LOCAL_UNKNOWN: "本地 Skill",
  MISSING: "目录缺失",
};

async function revealLocalSkill(record: LocalSkillRecord): Promise<void> {
  if (!usesRealInstaller) {
    Toast.info(`本地目录：${record.installPath}`);
    return;
  }
  try {
    await revealItemInDir(record.installPath);
  } catch (reason) {
    console.error("[KocotreeSkills] 定位本地 Skill 目录失败", reason);
    Toast.error("无法在文件管理器中显示本地 Skill");
  }
}

/**
 * 功能说明：按 Agent 来源浏览本机 Skill，并提供目录定位入口。
 */
export function LocalSkillsPage({
  filter,
  skills,
  loading,
  error,
  onRefresh,
}: {
  filter: LocalSkillFilter;
  skills: LocalSkillRecord[];
  loading: boolean;
  error: string;
  onRefresh: () => void;
}) {
  const visibleSkills = filterLocalSkills(skills, filter);
  const details = SOURCE_DETAILS[filter];

  return (
    <main className="page-content local-skills-page">
      <header className="page-heading">
        <div>
          <h1>{details.title}</h1>
          <p>{details.description}</p>
        </div>
      </header>

      <section className="my-skills-toolbar local-skills-toolbar">
        <span>
          共 <strong>{visibleSkills.length}</strong> 个 Skill
        </span>
        <Button size="small" loading={loading} onClick={onRefresh}>
          重新扫描
        </Button>
      </section>

      {loading ? (
        <section className="empty-state">
          <Spin />
          <strong>正在扫描本地 Skill</strong>
        </section>
      ) : error ? (
        <section className="empty-state">
          <strong>暂时无法扫描本地 Skill</strong>
          <span>{error}</span>
          <Button size="small" onClick={onRefresh}>
            重试
          </Button>
        </section>
      ) : (
        <section className="my-skills-list">
          {visibleSkills.map((record) => {
            const source = getLocalSkillSource(record);
            return (
              <article className="my-skill-card local" key={record.id}>
                <button
                  className="my-skill-card-open"
                  type="button"
                  onClick={() => void revealLocalSkill(record)}
                >
                  <span className="my-skill-card-heading">
                    <span className={`agent-skill-logo agent-skill-logo-${source}`}>
                      <AppIcon name={SOURCE_ICONS[source]} size={18} />
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
                    <span className={`agent-source agent-source-${source}`}>
                      {SOURCE_LABELS[source]}
                    </span>
                    <span
                      className={`local-status local-status-${record.status.toLocaleLowerCase()}`}
                    >
                      {STATUS_LABELS[record.status]}
                    </span>
                    {record.version && (
                      <span className="my-skill-version">
                        v{record.version}
                      </span>
                    )}
                  </div>
                  <Button
                    size="small"
                    onClick={() => void revealLocalSkill(record)}
                  >
                    在目录中显示
                  </Button>
                </div>
              </article>
            );
          })}
          {visibleSkills.length === 0 && (
            <div className="empty-state my-skills-empty">
              <strong>{details.emptyTitle}</strong>
              <span>{details.emptyHint}</span>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
