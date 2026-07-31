import { useEffect, useState, type FormEvent } from "react";
import { Button, Tooltip } from "./ui";
import {
  parseSkillPackage,
  parseSkillFolder,
  skillApi,
  SkillApiError,
  type ParsedSkillPackage,
  type SkillDetailDto,
  type SkillSummaryDto,
  type SkillPackageInspection,
  type TagDto,
  type UserDto,
} from "../api";
import { AppIcon } from "./AppIcon";
import { mergeTagNames, parseTagNames } from "./tagNames";

interface UploadPageProps {
  targetSkill: SkillSummaryDto | null;
  currentUser: UserDto;
  onCancel: () => void;
  onPublished: (skill: SkillDetailDto) => void;
  onSwitchToCreate: () => void;
}

type UploadSourceType = "zip" | "folder";

const folderInputAttributes = {
  directory: "",
  webkitdirectory: "",
};

// Tag 选择暂时不在上传页展示，保留完整实现便于后续恢复。
const showTagSelection = false;

function nextPatchVersion(version: string): string {
  const [major = "1", minor = "0", patch = "0"] = version.split(/[+-]/)[0].split(".");
  return `${major}.${minor}.${Number(patch) + 1}`;
}

/**
 * 功能说明：在本地解析 ZIP 或自动打包文件夹，并在用户确认后创建 Skill 或发布指定 Skill 新版本。
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
  const [selectedSourceType, setSelectedSourceType] = useState<UploadSourceType | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<SkillPackageInspection | null>(null);
  const [availableTags, setAvailableTags] = useState<TagDto[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [newTagNames, setNewTagNames] = useState<string[]>([]);
  const [newTagDraft, setNewTagDraft] = useState("");
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
    setNewTagNames([]);
    setNewTagDraft("");
    setNewTagInputVisible(false);
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
   * 功能说明：解析用户选择的 ZIP 或文件夹，并将可上传文件与只读包信息保存在页面状态中。
   * @param sourceName - 页面展示的 ZIP 文件名或文件夹名。
   * @param sourceType - 用户选择的上传来源类型。
   * @param parse - 对应来源的本地解析与打包操作。
   * @returns 无返回值。
   */
  async function inspectSource(
    sourceName: string,
    sourceType: UploadSourceType,
    parse: () => Promise<ParsedSkillPackage>,
  ): Promise<void> {
    setFileName(sourceName);
    setSelectedSourceType(sourceType);
    setSelectedFile(null);
    setInspection(null);
    setError("");
    setInspecting(true);
    console.info("[KocotreeSkills] 开始解析 Skill 上传来源", {
      sourceName,
      sourceType,
    });
    try {
      const { inspection: result, uploadFile } = await parse();
      setSelectedFile(uploadFile);
      setInspection(result);
      if (!targetSkill) {
        setDisplayName(result.skillName);
        setDisplayDescription(result.skillDescription);
      }
      console.info("[KocotreeSkills] Skill 上传来源解析完成", {
        skillName: result.skillName,
        sourceType,
      });
    } catch (reason) {
      console.error("[KocotreeSkills] Skill 上传来源解析失败", reason);
      setError(reason instanceof SkillApiError ? reason.message : "Skill 解析失败，请重新选择");
    } finally {
      setInspecting(false);
    }
  }

  async function inspectFile(file: File): Promise<void> {
    await inspectSource(
      file.name,
      "zip",
      () => parseSkillPackage(file),
    );
  }

  async function inspectFolder(files: File[]): Promise<void> {
    const firstPath = files[0]?.webkitRelativePath || "";
    const folderName = firstPath.split("/")[0] || "Skill 文件夹";
    await inspectSource(
      folderName,
      "folder",
      () => parseSkillFolder(files),
    );
  }

  function toggleTag(tagId: string): void {
    setSelectedTagIds((current) => {
      if (current.includes(tagId)) {
        setError("");
        return current.filter((id) => id !== tagId);
      }
      if (current.length + newTagNames.length >= 5) {
        setError("每个 Skill 最多选择或创建 5 个 Tag");
        return current;
      }
      setError("");
      return [...current, tagId];
    });
  }

  function commitNewTagDraft(): void {
    const draftNames = parseTagNames(newTagDraft);
    if (draftNames.length === 0) {
      setError("请输入 Tag 名称");
      return;
    }
    const matchedTagIds = availableTags
      .filter((tag) => draftNames.some((name) => name.toLocaleLowerCase() === tag.name.toLocaleLowerCase()))
      .map((tag) => tag.id);
    const unmatchedNames = draftNames.filter((name) => !availableTags.some((tag) => tag.name.toLocaleLowerCase() === name.toLocaleLowerCase()));
    const nextTagIds = [...new Set([...selectedTagIds, ...matchedTagIds])];
    const nextNewTagNames = mergeTagNames(newTagNames, unmatchedNames.join(","));
    if (nextTagIds.length + nextNewTagNames.length > 5) {
      setError("每个 Skill 最多选择或创建 5 个 Tag");
      return;
    }
    setSelectedTagIds(nextTagIds);
    setNewTagNames(nextNewTagNames);
    setNewTagDraft("");
    setNewTagInputVisible(false);
    setError("");
  }

  /**
   * 功能说明：根据当前模式提交创建请求或新版本发布请求。
   * @param event - React 表单提交事件。
   * @returns 无返回值。
   */
  async function publish(confirmDuplicateDisplayName: boolean): Promise<void> {
    if (!inspection || !selectedFile) {
      setError("请先选择并成功解析 Skill ZIP 或文件夹");
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
          newTagNames,
          confirmDuplicateDisplayName,
        });
      } else {
        if (selectedTagIds.length + newTagNames.length > 5) {
          throw new SkillApiError("INVALID_REQUEST", "已有 Tag 与新 Tag 合计不能超过 5 个");
        }
        result = await skillApi.createSkill({
          file: selectedFile,
          displayName,
          displayDescription,
          changelog,
          tagIds: selectedTagIds,
          newTagNames,
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
          <p>
            {targetSkill
              ? `目标 Skill：${targetSkill.displayName}（${targetSkill.skillName}）`
              : "将本地 Skill 上传到云端，与团队成员共享"}
          </p>
        </div>
      </header>

      <form className="upload-panel" onSubmit={(event) => void handleSubmit(event)}>
        <div className="form-section-heading">
          <span className="section-number">1</span>
          <div><h2>选择 Skill 压缩包或文件夹</h2></div>
        </div>

        <div className="upload-source-grid">
          <label className={`file-dropzone${inspecting ? " is-loading" : ""}${selectedSourceType === "zip" ? " is-selected" : ""}`}>
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
            <strong>{inspecting && selectedSourceType === "zip" ? "正在解析 ZIP…" : selectedSourceType === "zip" ? fileName : "选择本地 Skill 压缩包"}</strong>
            {selectedSourceType === "zip" && !inspecting && <small>重新点击可更换 ZIP</small>}
          </label>
          <label className={`file-dropzone${inspecting ? " is-loading" : ""}${selectedSourceType === "folder" ? " is-selected" : ""}`}>
            <input
              type="file"
              multiple
              disabled={inspecting || publishing}
              {...folderInputAttributes}
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files || []);
                if (files.length > 0) void inspectFolder(files);
              }}
            />
            <span className="dropzone-icon"><AppIcon name="folder" size={25} /></span>
            <strong>{inspecting && selectedSourceType === "folder" ? "正在打包文件夹…" : selectedSourceType === "folder" ? fileName : "选择本地 Skill 文件夹"}</strong>
            {selectedSourceType === "folder" && !inspecting && <small>重新点击可更换文件夹</small>}
          </label>
        </div>

        {inspection && (
          <section className="inspection-result" aria-label="Skill 包解析结果">
            <div className="inspection-heading">
              <span className="inspection-status">
                <span className="inspection-status-icon"><AppIcon name="check" size={14} /></span>
                <strong>本地解析成功</strong>
              </span>
            </div>
            <div className="inspection-details">
              <div className="inspection-detail">
                <span>Skill 名称</span>
                <code>{inspection.skillName}</code>
              </div>
              <div className="inspection-detail">
                <span>Skill 描述</span>
                <p>{inspection.skillDescription}</p>
              </div>
            </div>
            {inspection.warnings.map((warning) => <p className="inspection-warning" key={warning}>{warning}</p>)}
          </section>
        )}

        {nameMismatch && inspection && targetSkill && (
          <div className="mismatch-notice">
            <strong>Skill 名称不一致，不能作为新版本发布</strong>
            <span>目标为 <code>{targetSkill.skillName}</code>，所选 Skill 中为 <code>{inspection.skillName}</code>。</span>
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
                <label className="field"><span>展示名称（必填）</span><input required value={displayName} onChange={(event) => setDisplayName(event.currentTarget.value)} /></label>
                <label className="field"><span>版本号（固定）</span><input readOnly value={version} /></label>
                <label className="field field-wide"><span>展示简介（必填）</span><textarea required value={displayDescription} onChange={(event) => setDisplayDescription(event.currentTarget.value)} /></label>
                {showTagSelection && (
                  <fieldset className="tag-field field-wide" aria-required="false">
                    <legend>选择 Tag（可选，最多 5 个）</legend>
                    <div>
                      {availableTags.map((tag) => <button className={selectedTagIds.includes(tag.id) ? "source-chip active" : "source-chip"} type="button" key={tag.id} onClick={() => toggleTag(tag.id)}>{tag.name}</button>)}
                      {newTagNames.map((name) => (
                        <span className="tag-created-chip" key={name}>
                          {name}
                          <button
                            type="button"
                            aria-label={`删除新 Tag：${name}`}
                            onClick={() => {
                              setNewTagNames((items) => items.filter((item) => item !== name));
                              setError("");
                            }}
                          >
                            <AppIcon name="close" size={12} />
                          </button>
                        </span>
                      ))}
                      {newTagInputVisible ? (
                        <span className="tag-create-editor">
                          <input
                            className="tag-create-input"
                            autoFocus
                            aria-label="创建新 Tag"
                            value={newTagDraft}
                            onChange={(event) => {
                              setNewTagDraft(event.currentTarget.value);
                              setError("");
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                commitNewTagDraft();
                              }
                              if (event.key === "Escape") {
                                setNewTagDraft("");
                                setNewTagInputVisible(false);
                              }
                            }}
                            placeholder="输入后按回车添加"
                          />
                          <Tooltip content="取消创建新 Tag">
                            <button
                              className="tag-create-cancel-button"
                              type="button"
                              aria-label="取消创建新 Tag"
                              onClick={() => {
                                setNewTagDraft("");
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
                )}
              </div>
            )}

            {targetSkill && (
              <div className="form-grid update-metadata-grid">
                {(targetSkill.owner.id === currentUser.id || currentUser.role === "ADMIN") && (
                  <label className="field"><span>展示名称（必填）</span><input required value={displayName} onChange={(event) => setDisplayName(event.currentTarget.value)} /></label>
                )}
                <label className="field field-wide"><span>展示简介（必填）</span><textarea required value={displayDescription} onChange={(event) => setDisplayDescription(event.currentTarget.value)} /></label>
                {showTagSelection && (
                  <fieldset className="tag-field field-wide" aria-required="false">
                    <legend>Tag（可选，最多 5 个）</legend>
                    <div>{availableTags.map((tag) => <button className={selectedTagIds.includes(tag.id) ? "source-chip active" : "source-chip"} type="button" key={tag.id} onClick={() => toggleTag(tag.id)}>{tag.name}</button>)}</div>
                  </fieldset>
                )}
              </div>
            )}

            <div className="form-grid version-form-grid">
              {targetSkill && (
                <label className="field"><span>版本号（必填）</span><input required value={version} onChange={(event) => setVersion(event.currentTarget.value)} placeholder={`高于 ${targetSkill.currentVersion.version}`} /></label>
              )}
              <label className="field field-wide"><span>更新说明（{targetSkill ? "必填" : "选填"}）</span><textarea required={Boolean(targetSkill)} value={changelog} onChange={(event) => setChangelog(event.currentTarget.value)} placeholder={targetSkill ? "请说明本次更新内容，例如：优化触发条件，补充使用示例。" : "首次发布"} /></label>
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
