-- Business scenario catalog and Skill-to-scenario many-to-many assignments.
CREATE TYPE "business_scenario_status" AS ENUM ('ACTIVE', 'ARCHIVED');

CREATE TABLE "business_scenarios" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "sort_order" INTEGER NOT NULL,
  "status" "business_scenario_status" NOT NULL DEFAULT 'ACTIVE',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "business_scenarios_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "business_scenarios_slug_key" ON "business_scenarios"("slug");
CREATE INDEX "business_scenarios_status_sort_idx" ON "business_scenarios"("status", "sort_order");

CREATE TABLE "skill_business_scenarios" (
  "skill_id" UUID NOT NULL,
  "scenario_id" UUID NOT NULL,
  "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "assigned_by" UUID,
  CONSTRAINT "skill_business_scenarios_pkey" PRIMARY KEY ("skill_id", "scenario_id"),
  CONSTRAINT "skill_business_scenarios_skill_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "skill_business_scenarios_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "business_scenarios"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "skill_business_scenarios_scenario_skill_idx" ON "skill_business_scenarios"("scenario_id", "skill_id");
CREATE INDEX "skill_business_scenarios_assigned_by_idx" ON "skill_business_scenarios"("assigned_by");

INSERT INTO "business_scenarios" ("slug", "name", "description", "sort_order") VALUES
  ('product-and-merchandising', '商品与产品', '商品企划、需求分析、竞品研究、产品开发、打样评审', 10),
  ('ecommerce-operations', '电商运营', '店铺运营、商品上架、平台规则、活动和转化优化', 20),
  ('content-marketing', '内容营销', '选题、品牌策划、活动传播、营销内容规划', 30),
  ('visual-content-production', '视觉与内容生产', '主图、详情页、海报、3D、摄影、修图、视频及 AI 素材', 40),
  ('customer-and-user-operations', '客服与用户运营', '售前、售后、客服话术、用户反馈、私域运营', 50),
  ('channels-and-business', '渠道与商务', '加盟、BD、批发、渠道拓展、门店经营、合作谈判', 60),
  ('supply-chain-and-production', '供应链与生产', '供应商、采购、品控、成本、生产、实验室和打样', 70),
  ('technology-development', '技术研发', '软件开发、接口、内部工具和技术研发', 80),
  ('ai-automation', 'AI 自动化', 'AI 应用、Agent、自动化流程和批处理任务', 90),
  ('data-and-business-analysis', '数据与经营分析', '销售、投放 ROI、库存、利润、报表和经营预测', 100),
  ('financial-management', '财务管理', '对账、结算、预算、成本核算、报销和利润管理', 110),
  ('human-resources-and-administration', '人事行政', '招聘、入转调离、培训、考勤、制度和行政事务', 120)
ON CONFLICT ("slug") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "sort_order" = EXCLUDED."sort_order";
