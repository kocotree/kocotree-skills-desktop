import type { LocalSkillRecord, SkillSummaryDto } from "../api";
import { Button, Modal } from "./ui";

/**
 * 功能说明：确认删除平台安装的 Skill 本体及其 Claude Code/Codex 受管入口。
 */
export function UninstallConfirmModal({
  skill,
  record,
  loading,
  onCancel,
  onConfirm,
}: {
  skill: SkillSummaryDto | null;
  record: LocalSkillRecord | null;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const skillName = record?.skillName ?? skill?.skillName ?? "";
  const locallyModified = record?.status === "PLATFORM_MODIFIED";

  return (
    <Modal
      className="uninstall-confirm-modal"
      title={`卸载 ${skill?.displayName ?? "Skill"}？`}
      visible={Boolean(skill && record)}
      width={540}
      centered
      maskClosable={!loading}
      closeOnEsc={!loading}
      onCancel={onCancel}
      footer={
        <div className="install-confirm-actions">
          <Button onClick={onCancel} disabled={loading}>取消</Button>
          <Button
            theme="solid"
            type="danger"
            loading={loading}
            onClick={onConfirm}
          >
            确认卸载
          </Button>
        </div>
      }
    >
      {skill && record && (
        <div className="install-confirm-content uninstall-confirm-content">
          <div className="install-target">
            <span className="skill-logo skill-logo-dark">
              {skill.skillName.slice(0, 2).toUpperCase()}
            </span>
            <span>
              <strong>{skill.displayName}</strong>
              <code>{skill.skillName} · 本地安装</code>
            </span>
          </div>

          <div className="uninstall-targets">
            <strong>将从此设备删除：</strong>
            <ul>
              <li><code>{`~/.agents/skills/${skillName}`}</code></li>
              <li><code>{`~/.codex/skills/${skillName}`}</code><span>受管连接或副本</span></li>
              <li><code>{`~/.claude/skills/${skillName}`}</code><span>受管连接或副本</span></li>
              <li><code>{`~/.skills-manager/skills/${skillName}`}</code><span>确认属于旧连接时清理</span></li>
            </ul>
          </div>

          <div className="install-warning danger">
            <p>
              {locallyModified
                ? "检测到本地内容已修改。卸载会永久删除这些修改，且无法恢复。"
                : "卸载会删除本地目录中的全部内容，且无法恢复。"}
            </p>
            <p>平台上已经发布的 Skill 和安装次数不会受到影响。</p>
          </div>
        </div>
      )}
    </Modal>
  );
}
