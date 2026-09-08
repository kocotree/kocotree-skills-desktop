import { getCurrentWebview } from "@tauri-apps/api/webview";
import JSZip from "jszip";
import {
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import { Button, Tooltip } from "./ui";
import {
  inspectPreparedLocalSkillPackage,
  localSkillService,
  parseSkillPackage,
  parseSkillFolder,
  skillApi,
  SkillApiError,
  usesRealInstaller,
  type PreparedSkillUpload,
  type SkillDetailDto,
  type SkillSummaryDto,
  type SkillPackageInspection,
  type TagDto,
  type BusinessScenarioDto,
  type UserDto,
} from "../api";
import { nextDateSkillVersion } from "../api/skillVersion";
import { AppIcon } from "./AppIcon";
import { mergeTagNames, parseTagNames } from "./tagNames";

interface UploadPageProps {
  targetSkill: SkillSummaryDto | null;
  initialPackage: PreparedSkillUpload | null;
  currentUser: UserDto;
  onCancel: () => void;
  onPublished: (skill: SkillDetailDto) => void | Promise<void>;
  onSwitchToCreate: () => void;
}

type UploadSourceType = "zip" | "folder";

const folderInputAttributes = {
  directory: "",
  webkitdirectory: "",
};

interface DroppedFileSystemEntry {
  isFile: boolean;
  isDirectory: boolean;
  fullPath: string;
  file: (
    onSuccess: (file: File) => void,
    onError?: (error: DOMException) => void,
  ) => void;
  createReader: () => {
    readEntries: (
      onSuccess: (entries: DroppedFileSystemEntry[]) => void,
      onError?: (error: DOMException) => void,
    ) => void;
  };
}

function droppedEntry(item: DataTransferItem): DroppedFileSystemEntry | null {
  const entry = (item as DataTransferItem & {
    webkitGetAsEntry?: () => DroppedFileSystemEntry | null;
  }).webkitGetAsEntry?.();
  return (entry as DroppedFileSystemEntry | null | undefined) ?? null;
}

function readDroppedFile(entry: DroppedFileSystemEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function readDroppedDirectory(
  entry: DroppedFileSystemEntry,
): Promise<DroppedFileSystemEntry[]> {
  const reader = entry.createReader();
  const entries: DroppedFileSystemEntry[] = [];
  while (true) {
    const batch = await new Promise<DroppedFileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject)
    );
    if (batch.length === 0) return entries;
    entries.push(...batch);
  }
}

async function collectDroppedFolderFiles(
  entry: DroppedFileSystemEntry,
): Promise<File[]> {
  if (entry.isFile) {
    const file = await readDroppedFile(entry);
    Object.defineProperty(file, "webkitRelativePath", {
      configurable: true,
      value: entry.fullPath.replace(/^\/+/, ""),
    });
    return [file];
  }
  if (!entry.isDirectory) return [];
  const children = await readDroppedDirectory(entry);
  const nestedFiles = await Promise.all(children.map(collectDroppedFolderFiles));
  return nestedFiles.flat();
}

