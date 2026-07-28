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
  enabled: "已连接",
  disabled: "未连接",
  unmanaged: "存在冲突",
};

function activationDescription(
  group: LocalSkillGroup,
  agent: LocalSkillFilter,
  state: LocalSkillActivationState,
): string {
  const label = agent === "claude" ? "Claude Code" : "Codex";
  if (state === "unmanaged") {
    return `${label} 中存在独立安装目录或其他连接，软件不会覆盖它`;
  }
  if (!canControlLocalSkill(group)) {
    return "该工作区条目不是实体目录，不能作为 Agent 连接的本体";
  }
  return state === "enabled"
    ? `关闭后只移除 ${label} 的连接，不会删除用户目录/.agents/skills 中的本体`
    : `开启后在 ${agent === "claude" ? "用户目录/.claude/skills" : "用户目录/.codex/skills"} 创建受管连接`;
}

async function revealWorkspaceSkill(record: LocalSkillRecord): Promise<void> {
  if (!usesRealInstaller) {
    Toast.info(`Skill 本体：${record.installPath}`);
    return;
  }
  try {
    await revealItemInDir(record.installPath);
  } catch (reason) {
    console.error("[KocotreeSkills] 定位全部 Agents Skill 失败", reason);
    Toast.error("无法在文件管理器中显示 Skill");
  }
}

/**
 * 功能说明：以用户目录/.agents/skills 为本体工作区，并集中控制 Claude/Codex 连接。
 */
export function AllAgentsSkillsPage({
  skills,
  loading,
  error,
  onRefresh,
  onSetEnabled,
}: {
  skills: LocalSkillRecord[];
  loading: boolean;
  error: string;
  onRefresh: () => void;
  onSetEnabled: (input: SetLocalSkillEnabledInput) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [pendingControl, setPendingControl] = useState("");
  const groups = filterWorkspaceSkillGroups(groupLocalSkills(skills));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleGroups = groups.filter((group) => {
    const record = group.workspaceRecord!;
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
      || (state !== "enabled" && state !== "disabled")
    ) {
      return;
    }
    const enabled = state === "disabled";
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
        `${sourceRecord.displayName} 已${enabled ? "连接到" : "断开"} ${agentLabel}`,
      );
    } catch (reason) {
      console.error("[KocotreeSkills] 更新工作区连接失败", reason);
      Toast.error(
        reason instanceof SkillApiError
          ? reason.message
          : "更新连接失败",
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
            用户目录/.agents/skills 是 Skill 本体工作区；在这里控制 Claude
            Code 与 Codex 的连接
          </p>
        </div>
      </header>

      <section className="my-skills-toolbar local-skills-toolbar agents-workspace-toolbar">
        <span>
          共 <strong>{groups.length}</strong> 个 Skill
          <span className="workspace-connection-summary">
            Claude {connectedCounts.claude} · Codex {connectedCounts.codex}
          </span>
        </span>
        <div className="local-skills-toolbar-actions">
          <label className="agents-workspace-search">
            <AppIcon name="search" size={15} />
            <input
              type="search"
              value={query}
              placeholder="搜索工作区 Skill"
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
          <strong>正在扫描全部 Agents 工作区</strong>
        </section>
      ) : error ? (
        <section className="empty-state">
          <strong>暂时无法读取全部 Agents 工作区</strong>
          <span>{error}</span>
          <Button size="small" onClick={onRefresh}>
            重试
          </Button>
        </section>
      ) : (
        <section className="my-skills-list local-skills-list agents-workspace-list">
          {visibleGroups.map((group) => {
            const record = group.workspaceRecord!;
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
                    const controlKey = `${group.id}:${agent.id}`;
                    const pending = pendingControl === controlKey;
                    const interactive = canControlLocalSkill(group)
                      && (state === "enabled" || state === "disabled");
                    return (
                      <div
                        className={`skill-agent-control skill-agent-control-${agent.id}`}
                        title={activationDescription(group, agent.id, state)}
                        key={agent.id}
                      >
                        <span className="skill-agent-name">
                          <AppIcon name={agent.icon} size={14} />
                          {agent.label}
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
                            {pending ? "处理中" : ACTIVATION_LABELS[state]}
                          </span>
                        </button>
                      </div>
                    );
                  })}
                </div>

                <div className="my-skill-card-footer">
                  <div className="my-skill-statuses">
                    <span className="agent-source agent-source-agents">
                      用户目录/.agents/skills
                    </span>
                    <span
                      className={`local-status local-status-${record.status.toLocaleLowerCase()}`}
                    >
                      {record.entryKind !== "DIRECTORY"
                        ? "工作区连接"
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
                    打开本体
                  </Button>
                </div>
              </article>
            );
          })}
          {visibleGroups.length === 0 && (
            <div className="empty-state my-skills-empty">
              <strong>
                {normalizedQuery
                  ? "没有匹配的工作区 Skill"
                  : "全部 Agents 工作区还是空的"}
              </strong>
              <span>
                {normalizedQuery
                  ? "换一个名称继续搜索"
                  : "将 Skill 放入用户目录/.agents/skills 后重新扫描"}
              </span>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
