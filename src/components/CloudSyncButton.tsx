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
  return (
    <Button
      className="cloud-sync-button"
      size="small"
      type="primary"
      theme="light"
      icon={<AppIcon name="upload" size={14} />}
      loading={loading}
      disabled={disabled || unavailable}
      tooltip={
        unavailable
          ? "未找到可上传的 Skill 本体"
          : "同步到云端技能广场"
      }
      aria-label={record ? `上传 ${record.displayName}` : "无法上传"}
      onClick={() => {
        if (record) onSync(record);
      }}
    >
      {loading ? "检查中" : "上传"}
    </Button>
  );
}
