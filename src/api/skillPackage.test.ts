import { describe, expect, it } from "vitest";
import { parseSkillFolder } from "./skillPackage";

function folderFile(relativePath: string, content: string): File {
  const pathSegments = relativePath.split("/");
  const file = new File(
    [content],
    pathSegments[pathSegments.length - 1] || "file",
    { type: "text/plain" },
  );
  Object.defineProperty(file, "webkitRelativePath", {
    configurable: true,
    value: relativePath,
  });
  return file;
}

describe("parseSkillFolder", () => {
  it("保留文件夹相对路径并生成可发布 ZIP", async () => {
    const parsed = await parseSkillFolder([
      folderFile(
        "image-helper/SKILL.md",
        "---\nname: image-helper\ndescription: Generate useful images.\n---\n",
      ),
      folderFile(
        "image-helper/references/usage.md",
        "# Usage\n",
      ),
    ]);

    expect(parsed.uploadFile.name).toBe("image-helper.zip");
    expect(parsed.uploadFile.type).toBe("application/zip");
    expect(parsed.inspection.originalFileName).toBe("image-helper");
    expect(parsed.inspection.skillName).toBe("image-helper");
    expect(parsed.inspection.fileCount).toBe(2);
    expect(parsed.source.files).toContainEqual(
      expect.objectContaining({
        path: "references/usage.md",
        type: "FILE",
      }),
    );
  });

  it("沿用 ZIP 清理逻辑移除文件夹中的系统元数据", async () => {
    const parsed = await parseSkillFolder([
      folderFile(
        "clean-folder/SKILL.md",
        "---\nname: clean-folder\ndescription: Test cleanup.\n---\n",
      ),
      folderFile("clean-folder/.DS_Store", "metadata"),
    ]);

    expect(parsed.inspection.fileCount).toBe(1);
    expect(parsed.inspection.warnings).toEqual([
      "已自动清理 1 条 macOS 系统元数据",
    ]);
  });

  it("拒绝来自多个根目录的混合文件", async () => {
    await expect(parseSkillFolder([
      folderFile(
        "first/SKILL.md",
        "---\nname: first\ndescription: First skill.\n---\n",
      ),
      folderFile("second/readme.md", "# Other\n"),
    ])).rejects.toMatchObject({
      code: "INVALID_SKILL_PACKAGE",
    });
  });
});
