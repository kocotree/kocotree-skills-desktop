import { describe, expect, it } from "vitest";
import { getVisibleTagIds } from "./TagFilter";

const tags = [
  { id: "automation", width: 70 },
  { id: "image", width: 50 },
  { id: "audio", width: 50 },
  { id: "video", width: 50 },
];

describe("getVisibleTagIds", () => {
  it("宽度足够时展示全部标签", () => {
    expect(getVisibleTagIds({
      tags,
      selectedTagId: "all",
      availableWidth: 400,
      allTagWidth: 70,
      moreWidth: 65,
      gap: 7,
    })).toEqual(["automation", "image", "audio", "video"]);
  });

  it("空间不足时只展示能容纳的前置标签", () => {
    expect(getVisibleTagIds({
      tags,
      selectedTagId: "all",
      availableWidth: 275,
      allTagWidth: 70,
      moreWidth: 65,
      gap: 7,
    })).toEqual(["automation"]);
  });

  it("选中项原本隐藏时替换最后一个可见标签", () => {
    expect(getVisibleTagIds({
      tags,
      selectedTagId: "video",
      availableWidth: 280,
      allTagWidth: 70,
      moreWidth: 65,
      gap: 7,
    })).toEqual(["automation", "video"]);
  });

  it("极窄空间中仍保留当前选中标签", () => {
    expect(getVisibleTagIds({
      tags,
      selectedTagId: "audio",
      availableWidth: 130,
      allTagWidth: 70,
      moreWidth: 65,
      gap: 7,
    })).toEqual(["audio"]);
  });
});
