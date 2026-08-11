import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppIcon } from "./AppIcon";

interface FilterOption {
  id: string;
  name: string;
}

interface TagWidth {
  id: string;
  width: number;
}

interface VisibleTagInput {
  tags: readonly TagWidth[];
  selectedTagId: string;
  availableWidth: number;
  allTagWidth: number;
  moreWidth: number;
  gap: number;
}

/**
 * 功能说明：根据标签行宽度计算外部可见标签，并确保当前选中标签不会被收入更多菜单。
 */
export function getVisibleTagIds({
  tags,
  selectedTagId,
  availableWidth,
  allTagWidth,
  moreWidth,
  gap,
}: VisibleTagInput): string[] {
  const allTagsWidth = tags.reduce(
    (width, tag) => width + gap + tag.width,
    allTagWidth,
  );
  if (allTagsWidth <= availableWidth) {
    return tags.map((tag) => tag.id);
  }

  let usedWidth = allTagWidth + gap + moreWidth;
  const visibleTags: TagWidth[] = [];
  for (const tag of tags) {
    const nextWidth = usedWidth + gap + tag.width;
    if (nextWidth > availableWidth) break;
    visibleTags.push(tag);
    usedWidth = nextWidth;
  }

  const selectedTag = tags.find((tag) => tag.id === selectedTagId);
  if (
    !selectedTag
    || visibleTags.some((tag) => tag.id === selectedTag.id)
  ) {
    return visibleTags.map((tag) => tag.id);
  }

  while (
    visibleTags.length > 0
    && usedWidth + gap + selectedTag.width > availableWidth
  ) {
    const removedTag = visibleTags.pop();
    if (removedTag) usedWidth -= gap + removedTag.width;
  }
  visibleTags.push(selectedTag);
  return visibleTags.map((tag) => tag.id);
}

function sameIds(current: readonly string[], next: readonly string[]): boolean {
  return (
    current.length === next.length
    && current.every((id, index) => id === next[index])
  );
}

/**
 * 功能说明：渲染响应式标签筛选行，将放不下的标签收进支持搜索的更多菜单。
 */
