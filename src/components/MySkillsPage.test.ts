import { describe, expect, it } from "vitest";
import { filterPublishedSkills } from "./MySkillsPage";

const skills = [
  {
    displayName: "研究助手",
    skillName: "research-assistant",
  },
  {
    displayName: "Article Writer",
    skillName: "article-writer",
  },
];

describe("filterPublishedSkills", () => {
  it("按展示名称和 Skill 名称搜索，不区分大小写并忽略首尾空格", () => {
    expect(filterPublishedSkills(skills, "  ARTICLE ")).toEqual([skills[1]]);
    expect(filterPublishedSkills(skills, "research-ass")).toEqual([skills[0]]);
  });

  it("空查询返回全部 Skill，无匹配时返回空列表", () => {
    expect(filterPublishedSkills(skills, "  ")).toEqual(skills);
    expect(filterPublishedSkills(skills, "missing")).toEqual([]);
  });
});
