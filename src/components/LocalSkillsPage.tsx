import { useEffect, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  canControlLocalSkill,
  filterLocalSkillGroups,
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
import {
  getLocalSkillPageCount,
  LocalSkillPagination,
  paginateLocalSkills,
} from "./LocalSkillPagination";
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
    description: "读取用户目录/.claude/skills；关闭后会移除受管连接和对应卡片",
    emptyTitle: "Claude Code 还没有管理 Skill",
    emptyHint: "点击“添加 Skill”从全部 Agents 工作区中选择",
  },
  codex: {
    title: "Codex Skills",
    description: "读取用户目录/.codex/skills；关闭后会移除受管连接和对应卡片",
    emptyTitle: "Codex 还没有管理 Skill",
    emptyHint: "点击“添加 Skill”从全部 Agents 工作区中选择",
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
  PLATFORM_MATCHED: "已匹配平台",
  LOCAL_UNKNOWN: "本地 Skill",
  MISSING: "目录缺失",
};

const ACTIVATION_LABELS: Record<LocalSkillActivationState, string> = {
  enabled: "已开启",
  disabled: "已关闭",
  legacy: "旧连接",
  unmanaged: "独立安装",
};

function activationDescription(
  group: LocalSkillGroup,
  agent: LocalSkillFilter,
  state: LocalSkillActivationState,
): string {
  if (state === "unmanaged") {
    return "Skill 是独立安装目录或指向其他位置的链接，为避免数据丢失不能通过开关关闭";
  }
  if (state === "legacy") {
    return `检测到指向旧版兼容仓库的连接；点击后迁移到全部 Agents 工作区本体`;
  }
  if (!canControlLocalSkill(group)) {
    return "该 Skill 不在可控制的全部 Agents 工作区或兼容仓库中";
  }
  return state === "enabled"
    ? `关闭后只移除 ${AGENT_DETAILS[agent].label} 的连接，Skill 本体仍会保留`
    : `开启后将为 ${AGENT_DETAILS[agent].label} 创建受管连接`;
}

function sourceLabels(
  group: LocalSkillGroup,
  agent: LocalSkillFilter,
): string[] {
  if (agent === "claude") {
    return group.agentRecords.claude
      ? ["用户目录/.claude/skills"]
      : ["当前已关闭"];
  }
  return group.agentRecords.codex
    ? ["用户目录/.codex/skills"]
    : ["当前已关闭"];
}

