import { useMemo } from "react";
import { AppIcon } from "./AppIcon";

interface FilterOption {
  id: string;
  name: string;
}

/**
 * 功能说明：渲染完整的标签筛选行，空间不足时自动换行展示所有选项。
 */
export function TagFilter({
  tags,
  selectedTagId = "all",
  selectedTagIds,
  onChange,
  onMultiChange,
  label = "标签",
  allLabel = "全部",
  variant,
  showAll = false,
}: {
  tags: FilterOption[];
  selectedTagId?: string;
  selectedTagIds?: string[];
  onChange?: (tagId: string) => void;
  onMultiChange?: (tagIds: string[]) => void;
  label?: string;
  allLabel?: string;
  variant?: "chips" | "segmented";
  showAll?: boolean;
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
  function selectTag(tagId: string): void {
    if (multiSelect) {
      onMultiChange?.(
        activeTagIds.has(tagId)
          ? multiSelectedTagIds.filter((id) => id !== tagId)
          : [...multiSelectedTagIds, tagId],
      );
      return;
    }
    onChange?.(activeTagIds.has(tagId) ? "all" : tagId);
  }

  return (
    <div className={`source-row tag-filter-row ${multiSelect || variant === "chips" ? "is-multi" : "is-single"} ${variant === "chips" ? "is-chip-row" : ""}`}>
      <span className="tag-filter-label">{label}</span>
      <div
        className="tag-filter-options"
        role="group"
        aria-label={`${label}（${multiSelect ? "可多选" : "单选"}）`}
      >
        {(!multiSelect || showAll) && (
          <button
            className={activeTagIds.size === 0 ? "source-chip active" : "source-chip"}
            type="button"
            aria-pressed={activeTagIds.size === 0}
            onClick={() => multiSelect ? onMultiChange?.([]) : selectTag("all")}
          >
            {allLabel}
          </button>
        )}
        {tags.map((tag) => (
          <button
            className={activeTagIds.has(tag.id) ? "source-chip tag-filter-chip active" : "source-chip tag-filter-chip"}
            type="button"
            aria-pressed={activeTagIds.has(tag.id)}
            title={tag.name}
            key={tag.id}
            onClick={() => selectTag(tag.id)}
          >
            {multiSelect && activeTagIds.has(tag.id) && (
              <AppIcon name="check" size={13} />
            )}
            <span>{tag.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
