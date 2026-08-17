import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { prepareSkillPackage } from "../src/services/skill-package.service";

describe("Skill 上传包清理", () => {
  it("移除 Python 缓存并保留 .gitkeep 及其文件夹", async () => {
    const zip = new JSZip();
    zip.file(
      "SKILL.md",
      "---\nname: cache-test\ndescription: Test package cleanup.\n---\n",
    );
    zip.file("empty/.gitkeep", "");
    zip.file("src/__pycache__/tool.cpython-313.pyc", "compiled cache");

    const input = Buffer.from(await zip.generateAsync({ type: "uint8array" }));
    const prepared = await prepareSkillPackage(input);
    const filePaths = prepared.files.map((file) => file.path);
    const entryPaths = prepared.entries.map((entry) => entry.path);

    expect(filePaths).toContain("empty/.gitkeep");
    expect(entryPaths).toContain("empty");
    expect(filePaths.some((path) => path.includes("__pycache__"))).toBe(false);
    expect(prepared.ignoredSystemEntryCount).toBeGreaterThan(0);

    const canonicalZip = await JSZip.loadAsync(prepared.packageBuffer);
    expect(canonicalZip.file("empty/.gitkeep")).not.toBeNull();
    expect(
      canonicalZip.file("src/__pycache__/tool.cpython-313.pyc"),
    ).toBeNull();
  });
});
