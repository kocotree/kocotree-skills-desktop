import type { LocalSkillRecord } from "../api";
import { Button, Modal } from "./ui";

/**
 * 功能说明：确认删除扫描到的本地 Skill 目录或连接。
 */
export function UninstallConfirmModal({
  displayName,
  records,
  completeRemoval,
  loading,
  onCancel,
  onConfirm,
}: {
  displayName: string;
  records: LocalSkillRecord[];
  completeRemoval: boolean;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      className="uninstall-confirm-modal"
      title={`将 ${displayName || "Skill"} 移到回收站？`}
      visible={records.length > 0}
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
            移到回收站
          </Button>
        </div>
      }
    >
      {records.length > 0 && (
        <div className="uninstall-confirm-content">
          <p className="uninstall-confirm-message">
            {completeRemoval
              ? "确认后，将把下列在电脑上检测到的 Skill 文件或连接移到系统回收站（macOS 为废纸篓）。"
              : "确认后，将把下列本地条目移到系统回收站（macOS 为废纸篓）。软连接只移动连接本身，不会影响源目录。"}
            不会删除技能广场中的云端 Skill，之后可以从回收站恢复。
          </p>
          <ul className="uninstall-path-list">
            {records.map((record) => (
              <li key={record.id}>
                <code>{record.installPath}</code>
                <span>
                  {record.entryKind === "DIRECTORY" || record.entryKind === "COPY"
                    ? "目录移到回收站"
                    : "连接移到回收站"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}
