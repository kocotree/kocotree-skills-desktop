import type { LocalSkillRecord } from "../api";
import { AppIcon } from "./AppIcon";
import { Button } from "./ui";

/** 三个本地管理页面共用的云端同步入口。 */
export function CloudSyncButton({
  record,
  loading,
  disabled = false,
  onSync,
}: {
  record: LocalSkillRecord | null;
  loading: boolean;
  disabled?: boolean;
  onSync: (record: LocalSkillRecord) => void;
}) {
  const unavailable = !record;
  const updatesExistingSkill = Boolean(record?.skillId);
  const actionLabel = updatesExistingSkill ? "更新云端 Skill" : "上传云端 Skill";
  return (
    <Button
      className="cloud-sync-button"
      size="small"
      type="primary"
      theme="light"
      icon={<AppIcon name={updatesExistingSkill ? "update" : "upload"} size={15} />}
      loading={loading}
      disabled={disabled || unavailable}
      tooltip={
        unavailable
          ? "未找到可同步的 Skill 本体"
          : actionLabel
      }
      aria-label={record ? `${actionLabel}：${record.displayName}` : "无法同步云端 Skill"}
      onClick={() => {
        if (record) onSync(record);
      }}
    />
  );
}
