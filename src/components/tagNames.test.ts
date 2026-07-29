import { describe, expect, it } from "vitest";
import { mergeTagNames, parseTagNames } from "./tagNames";

describe("tagNames", () => {
  it("按中英文逗号拆分并清理空白", () => {
    expect(parseTagNames("生图， 自动化, ,效率")).toEqual(["生图", "自动化", "效率"]);
  });

  it("合并时忽略大小写重复项并保留原有顺序", () => {
    expect(mergeTagNames(["Automation"], "automation, 生图")).toEqual(["Automation", "生图"]);
  });
});
