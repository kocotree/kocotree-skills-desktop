-- 为历史业务场景关联补齐分配人：使用 Skill 创建者作为历史关联的归属人。
UPDATE skill_business_scenarios AS relation
SET assigned_by = skill.created_by
FROM skills AS skill
WHERE relation.skill_id = skill.id
  AND relation.assigned_by IS NULL
  AND skill.created_by IS NOT NULL;