export function TagFilter({
  tags,
  selectedTagId = "all",
  selectedTagIds,
  onChange,
  onMultiChange,
  label = "标签",
  allLabel = "全部标签",
  moreAriaLabel = "更多标签",
  searchPlaceholder = "搜索标签",
  searchAriaLabel = "搜索更多标签",
  emptyText = "没有匹配的标签",
}: {
  tags: FilterOption[];
  selectedTagId?: string;
  selectedTagIds?: string[];
  onChange?: (tagId: string) => void;
  onMultiChange?: (tagIds: string[]) => void;
  label?: string;
  allLabel?: string;
  moreAriaLabel?: string;
  searchPlaceholder?: string;
  searchAriaLabel?: string;
  emptyText?: string;
}) {
  const multiSelect = selectedTagIds !== undefined;
  const multiSelectedTagIds = selectedTagIds ?? [];
  const activeTagIds = useMemo(
    () => new Set(
      multiSelect
        ? multiSelectedTagIds
        : selectedTagId === "all"
          ? []
          : [selectedTagId],
    ),
    [multiSelect, multiSelectedTagIds, selectedTagId],
  );
  const selectedTagForLayout = selectedTagIds?.[0] ?? selectedTagId;
  const [visibleTagIds, setVisibleTagIds] = useState<string[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreQuery, setMoreQuery] = useState("");
  const optionsRef = useRef<HTMLDivElement>(null);
  const measurementsRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const visibleTagIdSet = useMemo(
    () => new Set(visibleTagIds),
    [visibleTagIds],
  );
  const visibleTags = tags.filter((tag) => visibleTagIdSet.has(tag.id));
  const hiddenTags = tags.filter((tag) => !visibleTagIdSet.has(tag.id));
  const normalizedQuery = moreQuery.trim().toLocaleLowerCase();
  const filteredHiddenTags = hiddenTags.filter((tag) =>
    tag.name.toLocaleLowerCase().includes(normalizedQuery)
  );

  useLayoutEffect(() => {
    const options = optionsRef.current;
    const measurements = measurementsRef.current;
    if (!options || !measurements) return;

    const syncVisibleTags = () => {
      const tagWidths = new Map<string, number>();
      measurements
        .querySelectorAll<HTMLElement>("[data-tag-measure-id]")
        .forEach((element) => {
          const id = element.dataset.tagMeasureId;
          if (id) tagWidths.set(id, element.getBoundingClientRect().width);
        });
      const allTagWidth = measurements
        .querySelector<HTMLElement>("[data-measure-all]")
        ?.getBoundingClientRect().width ?? 0;
      const moreWidth = measurements
        .querySelector<HTMLElement>("[data-measure-more]")
        ?.getBoundingClientRect().width ?? 0;
      const gap = Number.parseFloat(getComputedStyle(options).gap) || 0;
      const nextVisibleTagIds = getVisibleTagIds({
        tags: tags.map((tag) => ({
          id: tag.id,
          width: tagWidths.get(tag.id) ?? 0,
        })),
        selectedTagId: selectedTagForLayout,
        availableWidth: options.getBoundingClientRect().width,
        allTagWidth,
        moreWidth,
        gap,
      });
      setVisibleTagIds((current) =>
        sameIds(current, nextVisibleTagIds) ? current : nextVisibleTagIds
      );
    };

    syncVisibleTags();
    const resizeObserver = new ResizeObserver(syncVisibleTags);
    resizeObserver.observe(options);
    return () => resizeObserver.disconnect();
  }, [selectedTagForLayout, tags]);

  useEffect(() => {
    if (!moreOpen) return;
    const closeOutside = (event: MouseEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) {
        setMoreOpen(false);
        setMoreQuery("");
      }
    };
    const closeWithEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMoreOpen(false);
      setMoreQuery("");
      moreButtonRef.current?.focus();
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeWithEscape);
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeWithEscape);
    };
  }, [moreOpen]);

  useEffect(() => {
    if (hiddenTags.length > 0) return;
    setMoreOpen(false);
    setMoreQuery("");
  }, [hiddenTags.length]);

  function selectTag(tagId: string): void {
    if (multiSelect) {
      if (tagId === "all") {
        onMultiChange?.([]);
        setMoreOpen(false);
        setMoreQuery("");
        return;
      }
      onMultiChange?.(
        activeTagIds.has(tagId)
          ? multiSelectedTagIds.filter((id) => id !== tagId)
          : [...multiSelectedTagIds, tagId],
      );
      return;
    }
    onChange?.(tagId);
    setMoreOpen(false);
    setMoreQuery("");
  }

  const hiddenSelectedCount = hiddenTags.filter((tag) =>
    activeTagIds.has(tag.id)
  ).length;

  return (
    <div className="source-row tag-filter-row">
      <span className="tag-filter-label">{label}</span>
      <div className="tag-filter-options" ref={optionsRef}>
        <button
          className={activeTagIds.size === 0 ? "source-chip active" : "source-chip"}
          type="button"
          aria-pressed={activeTagIds.size === 0}
          onClick={() => selectTag("all")}
        >
          {allLabel}
        </button>
        {visibleTags.map((tag) => (
          <button
            className={activeTagIds.has(tag.id) ? "source-chip tag-filter-chip active" : "source-chip tag-filter-chip"}
            type="button"
            aria-pressed={activeTagIds.has(tag.id)}
            title={tag.name}
            key={tag.id}
            onClick={() => selectTag(tag.id)}
          >
            <span>{tag.name}</span>
          </button>
        ))}
        {hiddenTags.length > 0 && (
          <div className="tag-filter-more" ref={moreRef}>
            <button
              className={hiddenSelectedCount > 0 ? "source-chip tag-filter-more-trigger active" : "source-chip tag-filter-more-trigger"}
              type="button"
              aria-expanded={moreOpen}
              aria-controls={menuId}
              aria-haspopup="dialog"
              ref={moreButtonRef}
              onClick={() => setMoreOpen((current) => !current)}
            >
              <span className="tag-filter-more-label">更多 · </span>
              <strong>{hiddenTags.length}</strong>
              <span className="tag-filter-chevron" aria-hidden="true" />
            </button>
            {moreOpen && (
              <section
                className="tag-filter-menu"
                id={menuId}
                role="dialog"
                aria-label={moreAriaLabel}
              >
                <label className="tag-filter-search">
                  <AppIcon name="search" size={15} />
                  <input
                    ref={searchInputRef}
                    value={moreQuery}
                    placeholder={searchPlaceholder}
                    aria-label={searchAriaLabel}
                    onChange={(event) => setMoreQuery(event.currentTarget.value)}
                  />
                </label>
                <div className="tag-filter-menu-list">
                  {filteredHiddenTags.length > 0 ? (
                    filteredHiddenTags.map((tag) => (
                      <button
                        className={activeTagIds.has(tag.id) ? "active" : ""}
                        type="button"
                        aria-pressed={activeTagIds.has(tag.id)}
                        title={tag.name}
                        key={tag.id}
                        onClick={() => selectTag(tag.id)}
                      >
                        <span>{tag.name}</span>
                        {activeTagIds.has(tag.id) && <AppIcon name="check" size={14} />}
                      </button>
                    ))
                  ) : (
                    <span className="tag-filter-menu-empty">
                      {emptyText}
                    </span>
                  )}
                </div>
              </section>
            )}
          </div>
        )}
      </div>

      <div
        className="tag-filter-measurements"
        ref={measurementsRef}
        aria-hidden="true"
      >
        <button className="source-chip" type="button" tabIndex={-1} data-measure-all>
          {allLabel}
        </button>
        {tags.map((tag) => (
          <button
            className="source-chip tag-filter-chip"
            type="button"
            tabIndex={-1}
            title={tag.name}
            data-tag-measure-id={tag.id}
            key={tag.id}
          >
            <span>{tag.name}</span>
          </button>
        ))}
        <button
          className="source-chip tag-filter-more-trigger"
          type="button"
          tabIndex={-1}
          data-measure-more
        >
          <span className="tag-filter-more-label">更多 · </span>
          <strong>{tags.length}</strong>
          <span className="tag-filter-chevron" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
