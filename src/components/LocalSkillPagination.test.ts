import { describe, expect, it } from "vitest";
import {
  getLocalSkillPageCount,
  getSkillPageCount,
  paginateLocalSkills,
} from "./LocalSkillPagination";

describe("SkillPagination helpers", () => {
  it("按指定页容量计算总页数", () => {
    expect(getSkillPageCount(36, 18)).toBe(2);
    expect(getSkillPageCount(37, 18)).toBe(3);
    expect(getSkillPageCount(0, 18)).toBe(1);
  });

  it("保留本地 Skill 每页 10 项的分页行为", () => {
    const items = Array.from({ length: 21 }, (_, index) => index + 1);
    expect(getLocalSkillPageCount(items.length)).toBe(3);
    expect(paginateLocalSkills(items, 2)).toEqual([
      11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
  });
});
