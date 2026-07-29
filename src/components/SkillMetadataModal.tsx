import { useEffect, useState } from "react";
import { Button, Modal, TextArea, Tooltip, Toast } from "./ui";
import { skillApi, SkillApiError, type SkillDetailDto, type TagDto, type UserDto } from "../api";
import { AppIcon } from "./AppIcon";

/**
 * 功能说明：按 Owner 与协作者权限编辑平台展示信息，不创建内容版本。
 * @param skill - 当前编辑的 Skill。
 * @param currentUser - 当前登录用户。
 * @param visible - 是否显示编辑模态框。
 * @param onCancel - 取消编辑回调。
 * @param onUpdated - 保存成功后返回最新 Skill。
 * @returns 平台展示信息编辑模态框。
 */
export function SkillMetadataModal({
  skill,
  currentUser,
  visible,
  onCancel,
  onUpdated,
}: {
  skill: SkillDetailDto | null;
  currentUser: UserDto | null;
  visible: boolean;
  onCancel: () => void;
  onUpdated: (skill: SkillDetailDto) => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [displayDescription, setDisplayDescription] = useState("");
  const [tags, setTags] = useState<TagDto[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [newTagNames, setNewTagNames] = useState("");
  const [newTagVisible, setNewTagVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [needsDuplicateConfirmation, setNeedsDuplicateConfirmation] = useState(false);

  const canEditDisplayName = Boolean(skill && currentUser && (currentUser.role === "ADMIN" || skill.owner.id === currentUser.id));

  useEffect(() => {
    if (!visible || !skill) return;
    setDisplayName(skill.displayName);
    setDisplayDescription(skill.displayDescription);
    setSelectedTagIds(skill.tags.map((tag) => tag.id));
    setNewTagNames("");
    setError("");
    setNeedsDuplicateConfirmation(false);
    skillApi.listTags().then(setTags).catch((reason: unknown) => console.error("[KocotreeSkills] 编辑信息时加载 Tag 失败", reason));
  }, [skill, visible]);

  function toggleTag(tagId: string): void {
    setSelectedTagIds((items) => items.includes(tagId) ? items.filter((id) => id !== tagId) : items.length < 5 ? [...items, tagId] : items);
  }

  async function save(confirmDuplicateDisplayName: boolean): Promise<void> {
    if (!skill) return;
    setSaving(true);
    setError("");
    setNeedsDuplicateConfirmation(false);
    try {
      const updated = await skillApi.updateSkillMetadata(skill.id, {
        displayName: canEditDisplayName ? displayName : undefined,
        displayDescription,
        tagIds: selectedTagIds,
        newTagNames: newTagNames.split(/[,，]/).map((name) => name.trim()).filter(Boolean),
        confirmDuplicateDisplayName,
      });
      onUpdated(updated);
      Toast.success("平台展示信息已更新");
    } catch (reason) {
      console.error("[KocotreeSkills] 平台展示信息更新失败", reason);
      if (reason instanceof SkillApiError && reason.code === "DISPLAY_NAME_CONFIRMATION_REQUIRED") setNeedsDuplicateConfirmation(true);
      setError(reason instanceof SkillApiError ? reason.message : "保存失败，请稍后重试");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      className="metadata-modal"
      title="编辑展示信息"
      visible={visible}
      width={620}
      centered
      onCancel={onCancel}
      footer={<div className="metadata-actions"><Button disabled={saving} onClick={onCancel}>取消</Button><Button theme="solid" type="primary" loading={saving} disabled={!displayDescription.trim() || (canEditDisplayName && !displayName.trim())} onClick={() => void save(false)}>保存</Button></div>}
    >
      <div className="metadata-form">
        {canEditDisplayName && <label><span>展示名称</span><input value={displayName} maxLength={100} onChange={(event) => setDisplayName(event.currentTarget.value)} /></label>}
        <label><span>展示简介</span><TextArea value={displayDescription} maxCount={1000} autosize={{ minRows: 3, maxRows: 6 }} onChange={setDisplayDescription} /></label>
        <fieldset className="tag-field">
          <legend>Tag（最多 5 个）</legend>
          <div>
            {tags.map((tag) => <button className={selectedTagIds.includes(tag.id) ? "source-chip active" : "source-chip"} type="button" key={tag.id} onClick={() => toggleTag(tag.id)}>{tag.name}</button>)}
            {newTagVisible ? (
              <span className="tag-create-editor">
                <input
                  className="tag-create-input"
                  value={newTagNames}
                  autoFocus
                  aria-label="创建新 Tag"
                  onChange={(event) => setNewTagNames(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setNewTagNames("");
                      setNewTagVisible(false);
                    }
                  }}
                  placeholder="多个 Tag 使用逗号分隔"
                />
                <Tooltip content="取消创建新 Tag">
                  <button
                    className="tag-create-cancel-button"
                    type="button"
                    aria-label="取消创建新 Tag"
                    onClick={() => {
                      setNewTagNames("");
                      setNewTagVisible(false);
                    }}
                  >
                    <AppIcon name="close" size={14} />
                  </button>
                </Tooltip>
              </span>
            ) : (
              <Tooltip content="创建新 Tag">
                <button className="tag-create-button" type="button" aria-label="创建新 Tag" onClick={() => setNewTagVisible(true)}><AppIcon name="plus" size={15} /></button>
              </Tooltip>
            )}
          </div>
        </fieldset>
        {error && <div className="form-error">{error}</div>}
        {needsDuplicateConfirmation && <Button size="small" onClick={() => void save(true)}>确认使用同名展示名称</Button>}
      </div>
    </Modal>
  );
}