async function revealLocalSkill(record: LocalSkillRecord): Promise<void> {
  if (!usesRealInstaller) {
    Toast.info(`Skill 本体：${record.installPath}`);
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
 * 功能说明：展示指定 Agent 的本地 Skill，并从全部 Agents 工作区添加受管连接。
 */
export function LocalSkillsPage({
  filter,
  skills,
  loading,
  error,
  onRefresh,
  onSetEnabled,
}: {
  filter: LocalSkillFilter;
  skills: LocalSkillRecord[];
  loading: boolean;
  error: string;
  onRefresh: () => void;
  onSetEnabled: (input: SetLocalSkillEnabledInput) => Promise<void>;
}) {
  const [pendingControl, setPendingControl] = useState("");
  const [page, setPage] = useState(1);
  const [addVisible, setAddVisible] = useState(false);
  const [addQuery, setAddQuery] = useState("");
  const groups = groupLocalSkills(skills);
  const visibleGroups = filterLocalSkillGroups(groups, filter);
  const pageCount = getLocalSkillPageCount(visibleGroups.length);
  const paginatedGroups = paginateLocalSkills(visibleGroups, page);
  const details = SOURCE_DETAILS[filter];
  const enabledCount = visibleGroups.filter(
    (group) =>
      getLocalSkillActivationState(group, filter) !== "disabled",
  ).length;
  const occupiedSkillNames = new Set(
    groups.flatMap((group) =>
      getLocalSkillActivationState(group, filter) !== "disabled"
        ? [group.primaryRecord.skillName]
        : [],
    ),
  );
  const normalizedQuery = addQuery.trim().toLocaleLowerCase();
  const availableGroups = groups.filter((group) => {
    const record = getLocalSkillSourceRecord(group);
    if (
      !record
      || !canControlLocalSkill(group)
      || occupiedSkillNames.has(record.skillName)
      || getLocalSkillActivationState(group, filter) !== "disabled"
    ) {
      return false;
    }
    return !normalizedQuery
      || record.displayName.toLocaleLowerCase().includes(normalizedQuery)
      || record.skillName.toLocaleLowerCase().includes(normalizedQuery);
  });

  useEffect(() => {
    setPage(1);
  }, [filter]);

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  async function toggleSkill(group: LocalSkillGroup): Promise<void> {
    const sourceRecord = getLocalSkillSourceRecord(group);
    const state = getLocalSkillActivationState(group, filter);
    if (
      !sourceRecord
      || !canControlLocalSkill(group)
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
          : `${AGENT_DETAILS[filter].label} 已${enabled ? "开启" : "关闭"} ${sourceRecord.displayName}`,
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
          <p>{details.description}</p>
        </div>
      </header>

      <section className="my-skills-toolbar local-skills-toolbar">
        <span>
          共 <strong>{enabledCount}</strong> 个 Skill
        </span>
        <div className="local-skills-toolbar-actions">
          <Button
            size="small"
            theme="solid"
            type="primary"
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
          <section className="my-skills-list local-skills-list">
          {paginatedGroups.map((group) => {
            const record = group.primaryRecord;
            const state = getLocalSkillActivationState(group, filter);
            const controlKey = `${group.id}:${filter}`;
            const pending = pendingControl === controlKey;
            const interactive = canControlLocalSkill(group)
              && ["enabled", "disabled", "legacy"].includes(state);
            return (
              <article className="my-skill-card local" key={group.id}>
                <button
                  className="my-skill-card-open"
                  type="button"
                  onClick={() => void revealLocalSkill(record)}
                >
                  <span className="my-skill-card-heading">
                    <span
                      className={`agent-skill-logo agent-skill-logo-${filter}`}
                    >
                      <AppIcon
                        name={AGENT_DETAILS[filter].icon}
                        size={18}
                      />
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

                <div className="skill-agent-controls">
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

                <div className="my-skill-card-footer">
                  <div className="my-skill-statuses">
                    {sourceLabels(group, filter).map((label) => (
                      <span className="agent-source" key={label}>
                        {label}
                      </span>
                    ))}
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
                    {getLocalSkillSourceRecord(group)
                      ? "打开 Skill 本体"
                      : "在目录中显示"}
                  </Button>
                </div>
              </article>
            );
          })}
          {visibleGroups.length === 0 && (
            <div className="empty-state my-skills-empty">
              <strong>{details.emptyTitle}</strong>
              <span>{details.emptyHint}</span>
              <Button
                size="small"
                theme="solid"
                type="primary"
                onClick={() => setAddVisible(true)}
              >
                添加 Skill
              </Button>
            </div>
          )}
          </section>
          <LocalSkillPagination
            page={page}
            total={visibleGroups.length}
            onChange={setPage}
          />
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
            <span>还有 {availableGroups.length} 个工作区 Skill 可添加</span>
            <Button onClick={closeAddModal} disabled={Boolean(pendingControl)}>
              完成
            </Button>
          </div>
        }
      >
        <div className="local-skill-add-content">
          <p>
            开启后只会创建受管连接，Skill 本体仍保留在
            {" "}用户目录/.agents/skills；旧版统一仓库中的 Skill 也可继续添加。
          </p>
          <input
            className="local-skill-add-search"
            type="search"
            value={addQuery}
            placeholder="搜索 Skill 名称"
            aria-label="搜索全部 Agents 工作区 Skill"
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
                  {normalizedQuery ? "没有匹配的 Skill" : "没有可添加的 Skill"}
                </strong>
                <span>
                  {normalizedQuery
                    ? "换一个名称继续搜索"
                    : "工作区中的 Skill 已全部加入管理"}
                </span>
              </div>
            )}
          </div>
        </div>
      </Modal>
    </main>
  );
}
