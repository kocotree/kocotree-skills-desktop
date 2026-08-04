import { useEffect, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  canControlLocalSkill,
  filterLocalSkillGroups,
  getExternalCodexLegacyLink,
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
import { CloudSyncButton } from "./CloudSyncButton";
import { Button, Modal, Spin, Toast } from "./ui";

const SOURCE_DETAILS: Record<
  LocalSkillFilter,
  {
    title: string;
    description: string;
    emptyTitle: string;
    emptyHint: string;
  }
> = {
  claude: {
    title: "Claude Code Skills",
    description: "读取用户目录/.claude/skills；关闭后会删除生效入口和对应卡片",
    emptyTitle: "Claude Code 还没有管理 Skill",
    emptyHint: "点击“添加 Skill”从私有 Skill 仓库中选择",
  },
  codex: {
    title: "Codex Skills",
    description: "读取 Codex Skill；外部 Skill 通过 Codex 原生配置启停，不移动本体",
    emptyTitle: "Codex 还没有管理 Skill",
    emptyHint: "点击“添加 Skill”从私有 Skill 仓库中选择",
  },
};

const AGENT_DETAILS: Record<
  LocalSkillFilter,
  {
    label: string;
    icon: "claude" | "codex";
  }
> = {
  claude: { label: "Claude Code", icon: "claude" },
  codex: { label: "Codex", icon: "codex" },
};

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
): string {
  if (state === "unmanaged") {
    if (group.workspaceRecord && !group.managerRecord) {
      return ".agents/skills 中的外部 Skill 不会被移动；当前 Agent 暂不支持可靠开关";
    }
    return "Skill 是独立安装目录或指向其他位置的链接，为避免数据丢失不能通过开关关闭";
  }
  if (state === "legacy") {
    return "检测到旧版共享连接；点击后切换为管理器维护的入口";
  }
  if (!canControlLocalSkill(group, agent)) {
    return `已在 ${AGENT_DETAILS[agent].label} 扫描目录中检测到独立安装的 Skill，因此显示为已开启；如需移除请使用右侧“移到回收站”`;
  }
  if (group.workspaceRecord && !group.managerRecord && agent === "codex") {
    const hasLegacyLink = Boolean(getExternalCodexLegacyLink(group));
    return state === "enabled"
      ? hasLegacyLink
        ? "关闭后同时停用 .agents 本体路径和旧 Codex 软连接路径，不移动 Skill 本体"
        : "关闭后通过 Codex 原生配置停用，Skill 本体仍保留在 .agents/skills"
      : hasLegacyLink
        ? "开启后撤销两个路径的受管禁用配置；右侧按钮可单独清理旧软连接"
        : "开启后移除本软件写入的 Codex 禁用配置；新任务或重启后刷新";
  }
  return state === "enabled"
    ? `关闭后会移除扫描入口；已运行的 ${AGENT_DETAILS[agent].label} 会话需新建任务或重启后刷新`
    : `开启后将为 ${AGENT_DETAILS[agent].label} 创建生效入口`;
}

