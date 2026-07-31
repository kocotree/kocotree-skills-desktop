import { Button, Modal } from "./ui";
import type { SkillSummaryDto, SkillVersionDto } from "../api";

/**
 * 功能说明：集中展示历史版本、派生关系和本地同名冲突的安装确认。
 * @param skill - 准备安装的 Skill。
 * @param version - 准备安装的版本。
 * @param warnings - 用户确认前必须看到的风险说明。
 * @param forceRequired - 是否必须使用强制替换操作。
 * @param promptTitle - 当前异常类型对应的确认标题。
 * @param loading - 当前安装操作是否正在执行。
 * @param onCancel - 取消安装的回调。
 * @param onConfirm - 确认安装的回调，参数表示是否强制替换。
 * @returns 安装确认模态框。
 */
export function InstallConfirmModal({
  skill,
  version,
  warnings,
  forceRequired,
  promptTitle,
  loading,
  onCancel,
  onConfirm,
}: {
  skill: SkillSummaryDto | null;
  version: SkillVersionDto | null;
  warnings: string[];
  forceRequired: boolean;
  promptTitle?: string;
  loading: boolean;
  onCancel: () => void;
  onConfirm: (force: boolean) => void;
}) {
  return (
    <Modal
      className="install-confirm-modal"
      title={promptTitle ?? (forceRequired ? "发现本地同名 Skill" : "确认安装")}
      visible={Boolean(skill && version)}
      width={520}
      centered
      onCancel={onCancel}
      footer={
        <div className="install-confirm-actions">
          <Button onClick={onCancel} disabled={loading}>取消</Button>
          <Button theme="solid" type={forceRequired ? "danger" : "primary"} loading={loading} onClick={() => onConfirm(forceRequired)}>
            {forceRequired ? "覆盖并安装" : "继续安装"}
          </Button>
        </div>
      }
    >
      {skill && version && (
        <div className="install-confirm-content">
          <div className="install-target">
            <strong>{skill.displayName}</strong>
            <code>{skill.skillName} · v{version.version}</code>
          </div>
          <div className={forceRequired ? "install-warning danger" : "install-warning"}>
            {warnings.map((warning) => <p key={warning}>{warning}</p>)}
          </div>
          {forceRequired && <small>覆盖前会备份当前目录；如果新版本写入失败，软件会自动恢复原 Skill。</small>}
        </div>
      )}
    </Modal>
  );
}
