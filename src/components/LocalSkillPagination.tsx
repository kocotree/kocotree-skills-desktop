const LOCAL_SKILL_PAGE_SIZE = 10;

export function paginateLocalSkills<T>(
  items: readonly T[],
  page: number,
): T[] {
  const start = (page - 1) * LOCAL_SKILL_PAGE_SIZE;
  return items.slice(start, start + LOCAL_SKILL_PAGE_SIZE);
}

export function getLocalSkillPageCount(total: number): number {
  return Math.max(1, Math.ceil(total / LOCAL_SKILL_PAGE_SIZE));
}

/**
 * 功能说明：为本地 Skill 管理页面提供固定每页 10 项的轻量分页导航。
 */
export function LocalSkillPagination({
  page,
  total,
  onChange,
}: {
  page: number;
  total: number;
  onChange: (page: number) => void;
}) {
  const pageCount = getLocalSkillPageCount(total);
  if (total <= LOCAL_SKILL_PAGE_SIZE) return null;

  return (
    <nav className="local-skill-pagination" aria-label="本地 Skill 分页">
      <span>
        第 <strong>{page}</strong> / {pageCount} 页 · 共 {total} 个
      </span>
      <div>
        <button
          type="button"
          disabled={page === 1}
          onClick={() => onChange(1)}
        >
          首页
        </button>
        <button
          type="button"
          disabled={page === 1}
          onClick={() => onChange(page - 1)}
        >
          上一页
        </button>
        <button
          type="button"
          disabled={page === pageCount}
          onClick={() => onChange(page + 1)}
        >
          下一页
        </button>
        <button
          type="button"
          disabled={page === pageCount}
          onClick={() => onChange(pageCount)}
        >
          末页
        </button>
      </div>
    </nav>
  );
}