async function revealLocalSkill(record: LocalSkillRecord): Promise<void> {
  if (!usesRealInstaller) {
    Toast.info(`Skill 位置：${record.installPath}`);
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
 * 功能说明：展示指定 Agent 的本地 Skill，并从私有仓库创建生效入口。
 */
export function LocalSkillsPage({
  filter,
  skills,
  agentInstalled,
  loading,
  error,
  onRefresh,
  onSetEnabled,
  deletingRecordId,
  onDelete,
  syncingRecordId,
  onSyncToCloud,
}: {
  filter: LocalSkillFilter;
  skills: LocalSkillRecord[];
  agentInstalled: boolean;
  loading: boolean;
  error: string;
  onRefresh: () => void;
  onSetEnabled: (input: SetLocalSkillEnabledInput) => Promise<void>;
  deletingRecordId: string | null;
  onDelete: (records: LocalSkillRecord[]) => void;
  syncingRecordId: string | null;
  onSyncToCloud: (record: LocalSkillRecord) => void;
}) {
  const [pendingControl, setPendingControl] = useState("");
  const [query, setQuery] = useState("");
  const [addVisible, setAddVisible] = useState(false);
  const [addQuery, setAddQuery] = useState("");
  const groups = groupLocalSkills(skills);
  const activeGroups = filterLocalSkillGroups(groups, filter);
  const visibleGroups = filterLocalSkillGroups(groups, filter, query);
  const details = SOURCE_DETAILS[filter];
  const enabledCount = activeGroups.length;
  const occupiedSkillNames = new Set(
    groups.flatMap((group) =>
      getLocalSkillActivationState(group, filter) !== "disabled"
        ? [group.primaryRecord.skillName]
        : [],
    ),
  );
  const normalizedAddQuery = addQuery.trim().toLocaleLowerCase();
  const availableGroups = groups.filter((group) => {
    const record = getLocalSkillSourceRecord(group);
    if (
      !record
      || !canControlLocalSkill(group, filter)
      || occupiedSkillNames.has(record.skillName)
      || getLocalSkillActivationState(group, filter) !== "disabled"
    ) {
      return false;
    }
    return !normalizedAddQuery
      || record.displayName.toLocaleLowerCase().includes(normalizedAddQuery)
      || record.skillName.toLocaleLowerCase().includes(normalizedAddQuery);
  });

  useEffect(() => {
    setQuery("");
  }, [filter]);

  async function toggleSkill(group: LocalSkillGroup): Promise<void> {
    const sourceRecord = getLocalSkillSourceRecord(group);
    const state = getLocalSkillActivationState(group, filter);
    if (
      !sourceRecord
      || !canControlLocalSkill(group, filter)
      || !["enabled", "disabled", "legacy"].includes(state)
    ) {
      return;
    }
    const enabled = state === "disabled" || state === "legacy";
    const controlKey = `${group.id}:${filter}`;
    setPendingControl(controlKey);
    try {
      await onSetEnabled({
        skillName: sourceRecord.skillName,
        sourcePath: sourceRecord.installPath,
        agent: filter,
        enabled,
      });
      Toast.success(
        state === "legacy"
          ? `${AGENT_DETAILS[filter].label} 的旧连接已迁移`
          : enabled
            ? `${AGENT_DETAILS[filter].label} 已开启 ${sourceRecord.displayName}`
            : `${AGENT_DETAILS[filter].label} 已关闭 ${sourceRecord.displayName}；已运行会话需新建任务或重启`,
      );
    } catch (reason) {
      console.error("[KocotreeSkills] 更新本地 Skill 状态失败", reason);
      Toast.error(
        reason instanceof SkillApiError
          ? reason.message
          : "更新本地 Skill 状态失败",
      );
    } finally {
      setPendingControl("");
    }
  }

  function closeAddModal(): void {
    if (pendingControl) return;
    setAddVisible(false);
    setAddQuery("");
  }

  return (
    <main className="page-content local-skills-page">
      <header className="page-heading">
        <div>
          <h1>{details.title}</h1>
          <p>
            {agentInstalled
              ? details.description
              : `未检测到 ${AGENT_DETAILS[filter].label}，安装后才能开启 Skill`}
          </p>
        </div>
      </header>

      <section className="my-skills-toolbar local-skills-toolbar">
        <span>
          共 <strong>{enabledCount}</strong> 个 Skill
        </span>
        <div className="local-skills-toolbar-actions">
          <label className="local-skills-search">
            <AppIcon name="search" size={15} />
            <input
              type="search"
              value={query}
              placeholder={`搜索 ${AGENT_DETAILS[filter].label} Skill`}
              aria-label={`搜索 ${AGENT_DETAILS[filter].label} Skill`}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <Button
            size="small"
            theme="solid"
            type="primary"
            disabled={!agentInstalled}
            onClick={() => setAddVisible(true)}
          >
            添加 Skill
          </Button>
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
          <strong>暂时无法扫描本地 Skill</strong>
          <span>{error}</span>
          <Button size="small" onClick={onRefresh}>
            重试
          </Button>
        </section>
      ) : (
        <>
          <section className="my-skills-list local-skills-list agent-skills-list">
          {visibleGroups.map((group) => {
            const record = group.primaryRecord;
            const state = getLocalSkillActivationState(group, filter);
            const controlKey = `${group.id}:${filter}`;
            const pending = pendingControl === controlKey;
            const legacyCodexLink = getExternalCodexLegacyLink(group);
            const agentRecord = group.agentRecords[filter] ?? record;
            const syncRecord = getLocalSkillSourceRecord(group) ?? agentRecord;
            const deleting = agentRecord.id === deletingRecordId;
            const interactive = agentInstalled
              && canControlLocalSkill(group, filter)
              && ["enabled", "disabled", "legacy"].includes(state);
            const statusLabel = legacyCodexLink && filter === "codex"
              ? "旧 Codex 连接"
              : record.entryKind !== "DIRECTORY"
              ? record.status === "LOCAL_UNKNOWN"
                ? "本地连接"
                : "受管入口"
              : STATUS_LABELS[record.status];
            return (
              <article className="my-skill-card local compact-local-skill-card" key={group.id}>
                <div
                  className={`local-skill-hover-actions${deleting ? " is-visible" : ""}`}
                  role="group"
                  aria-label={`${record.displayName} 文件操作`}
                >
                  <Button
                    className="local-skill-icon-action"
                    size="small"
                    type="tertiary"
                    theme="borderless"
                    icon={<AppIcon name="folder" size={16} />}
                    tooltip={getLocalSkillSourceRecord(group)
                      ? "打开 Skill 位置"
                      : "在目录中显示"}
                    aria-label={`${getLocalSkillSourceRecord(group)
                      ? "打开"
                      : "在目录中显示"} ${record.displayName}`}
                    onClick={() => void revealLocalSkill(record)}
                  />
                  <Button
                    className="local-skill-icon-action"
                    size="small"
                    type="danger"
                    theme="borderless"
                    icon={<AppIcon name="trash" size={16} />}
                    tooltip={legacyCodexLink && agentRecord.id === legacyCodexLink.id
                      ? "清理旧 Codex 软连接"
                      : "移到回收站"}
                    aria-label={legacyCodexLink && agentRecord.id === legacyCodexLink.id
                      ? `清理 ${record.displayName} 的旧 Codex 软连接`
                      : `将 ${record.displayName} 移到回收站`}
                    loading={deleting}
                    disabled={deletingRecordId !== null}
                    onClick={() => onDelete([agentRecord])}
                  />
                </div>
                <button
                  className="my-skill-card-open"
                  type="button"
                  onClick={() => void revealLocalSkill(record)}
                >
                  <span className="my-skill-card-heading">
                    <span className="my-skill-main">
                      <strong>{record.displayName}</strong>
                      <code>{record.skillName}</code>
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
                        <span className="my-skill-version">
                          v{record.version}
                        </span>
                      )}
                    </div>
                  )}
                  <div className="my-skill-card-footer-actions compact-skill-footer-actions">
                    <div className="skill-agent-controls compact-agent-controls">
                      <div
                        className={`skill-agent-control skill-agent-control-${filter}`}
                        title={activationDescription(group, filter, state)}
                      >
                        <span className="skill-agent-name">
                          <AppIcon
                            name={AGENT_DETAILS[filter].icon}
                            size={14}
                          />
                          {AGENT_DETAILS[filter].label}
                        </span>
                        <button
                          className={`skill-agent-toggle state-${state}`}
                          type="button"
                          role="switch"
                          aria-checked={state === "enabled"}
                          aria-label={`${AGENT_DETAILS[filter].label}：${ACTIVATION_LABELS[state]}`}
                          disabled={!interactive || Boolean(pendingControl)}
                          onClick={() => void toggleSkill(group)}
                        >
                          <span className="skill-agent-toggle-track">
                            <span className="skill-agent-toggle-knob" />
                          </span>
                          <span className="skill-agent-state">
                            {pending ? "处理中" : ACTIVATION_LABELS[state]}
                          </span>
                        </button>
                      </div>
                    </div>
                    <CloudSyncButton
                      record={syncRecord}
                      loading={syncingRecordId === syncRecord.id}
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
                {query.trim() ? "没有匹配的 Skill" : details.emptyTitle}
              </strong>
              <span>
                {query.trim() ? "换一个名称继续搜索" : details.emptyHint}
              </span>
              {!query.trim() && agentInstalled && (
                <Button
                  size="small"
                  theme="solid"
                  type="primary"
                  onClick={() => setAddVisible(true)}
                >
                  添加 Skill
                </Button>
              )}
            </div>
          )}
          </section>
        </>
      )}

      <Modal
        className="local-skill-add-modal"
        title={`为 ${AGENT_DETAILS[filter].label} 添加 Skill`}
        visible={addVisible}
        width={620}
        onCancel={closeAddModal}
        maskClosable={!pendingControl}
        closeOnEsc={!pendingControl}
        footer={
          <div className="local-skill-add-footer">
            <span>还有 {availableGroups.length} 个私有 Skill 可开启</span>
            <Button onClick={closeAddModal} disabled={Boolean(pendingControl)}>
              完成
            </Button>
          </div>
        }
      >
        <div className="local-skill-add-content">
          <p>
            开启后会在该 Agent 的扫描目录创建生效入口；关闭后入口会被完全移除，
            Skill 本体仍保留在用户目录/.skills-manager/skills。
          </p>
          <input
            className="local-skill-add-search"
            type="search"
            value={addQuery}
            placeholder="搜索 Skill 名称"
            aria-label="搜索私有 Skill 仓库"
            onChange={(event) => setAddQuery(event.target.value)}
          />
          <div className="local-skill-add-list">
            {availableGroups.map((group) => {
              const record = getLocalSkillSourceRecord(group)!;
              const controlKey = `${group.id}:${filter}`;
              return (
                <article className="local-skill-add-item" key={group.id}>
                  <span>
                    <strong>{record.displayName}</strong>
                    <code>{record.skillName}</code>
                  </span>
                  <Button
                    size="small"
                    theme="solid"
                    type="primary"
                    loading={pendingControl === controlKey}
                    disabled={Boolean(pendingControl)}
                    onClick={() => void toggleSkill(group)}
                  >
                    开启
                  </Button>
                </article>
              );
            })}
            {availableGroups.length === 0 && (
              <div className="local-skill-add-empty">
                <strong>
                  {normalizedAddQuery ? "没有匹配的 Skill" : "没有可添加的 Skill"}
                </strong>
                <span>
                  {normalizedAddQuery
                    ? "换一个名称继续搜索"
                    : "私有仓库中的 Skill 已全部开启或被同名项占用"}
                </span>
              </div>
            )}
          </div>
        </div>
      </Modal>
    </main>
  );
}
