import { useEffect, useState, type FormEvent } from "react";
import { Button, Tooltip } from "./ui";
import {
  parseSkillPackage,
  skillApi,
  SkillApiError,
  type SkillDetailDto,
  type SkillSummaryDto,
  type SkillPackageInspection,
  type TagDto,
  type UserDto,
} from "../api";
import { AppIcon } from "./AppIcon";

interface UploadPageProps {
  targetSkill: SkillSummaryDto | null;
  currentUser: UserDto;
  onCancel: () => void;
  onPublished: (skill: SkillDetailDto) => void;
  onSwitchToCreate: () => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function nextPatchVersion(version: string): string {
  const [major = "1", minor = "0", patch = "0"] = version.split(/[+-]/)[0].split(".");
  return `${major}.${minor}.${Number(patch) + 1}`;
}

/**
 * 功能说明：在本地解析 ZIP，并在用户确认后一次性创建 Skill 或发布指定 Skill 新版本。
 * @param targetSkill - 从详情页进入时绑定的目标 Skill，新建流程为 null。
 * @param currentUser - 当前已登录的发布用户。
 * @param onCancel - 取消发布并返回浏览页的回调。
 * @param onPublished - 发布成功后接收最新 Skill 详情的回调。
 * @param onSwitchToCreate - 名称不匹配时切换为新建 Skill 的回调。
 * @returns Skill 上传与发布页面。
 */
export function UploadPage({
  targetSkill,
  currentUser,
  onCancel,
  onPublished,
  onSwitchToCreate,
}: UploadPageProps) {
  const [fileName, setFileName] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<SkillPackageInspection | null>(null);
  const [availableTags, setAvailableTags] = useState<TagDto[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [newTagNames, setNewTagNames] = useState("");
  const [newTagInputVisible, setNewTagInputVisible] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [displayDescription, setDisplayDescription] = useState("");
  const [version, setVersion] = useState(targetSkill ? nextPatchVersion(targetSkill.currentVersion.version) : "1.0.0");
  const [changelog, setChangelog] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState("");
  const [forkSource, setForkSource] = useState<SkillSummaryDto | null>(null);
  const [duplicateConflicts, setDuplicateConflicts] = useState<Array<{ id: string; displayName: string; skillName: string }>>([]);

  useEffect(() => {
    skillApi.listTags().then(setAvailableTags).catch((reason: unknown) => {
      console.error("[KocotreeSkills] 上传页 Tag 加载失败", reason);
    });
  }, []);

  useEffect(() => {
    setVersion(targetSkill ? nextPatchVersion(targetSkill.currentVersion.version) : "1.0.0");
    setChangelog(targetSkill ? "" : "首次发布");
    setError("");
    setDuplicateConflicts([]);
    if (targetSkill) {
      setDisplayName(targetSkill.displayName);
      setDisplayDescription(targetSkill.displayDescription);
      setSelectedTagIds(targetSkill.tags.map((tag) => tag.id));
    }
    if (!targetSkill && inspection) {
      setDisplayName(inspection.skillName);
      setDisplayDescription(inspection.skillDescription);
    }
  }, [inspection, targetSkill]);

  /**
   * 功能说明：选择 ZIP 后立即在客户端本地解析，并将只读包信息保存在当前页面状态中。
   * @param file - 用户选择的 ZIP 文件。
   * @returns 无返回值。
   */
  async function inspectFile(file: File): Promise<void> {
    setFileName(file.name);
    setSelectedFile(null);
    setInspection(null);
    setError("");
    setInspecting(true);
    console.info("[KocotreeSkills] 开始解析 Skill ZIP", { fileName: file.name, size: file.size });
    try {
      const { inspection: result, uploadFile } = await parseSkillPackage(file);
      setSelectedFile(uploadFile);
      setInspection(result);
      if (!targetSkill) {
        setDisplayName(result.skillName);
        setDisplayDescription(result.skillDescription);
      }
      console.info("[KocotreeSkills] Skill ZIP 解析完成", {
        skillName: result.skillName,
      });
    } catch (reason) {
      console.error("[KocotreeSkills] Skill ZIP 解析失败", reason);
      setError(reason instanceof SkillApiError ? reason.message : "ZIP 解析失败，请重新选择文件");
    } finally {
      setInspecting(false);
    }
  }

  function toggleTag(tagId: string): void {
    setSelectedTagIds((current) => {
      if (current.includes(tagId)) return current.filter((id) => id !== tagId);
      if (current.length >= 5) {
        setError("每个 Skill 最多选择或创建 5 个 Tag");
        return current;
      }
      setError("");
      return [...current, tagId];
    });
  }

  /**
   * 功能说明：根据当前模式提交创建请求或新版本发布请求。
   * @param event - React 表单提交事件。
   * @returns 无返回值。
   */
  async function publish(confirmDuplicateDisplayName: boolean): Promise<void> {
    if (!inspection || !selectedFile) {
      setError("请先选择并成功解析一个 ZIP");
      return;
    }
    setPublishing(true);
    setError("");
    setDuplicateConflicts([]);
    try {
      let result: SkillDetailDto;
      if (targetSkill) {
        result = await skillApi.publishSkillVersion(targetSkill.id, {
          file: selectedFile,
          baseVersionId: targetSkill.currentVersion.id,
          version,
          changelog,
          displayName: targetSkill.owner.id === currentUser.id || currentUser.role === "ADMIN" ? displayName : undefined,
          displayDescription,
          tagIds: selectedTagIds,
          newTagNames: newTagNames.split(/[,，]/).map((name) => name.trim()).filter(Boolean),
          confirmDuplicateDisplayName,
        });
      } else {
        const createdTags = newTagNames.split(/[,，]/).map((name) => name.trim()).filter(Boolean);
        if (selectedTagIds.length + createdTags.length > 5) {
          throw new SkillApiError("INVALID_REQUEST", "已有 Tag 与新 Tag 合计不能超过 5 个");
        }
        result = await skillApi.createSkill({
          file: selectedFile,
          displayName,
          displayDescription,
          tagIds: selectedTagIds,
          newTagNames: createdTags,
          forkedFromSkillId: forkSource?.id,
          forkedFromVersionId: forkSource?.currentVersion.id,
          confirmDuplicateDisplayName,
        });
      }
      console.info("[KocotreeSkills] Skill 发布完成", {
        skillId: result.id,
        version: result.currentVersion.version,
      });
      onPublished(result);
    } catch (reason) {
      console.error("[KocotreeSkills] Skill 发布失败", reason);
      if (reason instanceof SkillApiError && reason.code === "DISPLAY_NAME_CONFIRMATION_REQUIRED") {
        setDuplicateConflicts((reason.details?.conflicts as Array<{ id: string; displayName: string; skillName: string }>) ?? []);
      }
      setError(reason instanceof SkillApiError ? reason.message : "发布失败，请检查表单后重试");
    } finally {
      setPublishing(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await publish(false);
  }

  const nameMismatch = Boolean(
    targetSkill && inspection && targetSkill.skillName !== inspection.skillName,
  );

  return (
    <main className="page-content upload-page">
      <header className="page-heading upload-heading">
        <div>
          <h1>{targetSkill ? "上传新版本" : "上传 Skill"}</h1>
          <p>{targetSkill ? `目标 Skill：${targetSkill.displayName}（${targetSkill.skillName}）` : "在本地解析 ZIP，并确认平台展示信息后发布"}</p>
        </div>
      </header>

      <form className="upload-panel" onSubmit={(event) => void handleSubmit(event)}>
        <div className="form-section-heading">
          <span className="section-number">1</span>
          <div><h2>选择 Skill ZIP</h2><p>最大 50 MB，根目录或单层外包装目录中必须包含 SKILL.md</p></div>
        </div>

        <label className={inspecting ? "file-dropzone is-loading" : "file-dropzone"}>
          <input
            type="file"
            accept=".zip,application/zip"
            disabled={inspecting || publishing}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void inspectFile(file);
            }}
          />
          <span className="dropzone-icon"><AppIcon name="upload" size={25} /></span>
          <strong>{inspecting ? "正在解析 ZIP…" : fileName || "拖入 Skill ZIP，或点击选择文件"}</strong>
          <small>{fileName && !inspecting ? "重新点击可更换文件" : "仅支持 .zip 文件"}</small>
        </label>

        {inspection && (
          <section className="inspection-result" aria-label="ZIP 解析结果">
            <div className="inspection-heading"><strong>本地解析成功</strong></div>
            <dl>
              <div><dt>Skill 名称</dt><dd><code>{inspection.skillName}</code></dd></div>
              <div><dt>Skill 描述</dt><dd>{inspection.skillDescription}</dd></div>
              <div><dt>文件</dt><dd>{inspection.fileCount} 个文件 · {formatFileSize(inspection.packageSize)}</dd></div>
              <div><dt>内容哈希</dt><dd title={inspection.contentHash}><code>{inspection.contentHash.slice(0, 24)}…</code></dd></div>
            </dl>
            {inspection.warnings.map((warning) => <p className="inspection-warning" key={warning}>{warning}</p>)}
          </section>
        )}

        {nameMismatch && inspection && targetSkill && (
          <div className="mismatch-notice">
            <strong>Skill 名称不一致，不能作为新版本发布</strong>
            <span>目标为 <code>{targetSkill.skillName}</code>，ZIP 中为 <code>{inspection.skillName}</code>。</span>
            <Button size="small" onClick={() => { setForkSource(targetSkill); onSwitchToCreate(); }}>作为派生 Skill 发布</Button>
          </div>
        )}

        {inspection && !nameMismatch && (
          <>
            <div className="form-divider" />
            <div className="form-section-heading">
              <span className="section-number">2</span>
              <div>
                <h2>{targetSkill ? "填写版本信息" : "确认发布信息"}</h2>
                {targetSkill && <p>新版本必须高于当前最新版本</p>}
              </div>
            </div>

            {!targetSkill && (
              <div className="form-grid">
                <label className="field"><span>展示名称</span><input required value={displayName} onChange={(event) => setDisplayName(event.currentTarget.value)} /></label>
                <label className="field"><span>首个版本</span><input readOnly value="1.0.0" /></label>
                <label className="field field-wide"><span>展示简介</span><textarea required value={displayDescription} onChange={(event) => setDisplayDescription(event.currentTarget.value)} /></label>
                <fieldset className="tag-field field-wide">
                  <legend>选择已有 Tag（最多 5 个）</legend>
                  <div>
                    {availableTags.map((tag) => <button className={selectedTagIds.includes(tag.id) ? "source-chip active" : "source-chip"} type="button" key={tag.id} onClick={() => toggleTag(tag.id)}>{tag.name}</button>)}
                    {newTagInputVisible ? (
                      <span className="tag-create-editor">
                        <input
                          className="tag-create-input"
                          autoFocus
                          aria-label="创建新 Tag"
                          value={newTagNames}
                          onChange={(event) => setNewTagNames(event.currentTarget.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              setNewTagInputVisible(false);
                            }
                            if (event.key === "Escape") {
                              setNewTagNames("");
                              setNewTagInputVisible(false);
                            }
                          }}
                          placeholder="输入 Tag，多个用逗号分隔"
                        />
                        <Tooltip content="取消创建新 Tag">
                          <button
                            className="tag-create-cancel-button"
                            type="button"
                            aria-label="取消创建新 Tag"
                            onClick={() => {
                              setNewTagNames("");
                              setNewTagInputVisible(false);
                            }}
                          >
                            <AppIcon name="close" size={14} />
                          </button>
                        </Tooltip>
                      </span>
                    ) : (
                      <Tooltip content="创建新 Tag">
                        <button
                          className="tag-create-button"
                          type="button"
                          aria-label="创建新 Tag"
                          onClick={() => setNewTagInputVisible(true)}
                        >
                          <AppIcon name="plus" size={15} />
                        </button>
                      </Tooltip>
                    )}
                  </div>
                </fieldset>
              </div>
            )}

            {targetSkill && (
              <div className="form-grid update-metadata-grid">
                {(targetSkill.owner.id === currentUser.id || currentUser.role === "ADMIN") && (
                  <label className="field"><span>展示名称</span><input required value={displayName} onChange={(event) => setDisplayName(event.currentTarget.value)} /></label>
                )}
                <label className="field field-wide"><span>展示简介</span><textarea required value={displayDescription} onChange={(event) => setDisplayDescription(event.currentTarget.value)} /></label>
                <fieldset className="tag-field field-wide">
                  <legend>Tag（最多 5 个）</legend>
                  <div>{availableTags.map((tag) => <button className={selectedTagIds.includes(tag.id) ? "source-chip active" : "source-chip"} type="button" key={tag.id} onClick={() => toggleTag(tag.id)}>{tag.name}</button>)}</div>
                </fieldset>
              </div>
            )}

            <div className="form-grid version-form-grid">
              {targetSkill && (
                <label className="field"><span>版本号</span><input required value={version} onChange={(event) => setVersion(event.currentTarget.value)} placeholder={`高于 ${targetSkill.currentVersion.version}`} /></label>
              )}
              <label className="field field-wide"><span>更新说明{targetSkill ? "（必填）" : ""}</span><textarea required value={changelog} readOnly={!targetSkill} onChange={(event) => setChangelog(event.currentTarget.value)} placeholder={targetSkill ? "请说明本次更新内容，例如：优化触发条件，补充使用示例。" : "首次发布"} /></label>
            </div>
          </>
        )}

        {error && <div className="form-error" role="alert">{error}</div>}
        {duplicateConflicts.length > 0 && (
          <div className="duplicate-confirmation">
            <strong>平台中存在同名展示名称</strong>
            <span>{duplicateConflicts.map((item) => `${item.displayName}（${item.skillName}）`).join("、")}</span>
            <Button size="small" onClick={() => void publish(true)}>仍然继续发布</Button>
          </div>
        )}

        <div className="form-actions">
          <button className="secondary-button" type="button" onClick={onCancel}>取消</button>
          <button className="primary-button" type="submit" disabled={!inspection || !selectedFile || nameMismatch || inspecting || publishing}>
            <AppIcon name="upload" size={17} />{publishing ? "正在发布…" : targetSkill ? "发布新版本" : "发布 Skill"}
          </button>
        </div>
      </form>
    </main>
  );
}
