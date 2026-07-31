import { useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  canControlLocalSkill,
  filterWorkspaceSkillGroups,
  getLocalSkillActivationState,
  getLocalSkillSourceRecord,
  groupLocalSkills,
  SkillApiError,
  usesRealInstaller,
  type LocalSkillActivationState,
  type LocalSkillFilter,
  type LocalSkillGroup,
  type LocalSkillRecord,
  type LocalSkillStatus,
  type SetLocalSkillEnabledInput,
} from "../api";
import { AppIcon } from "./AppIcon";
import { Button, Spin, Toast } from "./ui";

const AGENTS: Array<{
  id: LocalSkillFilter;
  label: string;
  icon: "claude" | "codex";
}> = [
  { id: "claude", label: "Claude Code", icon: "claude" },
  { id: "codex", label: "Codex", icon: "codex" },
];

const STATUS_LABELS: Record<LocalSkillStatus, string> = {
  PLATFORM_INSTALLED: "平台安装",
  PLATFORM_MODIFIED: "本地已修改",
  PLATFORM_MATCHED: "已匹配平台",
  LOCAL_UNKNOWN: "本地 Skill",
  MISSING: "目录缺失",
};

const ACTIVATION_LABELS: Record<LocalSkillActivationState, string> = {
  enabled: "已开启",
  disabled: "已关闭",
  legacy: "旧连接",
  unmanaged: "存在冲突",
};

function activationDescription(
  group: LocalSkillGroup,
  agent: LocalSkillFilter,
  state: LocalSkillActivationState,
  installed: boolean,
): string {
  const label = agent === "claude" ? "Claude Code" : "Codex";
  if (!installed) {
    return `未检测到 ${label}，安装后才能开启 Skill`;
  }
  if (state === "unmanaged") {
    return `${label} 中存在独立安装目录或其他连接，软件不会覆盖它`;
  }
  if (state === "legacy") {
    return "检测到旧版共享目录连接；点击后迁移到私有 Skill 本体";
  }
  if (!canControlLocalSkill(group)) {
    return "该条目不是私有仓库中的实体 Skill，不能通过开关控制";
  }
  return state === "enabled"
    ? `关闭后会从 ${label} 的扫描目录移除入口；已运行会话需新建任务或重启后刷新`
    : `开启后在 ${agent === "claude" ? "用户目录/.claude/skills" : "用户目录/.codex/skills"} 创建生效入口`;
}

async function revealWorkspaceSkill(record: LocalSkillRecord): Promise<void> {
  if (!usesRealInstaller) {
    Toast.info(`Skill 位置：${record.installPath}`);
    return;
  }
  try {
    await revealItemInDir(record.installPath);
  } catch (reason) {
    console.error("[KocotreeSkills] 定位全部 Agents Skill 失败", reason);
    Toast.error("无法在文件管理器中显示 Skill");
  }
}