function droppedPathName(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || "Skill";
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
  initialPackage,
  currentUser,
  onCancel,
  onPublished,
  onSwitchToCreate,
}: UploadPageProps) {
  const [fileName, setFileName] = useState(
    initialPackage?.inspection.originalFileName ?? "",
  );
  const [selectedSourceType, setSelectedSourceType] = useState<UploadSourceType | null>(
    initialPackage ? "folder" : null,
  );
  const [selectedFile, setSelectedFile] = useState<File | null>(
    initialPackage?.uploadFile ?? null,
  );
  const [inspection, setInspection] = useState<SkillPackageInspection | null>(
    initialPackage?.inspection ?? null,
  );
  const [availableTags, setAvailableTags] = useState<TagDto[]>([]);
  const [businessScenarios, setBusinessScenarios] = useState<BusinessScenarioDto[]>([]);
  const [selectedBusinessScenarioIds, setSelectedBusinessScenarioIds] = useState<string[]>([]);
  const [suggestedBusinessScenarioIds, setSuggestedBusinessScenarioIds] = useState<string[]>([]);
  const [scenarioSuggestionState, setScenarioSuggestionState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const scenarioSuggestionKey = useRef<File | null>(null);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [newTagNames, setNewTagNames] = useState<string[]>([]);
  const [newTagDraft, setNewTagDraft] = useState("");
  const [newTagInputVisible, setNewTagInputVisible] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [displayDescription, setDisplayDescription] = useState("");
  const [translationState, setTranslationState] = useState<
    "idle" | "translating" | "translated" | "failed"
  >("idle");
  const translationRequestId = useRef(0);
  const [version, setVersion] = useState(() =>
    nextDateSkillVersion(targetSkill?.currentVersion.version),
  );
  const [changelog, setChangelog] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const dropzoneRef = useRef<HTMLDivElement | null>(null);
  const zipInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [forkSource, setForkSource] = useState<SkillSummaryDto | null>(null);
  const [duplicateConflicts, setDuplicateConflicts] = useState<Array<{ id: string; displayName: string; skillName: string }>>([]);

  useEffect(() => {
    skillApi.listTags().then(setAvailableTags).catch((reason: unknown) => {
      console.error("[KocotreeSkills] 上传页 Tag 加载失败", reason);
    });
    skillApi.listBusinessScenarios().then(setBusinessScenarios).catch((reason: unknown) => {
      console.error("[KocotreeSkills] 业务场景加载失败", reason);
    });
  }, []);

  useEffect(() => {
    setVersion(nextDateSkillVersion(targetSkill?.currentVersion.version));
    setChangelog("");
    setNewTagNames([]);
    setNewTagDraft("");
    setNewTagInputVisible(false);
    setError("");
    setDuplicateConflicts([]);
    setSelectedTagIds(targetSkill?.tags.map((tag) => tag.id) ?? []);
    setSelectedBusinessScenarioIds(targetSkill?.businessScenarios.map((scenario) => scenario.id) ?? []);
    setSuggestedBusinessScenarioIds([]);
    setScenarioSuggestionState("idle");
    if (targetSkill) {
      setDisplayName(targetSkill.displayName);
      setDisplayDescription(targetSkill.displayDescription);
    }
    if (!targetSkill && inspection) {
      setDisplayName(inspection.skillName);
      setDisplayDescription(inspection.skillDescription);
      const requestId = ++translationRequestId.current;
      void translateMetadata(inspection, requestId);
    } else {
      setTranslationState("idle");
    }
  }, [inspection, targetSkill]);

  useEffect(() => {
    if (targetSkill || !inspection || !selectedFile || scenarioSuggestionKey.current === selectedFile) return;
    scenarioSuggestionKey.current = selectedFile;
    void suggestScenarios(selectedFile);
  }, [inspection, selectedFile, targetSkill]);

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
    parse: () => Promise<PreparedSkillUpload>,
  ): Promise<void> {
    translationRequestId.current += 1;
    setFileName(sourceName);
    setSelectedSourceType(sourceType);
    setSelectedFile(null);
    setInspection(null);
    setError("");
    setTranslationState("idle");
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

  async function suggestScenarios(file: File): Promise<void> {
    setScenarioSuggestionState("loading");
    try {
      const zip = await JSZip.loadAsync(file);
      const parts: string[] = [];
      for (const name of Object.keys(zip.files)) {
        if (/(^|\/)SKILL\.md$/i.test(name) || /(^|\/)README(?:\.md)?$/i.test(name)) {
          parts.push(await zip.files[name].async("text"));
        }
      }
      if (!parts.length) {
        setScenarioSuggestionState("failed");
        return;
      }
      const result = await skillApi.suggestBusinessScenarios(parts.join("\n\n").slice(0, 20000));
      const content = parts.join("\n").toLocaleLowerCase();
      const scenarios = businessScenarios.length ? businessScenarios : await skillApi.listBusinessScenarios();
      const fallbackIds = scenarios
        .filter((scenario) => `${scenario.name} ${scenario.description}`.split(/[，。；、\s]+/).some((term) => term.length >= 2 && content.includes(term.toLocaleLowerCase())))
        .slice(0, 3)
        .map((scenario) => scenario.id);
      const availableIds = new Set(scenarios.map((scenario) => scenario.id));
      const ids = (result.scenarioIds.length ? result.scenarioIds : fallbackIds).filter((id) => availableIds.has(id)).slice(0, 3);
      setSuggestedBusinessScenarioIds(ids);
      setSelectedBusinessScenarioIds((current) => current.length ? current : ids);
      setScenarioSuggestionState(ids.length ? "ready" : "failed");
    } catch (reason) {
      console.warn("[KocotreeSkills] AI 业务场景预选失败，保留手动选择", reason);
      setScenarioSuggestionState("failed");
    }
  }

  /** 使用服务端 DeepSeek 快速模式生成可编辑的中文展示信息。 */
  async function translateMetadata(
    source: SkillPackageInspection,
    requestId = translationRequestId.current,
  ): Promise<void> {
    setTranslationState("translating");
    try {
      const translated = await skillApi.translateSkillMetadata({
        skillName: source.skillName,
        skillDescription: source.skillDescription,
      });
      if (requestId !== translationRequestId.current) return;
      setDisplayName(translated.displayName);
      setDisplayDescription(translated.displayDescription);
      setTranslationState("translated");
    } catch (reason) {
      if (requestId !== translationRequestId.current) return;
      console.error("[KocotreeSkills] Skill 展示信息翻译失败", reason);
      setTranslationState("failed");
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

  async function inspectDroppedPath(path: string): Promise<void> {
    const sourceName = droppedPathName(path);
    const isZip = sourceName.toLocaleLowerCase().endsWith(".zip");
    await inspectSource(
      sourceName,
      isZip ? "zip" : "folder",
      async () => {
        const packagedFile = await localSkillService.packageSkill(
          path,
          sourceName.replace(/\.zip$/i, ""),
        );
        return isZip
          ? parseSkillPackage(packagedFile)
          : inspectPreparedLocalSkillPackage(packagedFile);
      },
    );
  }

  async function inspectNativeDrop(paths: string[]): Promise<void> {
    if (paths.length !== 1) {
      setError("一次只能拖入一个 Skill ZIP 或文件夹");
      return;
    }
    try {
      await inspectDroppedPath(paths[0]);
    } catch (reason) {
      console.error("[KocotreeSkills] 拖拽 Skill 来源失败", reason);
      setError(
        reason instanceof SkillApiError
          ? reason.message
          : "仅支持一个 Skill ZIP 或包含 SKILL.md 的文件夹",
      );
    }
  }

  async function inspectBrowserDrop(
    dataTransfer: DataTransfer,
  ): Promise<void> {
    const fileItems = Array.from(dataTransfer.items).filter(
      (item) => item.kind === "file",
    );
    if (fileItems.length !== 1) {
      setError("一次只能拖入一个 Skill ZIP 或文件夹");
      return;
    }
    const entry = droppedEntry(fileItems[0]);
    if (entry?.isDirectory) {
      const files = await collectDroppedFolderFiles(entry);
      if (files.length === 0) {
        setError("拖入的文件夹中没有可上传的文件");
        return;
      }
      await inspectFolder(files);
      return;
    }
    const file = dataTransfer.files[0];
    if (!file || !file.name.toLocaleLowerCase().endsWith(".zip")) {
      setError("仅支持 Skill ZIP 或包含 SKILL.md 的文件夹");
      return;
    }
    await inspectFile(file);
  }

  function nativeDropInside(position: { x: number; y: number }): boolean {
    const element = dropzoneRef.current;
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const scale = window.devicePixelRatio || 1;
    const x = position.x / scale;
    const y = position.y / scale;
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  useEffect(() => {
    if (!usesRealInstaller) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "leave") {
        setDragActive(false);
        return;
      }
      const inside = nativeDropInside(payload.position);
      if (payload.type === "drop") {
        setDragActive(false);
        if (inside && !inspecting && !publishing) {
          void inspectNativeDrop(payload.paths);
        }
        return;
      }
      setDragActive(inside && !inspecting && !publishing);
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    }).catch((reason: unknown) => {
      console.error("[KocotreeSkills] 注册文件拖拽监听失败", reason);
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [inspecting, publishing]);

  function handleBrowserDrag(event: ReactDragEvent<HTMLDivElement>): void {
    if (usesRealInstaller || inspecting || publishing) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  }

  function handleBrowserDragLeave(event: ReactDragEvent<HTMLDivElement>): void {
    const nextTarget = event.relatedTarget;
    if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
      setDragActive(false);
    }
  }

  function handleBrowserDrop(event: ReactDragEvent<HTMLDivElement>): void {
    if (usesRealInstaller || inspecting || publishing) return;
    event.preventDefault();
    setDragActive(false);
    void inspectBrowserDrop(event.dataTransfer).catch((reason: unknown) => {
      console.error("[KocotreeSkills] 浏览器拖拽 Skill 来源失败", reason);
      setError(reason instanceof SkillApiError ? reason.message : "Skill 解析失败，请重新拖入");
    });
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

  function renderTagSelection(legend: string) {
    return (
      <fieldset className="tag-field field-wide" aria-required="false">
        <legend>{legend}</legend>
        <div>
          {availableTags.map((tag) => (
            <button
              className={selectedTagIds.includes(tag.id) ? "source-chip active" : "source-chip"}
              type="button"
              aria-pressed={selectedTagIds.includes(tag.id)}
              key={tag.id}
              onClick={() => toggleTag(tag.id)}
            >
              {tag.name}
            </button>
          ))}
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
    );
  }

  function renderBusinessScenarioSelection(): ReactNode {
    return (
      <fieldset className="tag-field field-wide" aria-required="false">
        <legend>业务场景（可选，最多 3 个） <small>AI 建议仅供确认</small></legend>
        {(scenarioSuggestionState === "loading" || scenarioSuggestionState === "failed" || suggestedBusinessScenarioIds.length > 0) && (
          <div className={`scenario-ai-status${scenarioSuggestionState === "failed" ? " is-failed" : ""}`} role="status">
            <span className="scenario-ai-dot" aria-hidden="true" />
            <span>{scenarioSuggestionState === "loading" ? "AI 正在分析 Skill 内容…" : scenarioSuggestionState === "failed" ? "AI 暂无建议，请手动选择" : `AI 已预选 ${suggestedBusinessScenarioIds.map((id) => businessScenarios.find((item) => item.id === id)?.name).filter(Boolean).join("、")}，可手动调整`}</span>
          </div>
        )}
        <div className="scenario-chip-list">
          {businessScenarios.map((scenario) => {
            const selected = selectedBusinessScenarioIds.includes(scenario.id);
            return (
              <button
                className={selected ? "source-chip active" : "source-chip"}
                type="button"
                aria-pressed={selected}
                key={scenario.id}
                onClick={() => {
                  setSelectedBusinessScenarioIds((current) => {
                    if (current.includes(scenario.id)) return current.filter((id) => id !== scenario.id);
                    if (current.length >= 3) {
                      setError("每个 Skill 最多选择 3 个业务场景");
                      return current;
                    }
                    setError("");
                    return [...current, scenario.id];
                  });
                }}
              >
                {scenario.name}
              </button>
            );
          })}
        </div>
      </fieldset>
    );
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
          businessScenarioIds: selectedBusinessScenarioIds,
          forkedFromSkillId: forkSource?.id,
          forkedFromVersionId: forkSource?.currentVersion.id,
          confirmDuplicateDisplayName,
        });
      }
      console.info("[KocotreeSkills] Skill 发布完成", {
        skillId: result.id,
        version: result.currentVersion.version,
      });
      await onPublished(result);
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

        <div
          ref={dropzoneRef}
          className={`file-dropzone upload-combined-dropzone${inspecting ? " is-loading" : ""}${selectedSourceType ? " is-selected" : ""}${dragActive ? " is-dragging" : ""}`}
          role="group"
          aria-label="拖入或选择 Skill 压缩包或文件夹"
          aria-busy={inspecting}
          onDragEnter={handleBrowserDrag}
          onDragOver={handleBrowserDrag}
          onDragLeave={handleBrowserDragLeave}
          onDrop={handleBrowserDrop}
        >
          <input
            ref={zipInputRef}
            type="file"
            accept=".zip,application/zip"
            disabled={inspecting || publishing}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void inspectFile(file);
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            disabled={inspecting || publishing}
            {...folderInputAttributes}
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files || []);
              event.currentTarget.value = "";
              if (files.length > 0) void inspectFolder(files);
            }}
          />
          <span className="dropzone-icon"><AppIcon name="upload" size={25} /></span>
          <span className="dropzone-copy">
            <strong>
              {dragActive
                ? "松开即可读取 Skill"
                : inspecting
                  ? selectedSourceType === "folder"
                    ? "正在打包文件夹…"
                    : "正在解析 ZIP…"
                  : selectedSourceType
                    ? fileName
                    : "把要上传的 Skill 拖到这里"}
            </strong>
            <small>
              {selectedSourceType && !inspecting
                ? "可以重新拖入，或点击右侧按钮更换"
                : "支持 ZIP 压缩包或完整的 Skill 文件夹"}
            </small>
          </span>
          <div className="dropzone-actions">
            <button
              className="dropzone-choice-button"
              type="button"
              disabled={inspecting || publishing}
              onClick={() => zipInputRef.current?.click()}
            >
              <AppIcon name="upload" size={15} />
              选择 ZIP 文件
            </button>
            <button
              className="dropzone-choice-button"
              type="button"
              disabled={inspecting || publishing}
              onClick={() => folderInputRef.current?.click()}
            >
              <AppIcon name="folder" size={15} />
              选择文件夹
            </button>
          </div>
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
                <div className="form-section-title-row">
                  <h2>{targetSkill ? "填写版本信息" : "确认发布信息"}</h2>
                  {!targetSkill && translationState === "translating" && (
                    <small className="translation-inline-status" role="status">AI 翻译中…</small>
                  )}
                </div>
                <p>版本号按北京时间日期自动生成，同一天发布会自动递增</p>
              </div>
            </div>

            {!targetSkill && (
              <div className="form-grid">
                <label className="field">
                  <span className="field-label-row">
                    <span>展示名称（必填）</span>
                    {translationState === "translated" && (
                      <small className="translation-inline-status" role="status">AI 已翻译，可编辑</small>
                    )}
                  </span>
                  <input required disabled={translationState === "translating"} value={displayName} onChange={(event) => setDisplayName(event.currentTarget.value)} />
                </label>
                <label className="field"><span>版本号（固定）</span><input readOnly value={version} /></label>
                <label className="field field-wide">
                  <span className="field-label-row">
                    <span>展示简介（必填）</span>
                    {translationState === "translated" && (
                      <small className="translation-inline-status" role="status">
                        {displayDescription === inspection.skillDescription
                          ? "来自 SKILL.md"
                          : "AI 已翻译，可编辑"}
                      </small>
                    )}
                  </span>
                  <textarea required disabled={translationState === "translating"} value={displayDescription} onChange={(event) => setDisplayDescription(event.currentTarget.value)} />
                </label>
                {translationState === "failed" && (
                  <div className="translation-fallback field-wide" role="status">
                    <span>中文展示信息翻译失败，当前保留原文；你可以手动修改或重试。</span>
                    <Button size="small" onClick={() => void translateMetadata(inspection)}>重新翻译</Button>
                  </div>
                )}
                {renderTagSelection("选择 Tag（可选，最多 5 个）")}
                {!targetSkill && renderBusinessScenarioSelection()}
              </div>
            )}

            {targetSkill && (
              <div className="form-grid update-metadata-grid">
                {(targetSkill.owner.id === currentUser.id || currentUser.role === "ADMIN") && (
                  <label className="field"><span>展示名称（必填）</span><input required value={displayName} onChange={(event) => setDisplayName(event.currentTarget.value)} /></label>
                )}
                <label className="field field-wide"><span>展示简介（必填）</span><textarea required value={displayDescription} onChange={(event) => setDisplayDescription(event.currentTarget.value)} /></label>
                {renderTagSelection("Tag（可选，最多 5 个）")}
              </div>
            )}

            <div className="form-grid version-form-grid">
              {targetSkill && (
                <label className="field"><span>版本号（自动生成）</span><input readOnly value={version} aria-label="系统自动生成的版本号" /></label>
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
          <button className="primary-button" type="submit" disabled={!inspection || !selectedFile || nameMismatch || inspecting || publishing || translationState === "translating"}>
            <AppIcon name="upload" size={17} />{publishing ? "正在发布…" : targetSkill ? "发布新版本" : "发布 Skill"}
          </button>
        </div>
      </form>
    </main>
  );
}
