-- Skill 浏览页索引。CREATE INDEX CONCURRENTLY 不能放在事务中执行。
-- 部署时逐条执行；IF NOT EXISTS 允许重复执行本文件。

CREATE INDEX CONCURRENTLY IF NOT EXISTS skills_catalog_popular_idx
ON skills (
  install_count DESC,
  updated_at DESC,
  created_at DESC,
  id DESC
)
WHERE status = 'PUBLISHED' AND latest_version_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS skills_catalog_updated_idx
ON skills (updated_at DESC, id DESC)
WHERE status = 'PUBLISHED' AND latest_version_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS skills_catalog_created_idx
ON skills (created_at DESC, id DESC)
WHERE status = 'PUBLISHED' AND latest_version_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS users_department_path_idx
ON users (department_path)
WHERE cardinality(department_path) > 0;

-- 模糊搜索使用 ILIKE '%keyword%'，需要 pg_trgm 才能稳定使用索引。
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS skills_name_trgm_idx
ON skills USING gin (name gin_trgm_ops)
WHERE status = 'PUBLISHED' AND latest_version_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS skills_description_trgm_idx
ON skills USING gin (description gin_trgm_ops)
WHERE status = 'PUBLISHED' AND latest_version_id IS NOT NULL;