function installationTimestamp(group: LocalSkillGroup): number {
  const installedAt = getLocalSkillSourceRecord(group)?.installedAt;
  if (!installedAt) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(installedAt);
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

/**
 * 功能说明：以私有仓库为 Skill 本体，并独立控制 Claude/Codex 是否可发现。
 */
export function AllAgentsSkillsPage({
  skills,
  claudeInstalled,
  loading,
  error,
  onRefresh,
  onSetEnabled,
}: {
  skills: LocalSkillRecord[];
  claudeInstalled: boolean;
  loading: boolean;
  error: string;
  onRefresh: () => void;
  onSetEnabled: (input: SetLocalSkillEnabledInput) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [pendingControl, setPendingControl] = useState("");
  const groups = filterWorkspaceSkillGroups(groupLocalSkills(skills)).sort(
    (left, right) =>
      installationTimestamp(right) - installationTimestamp(left)
      || left.primaryRecord.displayName.localeCompare(
        right.primaryRecord.displayName,
        "zh-CN",
      ),
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleGroups = groups.filter((group) => {
    const record = getLocalSkillSourceRecord(group)!;
    return !normalizedQuery
      || record.displayName.toLocaleLowerCase().includes(normalizedQuery)
      || record.skillName.toLocaleLowerCase().includes(normalizedQuery);
  });
  const connectedCounts = {
    claude: groups.filter(
      (group) => getLocalSkillActivationState(group, "claude") === "enabled",
    ).length,
    codex: groups.filter(
      (group) => getLocalSkillActivationState(group, "codex") === "enabled",
    ).length,
  };

  async function toggleSkill(
    group: LocalSkillGroup,
    agent: LocalSkillFilter,
  ): Promise<void> {
    const sourceRecord = getLocalSkillSourceRecord(group);
    const state = getLocalSkillActivationState(group, agent);
    if (
      !sourceRecord
      || !canControlLocalSkill(group)
      || !["enabled", "disabled", "legacy"].includes(state)
    ) {
      return;
    }
    const enabled = state === "disabled" || state === "legacy";
    const controlKey = `${group.id}:${agent}`;
    setPendingControl(controlKey);
    try {
      await onSetEnabled({
        skillName: sourceRecord.skillName,
        sourcePath: sourceRecord.installPath,
        agent,
        enabled,
      });
      const agentLabel = agent === "claude" ? "Claude Code" : "Codex";
      Toast.success(
        state === "legacy"
          ? `${sourceRecord.displayName} 的旧连接已迁移到 ${agentLabel}`
          : enabled
            ? `${sourceRecord.displayName} 已在 ${agentLabel} 开启`
            : `${sourceRecord.displayName} 已在 ${agentLabel} 关闭；已运行会话需新建任务或重启`,
      );
    } catch (reason) {
      console.error("[KocotreeSkills] 更新 Agent Skill 状态失败", reason);
      Toast.error(
        reason instanceof SkillApiError
          ? reason.message
          : "更新 Agent Skill 状态失败",
      );
    } finally {
      setPendingControl("");
    }
  }

  return (
    <main className="page-content local-skills-page agents-workspace-page">
      <header className="page-heading">
        <div>
          <h1>全部 Agents</h1>
          <p>
            Skill 安装后默认关闭；打开下方开关后，即可在 Codex 和 Claude 中使用
          </p>
        </div>
      </header>

      <section className="my-skills-toolbar local-skills-toolbar agents-workspace-toolbar">
        <span>
          共 <strong>{groups.length}</strong> 个 Skill
          <span className="workspace-connection-summary">
            Claude {claudeInstalled ? connectedCounts.claude : "未安装"} · Codex{" "}
            {connectedCounts.codex}
          </span>
        </span>
        <div className="local-skills-toolbar-actions">
          <label className="local-skills-search">
            <AppIcon name="search" size={15} />
            <input
              type="search"
              value={query}
              placeholder="搜索私有 Skill"
              aria-label="搜索全部 Agents Skill"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <Button size="small" loading={loading} onClick={onRefresh}>
            重新扫描
          </Button>
        </div>
      </section>

      {loading ? (
        <section className="empty-state">
          <Spin />
          <strong>正在扫描私有 Skill 仓库</strong>
        </section>
      ) : error ? (
        <section className="empty-state">
          <strong>暂时无法读取私有 Skill 仓库</strong>
          <span>{error}</span>
          <Button size="small" onClick={onRefresh}>
            重试
          </Button>
        </section>
      ) : (
        <>
          <section className="my-skills-list local-skills-list agents-workspace-list">
          {visibleGroups.map((group) => {
            const record = getLocalSkillSourceRecord(group)!;
            return (
              <article className="my-skill-card local workspace-skill-card" key={group.id}>
                <button
                  className="my-skill-card-open"
                  type="button"
                  onClick={() => void revealWorkspaceSkill(record)}
                >
                  <span className="my-skill-card-heading">
                    <span className="agent-skill-logo agent-skill-logo-agents">
                      <AppIcon name="agents" size={19} />
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

                <div className="skill-agent-controls workspace-agent-controls">
                  {AGENTS.map((agent) => {
                    const state = getLocalSkillActivationState(group, agent.id);
                    const installed =
                      agent.id !== "claude" || claudeInstalled;
                    const controlKey = `${group.id}:${agent.id}`;
                    const pending = pendingControl === controlKey;
                    const interactive = installed
                      && canControlLocalSkill(group)
                      && ["enabled", "disabled", "legacy"].includes(state);
                    return (
                      <div
                        className={`skill-agent-control skill-agent-control-${agent.id}${installed ? "" : " agent-not-installed"}`}
                        title={activationDescription(
                          group,
                          agent.id,
                          state,
                          installed,
                        )}
                        key={agent.id}
                      >
                        <span className="skill-agent-name">
                          <AppIcon name={agent.icon} size={14} />
                          {agent.label}
                          {!installed && (
                            <span className="agent-installation-badge">
                              未安装
                            </span>
                          )}
                        </span>
                        <button
                          className={`skill-agent-toggle state-${state}`}
                          type="button"
                          role="switch"
                          aria-checked={state === "enabled"}
                          aria-label={`${record.displayName} ${agent.label}：${ACTIVATION_LABELS[state]}`}
                          disabled={!interactive || Boolean(pendingControl)}
                          onClick={() => void toggleSkill(group, agent.id)}
                        >
                          <span className="skill-agent-toggle-track">
                            <span className="skill-agent-toggle-knob" />
                          </span>
                          <span className="skill-agent-state">
                            {pending
                              ? "处理中"
                              : installed
                                ? ACTIVATION_LABELS[state]
                                : "未安装"}
                          </span>
                        </button>
                      </div>
                    );
                  })}
                </div>

                <div className="my-skill-card-footer">
                  <div className="my-skill-statuses">
                    <span className="agent-source agent-source-agents">
                      私有仓库/.skills-manager/skills
                    </span>
                    <span
                      className={`local-status local-status-${record.status.toLocaleLowerCase()}`}
                    >
                      {record.entryKind !== "DIRECTORY"
                        ? "受管入口"
                        : STATUS_LABELS[record.status]}
                    </span>
                    {record.version && (
                      <span className="my-skill-version">v{record.version}</span>
                    )}
                  </div>
                  <Button
                    size="small"
                    onClick={() => void revealWorkspaceSkill(record)}
                  >
                    打开 Skill 位置
                  </Button>
                </div>
              </article>
            );
          })}
          {visibleGroups.length === 0 && (
            <div className="empty-state my-skills-empty">
              <strong>
                {normalizedQuery
                  ? "没有匹配的私有 Skill"
                  : "私有 Skill 仓库还是空的"}
              </strong>
              <span>
                {normalizedQuery
                  ? "换一个名称继续搜索"
                  : "从技能市场安装 Skill 后，可在这里分别开启 Claude Code 或 Codex"}
              </span>
            </div>
          )}
          </section>
        </>
      )}
    </main>
  );
}
