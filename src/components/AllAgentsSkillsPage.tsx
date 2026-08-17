import { useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  canControlLocalSkill,
  filterWorkspaceSkillGroups,
  getExternalCodexLegacyLink,
  getLocalSkillActivationSourceRecord,
  getLocalSkillActivationState,
  getLocalSkillGroupRecords,
  getLocalSkillLocation,
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
import { CloudSyncButton } from "./CloudSyncButton";
import { Button, Spin, Toast } from "./ui";

const AGENTS: Array<{
  id: LocalSkillFilter;
  label: string;
  icon: "claude" | "codex";
}> = [
  { id: "claude", label: "Claude Code", icon: "claude" },
  { id: "codex", label: "Codex", icon: "codex" },
];

type AgentStatusFilter = "all" | LocalSkillFilter;

const STATUS_LABELS: Record<LocalSkillStatus, string> = {
  PLATFORM_INSTALLED: "平台安装",
  PLATFORM_MODIFIED: "本地已修改",
  PLATFORM_MATCHED: "本地 Skill",
  LOCAL_UNKNOWN: "本地 Skill",
  MISSING: "目录缺失",
};

const ACTIVATION_LABELS: Record<LocalSkillActivationState, string> = {
  enabled: "已开启",
  disabled: "已关闭",
  legacy: "旧连接",
  unmanaged: "不可控制",
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
    return "检测到旧版共享连接；点击后切换为管理器维护的入口";
  }
  if (group.externalRecord && !getLocalSkillSourceRecord(group)) {
    return state === "enabled"
      ? `关闭后只移除 ${label} 的生效入口，不会修改外部 Skill 本体`
      : `开启后为 ${label} 创建生效入口，不会修改外部 Skill 本体`;
  }
  if (!canControlLocalSkill(group, agent)) {
    return `已在 ${label} 扫描目录中检测到独立安装的 Skill，因此显示为已开启；如需移除请使用右侧“移到回收站”`;
  }
  if (group.workspaceRecord && !group.managerRecord && agent === "codex") {
    const hasLegacyLink = Boolean(getExternalCodexLegacyLink(group));
    return state === "enabled"
      ? hasLegacyLink
        ? "关闭后同时停用 .agents 本体路径和旧 Codex 软连接路径，不移动 Skill 本体"
        : "关闭后通过 Codex 原生配置停用，Skill 本体仍保留在 .agents/skills"
      : hasLegacyLink
        ? "开启后撤销两个路径的受管禁用配置；可单独清理旧软连接"
        : "开启后仅移除由本软件写入的 Codex 禁用配置；新任务或重启后刷新";
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
    console.error("[KocotreeSkills] 定位全部 Skill 失败", reason);
    Toast.error("无法在文件管理器中显示 Skill");
  }
}

