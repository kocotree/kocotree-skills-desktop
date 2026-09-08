import { useEffect, useMemo, useRef, useState } from "react";
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
}: {
  tags: FilterOption[];
  selectedTagId?: string;
  selectedTagIds?: string[];
  onChange?: (tagId: string) => void;
  onMultiChange?: (tagIds: string[]) => void;
  label?: string;
  allLabel?: string;
  variant?: "chips" | "segmented";
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
  const optionsRef = useRef<HTMLDivElement | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [hasPrevious, setHasPrevious] = useState(false);
  useEffect(() => {
    if (variant !== "chips") return;
    const element = optionsRef.current;
    if (!element) return;
    const update = () => {
      setHasPrevious(element.scrollLeft > 2);
      setHasMore(element.scrollLeft + element.clientWidth < element.scrollWidth - 2);
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      element.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [variant, tags.length]);
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
        className={`tag-filter-scroll-shell ${variant === "chips" ? "is-chip-scroll-shell" : ""} ${hasPrevious ? "has-previous" : ""}`}
      >
      <div
        ref={optionsRef}
        className="tag-filter-options"
        role="group"
        aria-label={`${label}（${multiSelect ? "可多选" : "单选"}）`}
      >
        {!multiSelect && (
          <button
            className={activeTagIds.size === 0 ? "source-chip active" : "source-chip"}
            type="button"
            aria-pressed={activeTagIds.size === 0}
            onClick={() => selectTag("all")}
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
      {variant === "chips" && hasPrevious && (
        <button
          className="tag-filter-scroll-more is-previous"
          type="button"
          aria-label="查看前面的业务场景"
          onClick={() => optionsRef.current?.scrollBy({ left: -260, behavior: "smooth" })}
        >‹</button>
      )}
      {variant === "chips" && hasMore && (
        <button
          className="tag-filter-scroll-more"
          type="button"
          aria-label="查看更多业务场景"
          onClick={() => optionsRef.current?.scrollBy({ left: 260, behavior: "smooth" })}
        >›</button>
      )}
      </div>
    </div>
  );
}
