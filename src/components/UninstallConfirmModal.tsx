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
  return (
    <Modal
      className="uninstall-confirm-modal"
      title={`卸载 ${skill?.displayName ?? "Skill"}？`}
      visible={Boolean(skill && record)}
      width={680}
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
        <p className="uninstall-confirm-message">
          确认后，将从 Claude Code 文件夹或 Codex 文件夹中移除此 Skill，但不会删除云端的 Skill。
        </p>
      )}
    </Modal>
  );
}