function installationTimestamp(group: LocalSkillGroup): number {
  const installedAt = (
    getLocalSkillSourceRecord(group) ?? group.primaryRecord
  ).installedAt;
  if (!installedAt) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(installedAt);
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

/**
 * 功能说明：统一展示管理器 Skill 与外部 Skill，并按来源提供可靠的 Agent 开关。
 */
export function AllAgentsSkillsPage({
  skills,
  claudeInstalled,
  loading,
  error,
  onRefresh,
  onSetEnabled,
  onAdopt,
  deletingRecordId,
  onDelete,
  onDeleteEntry,
  syncingRecordId,
  onSyncToCloud,
}: {
  skills: LocalSkillRecord[];
  claudeInstalled: boolean;
  loading: boolean;
  error: string;
  onRefresh: () => void;
  onSetEnabled: (input: SetLocalSkillEnabledInput) => Promise<void>;
  onAdopt: (record: LocalSkillRecord) => void;
  deletingRecordId: string | null;
  onDelete: (records: LocalSkillRecord[]) => void;
  onDeleteEntry: (record: LocalSkillRecord) => void;
  syncingRecordId: string | null;
  onSyncToCloud: (record: LocalSkillRecord) => void;
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<AgentStatusFilter>("all");
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
    if (
      statusFilter !== "all"
      && getLocalSkillActivationState(group, statusFilter) !== "enabled"
    ) {
      return false;
    }
    const record = getLocalSkillSourceRecord(group) ?? group.primaryRecord;
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
    const sourceRecord = getLocalSkillActivationSourceRecord(group);
    const state = getLocalSkillActivationState(group, agent);
    if (
      !sourceRecord
      || !canControlLocalSkill(group, agent)
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
          <h1>全部 Skill</h1>
          <p>
            查看本机检测到的全部 Skill，并管理它们在 Claude Code 和 Codex 中的启用状态
          </p>
        </div>
      </header>

      <section className="my-skills-toolbar local-skills-toolbar agents-workspace-toolbar">
        <span>
          共 <strong>{groups.length}</strong> 个 Skill
        </span>
        <div className="local-skills-toolbar-actions">
          <div
            className="agent-status-filter-group"
            role="group"
            aria-label="按 Agent 已启用状态筛选"
          >
            <button
              className={`agent-status-filter filter-all${statusFilter === "all" ? " active" : ""}`}
              type="button"
              aria-pressed={statusFilter === "all"}
              onClick={() => setStatusFilter("all")}
            >
              <span>全部</span>
              <strong>{groups.length}</strong>
            </button>
            {AGENTS.map((agent) => (
              <button
                className={`agent-status-filter filter-${agent.id}${statusFilter === agent.id ? " active" : ""}`}
                type="button"
                aria-pressed={statusFilter === agent.id}
                title={agent.id === "claude" && !claudeInstalled
                  ? "未检测到 Claude Code"
                  : `查看 ${agent.label} 已启用的 Skill`}
                onClick={() => setStatusFilter(agent.id)}
                key={agent.id}
              >
                <AppIcon name={agent.icon} size={13} />
                <span>{agent.label} 已启用</span>
                <strong>{connectedCounts[agent.id]}</strong>
              </button>
            ))}
          </div>
          <label className="local-skills-search">
            <AppIcon name="search" size={15} />
            <input
              type="search"
              value={query}
              placeholder="搜索本地 Skill"
              aria-label="搜索全部 Skill"
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
          <strong>正在扫描本地 Skill</strong>
        </section>
      ) : error ? (
        <section className="empty-state">
          <strong>暂时无法读取本地 Skill</strong>
          <span>{error}</span>
          <Button size="small" onClick={onRefresh}>
            重试
          </Button>
        </section>
      ) : (
        <>
          <section className="my-skills-list local-skills-list agents-workspace-list">
          {visibleGroups.map((group) => {
            const record = getLocalSkillSourceRecord(group) ?? group.primaryRecord;
            const description = record.displayDescription
              || record.skillDescription;
            const groupRecords = getLocalSkillGroupRecords(group);
            const legacyCodexLink = getExternalCodexLegacyLink(group);
            const claudeRecord = group.agentRecords.claude;
            const codexRecord = group.agentRecords.codex;
            const adoptableRecord = claudeRecord
              && claudeRecord.entryKind === "DIRECTORY"
              && getLocalSkillLocation(claudeRecord) === "CLAUDE"
              && !canControlLocalSkill(group, "claude")
                ? claudeRecord
                : codexRecord
                  && codexRecord.entryKind === "DIRECTORY"
                  && getLocalSkillLocation(codexRecord) === "CODEX"
                  && !canControlLocalSkill(group, "codex")
                    ? codexRecord
                    : null;
            const deleting = groupRecords.some(
              (item) => item.id === deletingRecordId,
            );
            const cleaningLegacyLink = deletingRecordId === legacyCodexLink?.id;
            const statusLabel = getLocalSkillLocation(record) === "EXTERNAL"
              ? "外部 Skill"
              : legacyCodexLink
              ? "含旧 Codex 连接"
              : record.entryKind !== "DIRECTORY"
              ? record.status === "LOCAL_UNKNOWN"
                ? "本地连接"
                : "受管入口"
              : STATUS_LABELS[record.status];
            return (
              <article className="my-skill-card local compact-local-skill-card workspace-skill-card" key={group.id}>
                <div
                  className={`local-skill-hover-actions${deleting ? " is-visible" : ""}`}
                  role="group"
                  aria-label={`${record.displayName} 文件操作`}
                >
                  {legacyCodexLink && (
                    <Button
                      className="local-skill-icon-action"
                      size="small"
                      type="tertiary"
                      theme="borderless"
                      icon={<AppIcon name="close" size={16} />}
                      tooltip="清理旧 Codex 软连接"
                      aria-label={`清理 ${record.displayName} 的旧 Codex 软连接`}
                      loading={cleaningLegacyLink}
                      disabled={deletingRecordId !== null}
                      onClick={() => onDeleteEntry(legacyCodexLink)}
                    />
                  )}
                  <Button
                    className="local-skill-icon-action"
                    size="small"
                    type="tertiary"
                    theme="borderless"
                    icon={<AppIcon name="folder" size={16} />}
                    tooltip="打开 Skill 位置"
                    aria-label={`打开 ${record.displayName} 的 Skill 位置`}
                    onClick={() => void revealWorkspaceSkill(record)}
                  />
                  {groupRecords.length > 0 && (
                    <Button
                      className="local-skill-icon-action"
                      size="small"
                      type="danger"
                      theme="borderless"
                      icon={<AppIcon name="trash" size={16} />}
                      tooltip="移到回收站"
                      aria-label={`将 ${record.displayName} 移到回收站`}
                      loading={deleting && !cleaningLegacyLink}
                      disabled={deletingRecordId !== null}
                      onClick={() => onDelete(groupRecords)}
                    />
                  )}
                </div>
                <button
                  className="my-skill-card-open"
                  type="button"
                  onClick={() => void revealWorkspaceSkill(record)}
                >
                  <span className="my-skill-card-heading">
                    <span className="my-skill-main">
                      <strong>{record.displayName}</strong>
                      {description && (
                        <small title={description}>
                          {description}
                        </small>
                      )}
                    </span>
                  </span>
                </button>

                <div className="my-skill-card-footer">
                  {(statusLabel || record.version) && (
                    <div className="my-skill-statuses">
                      {statusLabel && (
                        <span
                          className={`local-status local-status-${record.status.toLocaleLowerCase()}`}
                        >
                          {statusLabel}
                        </span>
                      )}
                      {record.version && (
                        <span className="my-skill-version">v{record.version}</span>
                      )}
                    </div>
                  )}
                  <div className="my-skill-card-footer-actions compact-skill-footer-actions">
                    {adoptableRecord && (
                      <Button
                        className="skill-agent-adopt-button"
                        size="small"
                        type="tertiary"
                        tooltip="之后可以随时为 Agent 开启或关闭"
                        disabled={
                          Boolean(pendingControl)
                          || deletingRecordId !== null
                          || syncingRecordId !== null
                        }
                        onClick={() => onAdopt(adoptableRecord)}
                      >
                        设为可管理
                      </Button>
                    )}
                    <div className="skill-agent-controls compact-agent-controls">
                      {AGENTS.map((agent) => {
                        const state = getLocalSkillActivationState(group, agent.id);
                        const installed =
                          agent.id !== "claude" || claudeInstalled;
                        const controlKey = `${group.id}:${agent.id}`;
                        const pending = pendingControl === controlKey;
                        const controlSupported = canControlLocalSkill(
                          group,
                          agent.id,
                        ) && ["enabled", "disabled", "legacy"].includes(state);
                        if (!controlSupported) return null;
                        const interactive = installed;
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
                    <CloudSyncButton
                      record={record}
                      loading={syncingRecordId === record.id}
                      disabled={syncingRecordId !== null}
                      onSync={onSyncToCloud}
                    />
                  </div>
                </div>
              </article>
            );
          })}
          {visibleGroups.length === 0 && (
            <div className="empty-state my-skills-empty">
              <strong>
                {normalizedQuery
                  ? "没有匹配的本地 Skill"
                  : statusFilter === "claude"
                    ? "Claude Code 暂无已启用的 Skill"
                    : statusFilter === "codex"
                      ? "Codex 暂无已启用的 Skill"
                  : "还没有检测到本地 Skill"}
              </strong>
              <span>
                {normalizedQuery
                  ? "换一个名称继续搜索"
                  : statusFilter !== "all"
                    ? "可以返回全部列表，在对应卡片上开启 Skill"
                  : "可以从技能市场安装，也可以手动放入 Claude Code 或 Codex 的 Skills 目录"}
              </span>
            </div>
          )}
          </section>
        </>
      )}
    </main>
  );
}
