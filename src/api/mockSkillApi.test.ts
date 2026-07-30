import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { SkillApiError } from "./contracts";
import { MockSkillApi } from "./mockSkillApi";
import { mockSkillDetails, mockUsers, skillIds } from "./mockData";
import { MockLocalSkillService } from "./mockLocalSkillService";
import { parseSkillPackage } from "./skillPackage";

function expectApiError(reason: unknown, code: string): boolean {
  expect(reason).toBeInstanceOf(SkillApiError);
  expect((reason as SkillApiError).code).toBe(code);
  return true;
}

/**
 * 功能说明：生成包含合法 SKILL.md 和附加文件的测试 ZIP。
 * @param skillName - SKILL.md 中使用的 Skill 名称。
 * @param rootDirectory - 可选的单层外包装目录。
 * @param extraContent - 用于制造不同内容哈希的附加文本。
 * @returns 浏览器上传接口可直接使用的 ZIP 文件。
 */
async function createSkillZip(skillName: string, rootDirectory = "", extraContent = ""): Promise<File> {
  const zip = new JSZip();
  const prefix = rootDirectory ? `${rootDirectory}/` : "";
  zip.file(`${prefix}SKILL.md`, `---\nname: ${skillName}\ndescription: Test ${skillName} workflow.\n---\n${extraContent}`);
  zip.file(`${prefix}references/usage.md`, `# ${skillName}\n${extraContent}`);
  const bytes = await zip.generateAsync({ type: "uint8array" });
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new File([buffer], `${skillName}.zip`, { type: "application/zip" });
}

describe("MockSkillApi", () => {
  it("允许匿名浏览并隐藏归档及名称失效 Skill", async () => {
    const api = new MockSkillApi({ delayMs: 0 });
    const result = await api.listSkills();
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every((skill) => skill.status === "ACTIVE")).toBe(true);
  });

  it("Skill 浏览支持按页码和页容量返回列表", async () => {
    const api = new MockSkillApi({ delayMs: 0 });
    const firstPage = await api.listSkills({ page: 1, pageSize: 5 });
    const secondPage = await api.listSkills({ page: 2, pageSize: 5 });
    expect(firstPage.items).toHaveLength(5);
    expect(secondPage.items).toHaveLength(5);
    expect(secondPage.total).toBe(firstPage.total);
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);
  });

  it("为全部预置 Mock Skill 标记统一 Tag", async () => {
    const api = new MockSkillApi({ delayMs: 0 });
    const mockTag = (await api.listTags()).find((item) => item.name === "Mock");
    expect(mockTag).toBeDefined();
    expect(mockSkillDetails.every((skill) => skill.tags.some((tag) => tag.id === mockTag!.id))).toBe(true);
    expect((await api.listSkills({ tagId: mockTag!.id })).items).toHaveLength((await api.listSkills()).items.length);
  });

  it("允许本地解析，但在发布前要求登录", async () => {
    const api = new MockSkillApi({ delayMs: 0 });
    const file = await createSkillZip("anonymous");
    expect((await parseSkillPackage(file)).inspection.skillName).toBe("anonymous");
    await expect(api.createSkill({ file, displayName: "匿名测试", displayDescription: "验证登录拦截。" }))
      .rejects.toSatisfy((reason: unknown) => expectApiError(reason, "UNAUTHENTICATED"));
  });

  it("新 Skill 首版本固定为 1.0.0", async () => {
    const api = new MockSkillApi({ delayMs: 0 });
    await api.signIn();
    const created = await api.createSkill({
      file: await createSkillZip("my-workflow", "my-workflow"),
      displayName: "我的工作流",
      displayDescription: "验证创建流程。",
      newTagNames: ["测试"],
    });
    expect(created.currentVersion.version).toBe("1.0.0");
    expect(created.owner.name).toBe("鸭腿");
    expect((await api.listVersionFiles(created.id, created.currentVersion.id)).some((item) => item.path === "SKILL.md")).toBe(true);
  });

  it("创建 Skill 时必须选择或创建至少一个 Tag", async () => {
    const api = new MockSkillApi({ delayMs: 0 });
    await api.signIn();
    await expect(api.createSkill({
      file: await createSkillZip("tag-required"),
      displayName: "Tag 必填测试",
      displayDescription: "验证发布时不能省略 Tag。",
    })).rejects.toSatisfy((reason: unknown) => expectApiError(reason, "INVALID_REQUEST"));
  });

  it("编辑展示信息时不能清空全部 Tag", async () => {
    const api = new MockSkillApi({ delayMs: 0 });
    const user = await api.signIn();
    const target = (await api.listSkills()).items.find((skill) => skill.owner.id === user.id)!;
    await expect(api.updateSkillMetadata(target.id, {
      tagIds: [],
      newTagNames: [],
    })).rejects.toSatisfy((reason: unknown) => expectApiError(reason, "INVALID_REQUEST"));
  });

  it("发布新版本时不能清空全部 Tag，失败后不修改当前版本", async () => {
    const api = new MockSkillApi({ delayMs: 0 });
    await api.signIn();
    const target = (await api.listSkills()).items.find((skill) => skill.skillName === "code-review")!;
    await expect(api.publishSkillVersion(target.id, {
      file: await createSkillZip(target.skillName, "", "tag required"),
      baseVersionId: target.currentVersion.id,
      version: "9.0.0",
      changelog: "验证 Tag 必填",
      tagIds: [],
      newTagNames: [],
    })).rejects.toSatisfy((reason: unknown) => expectApiError(reason, "INVALID_REQUEST"));
    expect((await api.getSkill(target.id)).currentVersion.id).toBe(target.currentVersion.id);
  });

  it("展示名称重复时要求用户明确确认", async () => {
    const api = new MockSkillApi({ delayMs: 0 });
    await api.signIn();
    const file = await createSkillZip("another-review");
    await expect(api.createSkill({ file, displayName: "代码审查助手", displayDescription: "同名展示测试。", newTagNames: ["测试"] }))
      .rejects.toSatisfy((reason: unknown) => expectApiError(reason, "DISPLAY_NAME_CONFIRMATION_REQUIRED"));
    const created = await api.createSkill({ file, displayName: "代码审查助手", displayDescription: "同名展示测试。", newTagNames: ["测试"], confirmDuplicateDisplayName: true });
    expect(created.skillName).toBe("another-review");
  });

  it("发布新版本要求 baseVersionId 与当前版本一致", async () => {
    const api = new MockSkillApi({ delayMs: 0 });
    await api.signIn();
    const target = (await api.listSkills()).items[0];
    await expect(api.publishSkillVersion(target.id, {
      file: await createSkillZip(target.skillName, "", "changed"),
      baseVersionId: "stale-version",
      version: "9.0.0",
      changelog: "并发冲突测试",
    })).rejects.toSatisfy((reason: unknown) => expectApiError(reason, "VERSION_CONFLICT"));
  });

  it("名称不一致时推荐发布为新的 Skill", async () => {
    const api = new MockSkillApi({ delayMs: 0 });
    await api.signIn();
    const target = (await api.listSkills()).items[0];
    await expect(api.publishSkillVersion(target.id, {
      file: await createSkillZip("another-skill"),
      baseVersionId: target.currentVersion.id,
      version: "9.0.0",
      changelog: "名称不匹配测试",
    })).rejects.toSatisfy((reason: unknown) => expectApiError(reason, "SKILL_NAME_MISMATCH"));
  });

  it("非 Owner 不能发布新版本", async () => {
    const api = new MockSkillApi({ delayMs: 0, initialUser: mockUsers.chen });
    const target = (await api.listSkills()).items.find((skill) => skill.skillName === "code-review")!;
    await expect(api.publishSkillVersion(target.id, {
      file: await createSkillZip(target.skillName, "", "new collaborator"),
      baseVersionId: target.currentVersion.id,
      version: "1.4.3",
      changelog: "尝试更新其他人的 Skill",
    })).rejects.toSatisfy((reason: unknown) => expectApiError(reason, "OWNER_REQUIRED"));
  });

  it("协作者不能修改展示名称", async () => {
    const api = new MockSkillApi({ delayMs: 0, initialUser: mockUsers.lin });
    const target = (await api.listSkills()).items.find((skill) => skill.skillName === "code-review");
    expect(target).toBeDefined();
    await expect(api.updateSkillMetadata(target!.id, { displayName: "无权修改" }))
      .rejects.toSatisfy((reason: unknown) => expectApiError(reason, "OWNER_REQUIRED"));
  });

  it("协作者不能修改展示简介", async () => {
    const api = new MockSkillApi({ delayMs: 0, initialUser: mockUsers.lin });
    const target = (await api.listSkills()).items.find((skill) => skill.skillName === "code-review")!;
    await expect(api.updateSkillMetadata(target.id, {
      displayDescription: "协作者尝试更新展示简介。",
    })).rejects.toSatisfy((reason: unknown) => expectApiError(reason, "OWNER_REQUIRED"));
  });

  it("安装上报使用事件 ID 保持幂等", async () => {
    const api = new MockSkillApi({ delayMs: 0 });
    await api.signIn();
    const skill = (await api.listSkills()).items[0];
    const before = skill.installCount;
    const event = { eventId: crypto.randomUUID(), skillId: skill.id, versionId: skill.currentVersion.id, installedAt: new Date().toISOString() };
    await api.recordInstallation(event);
    await api.recordInstallation(event);
    expect((await api.getSkill(skill.id)).installCount).toBe(before + 1);
  });

  it("通知支持一键全部已读", async () => {
    const api = new MockSkillApi({ delayMs: 0 });
    await api.signIn();
    expect((await api.listNotifications()).unreadCount).toBeGreaterThan(0);
    await api.readAllNotifications();
    expect((await api.listNotifications()).unreadCount).toBe(0);
  });

  it("本地同名未知 Skill 需要强制替换", async () => {
    const api = new MockSkillApi({ delayMs: 0 });
    const localApi = new MockLocalSkillService(0);
    const target = (await api.listSkills()).items[0];
    const localUnknown = (await localApi.scanSkills()).find((item) => item.status === "LOCAL_UNKNOWN")!;
    const conflictingSkill = { ...target, skillName: localUnknown.skillName, displayName: localUnknown.displayName };
    const conflictingVersion = { ...target.currentVersion, skillName: localUnknown.skillName };
    await expect(localApi.install({ skill: conflictingSkill, version: conflictingVersion }))
      .rejects.toSatisfy((reason: unknown) => expectApiError(reason, "LOCAL_SKILL_CONFLICT"));
    const result = await localApi.install({ skill: conflictingSkill, version: conflictingVersion, force: true });
    expect(result.backupPath).toContain(".agents/.kocotree/backups");
  });

  it("安装异常演示卡片覆盖文档中的前端处理场景", async () => {
    const api = new MockSkillApi({ delayMs: 0 });
    const tag = (await api.listTags()).find((item) => item.name === "安装异常")!;
    const result = await api.listSkills({ tagId: tag.id });
    expect(result.items).toHaveLength(8);
    expect((await api.getSkill(skillIds.derivedOverlap)).derivedFrom?.skillName).toBe("code-review");
    expect((await api.listSkillVersions(skillIds.downgrade)).items).toHaveLength(2);
    expect((await api.listSkillVersions(skillIds.withdrawn)).items.some((version) => version.status === "WITHDRAWN")).toBe(true);
  });

  it("已安装客户端可以查询归档、名称失效和撤回版本状态", async () => {
    const api = new MockSkillApi({ delayMs: 0 });
    const archived = await api.getInstallationStatus(skillIds.archived, "8b37c0a5-f1c9-4f4e-a71b-b6f06f671007");
    expect(archived.status).toBe("ARCHIVED");
    expect(archived.archiveReason).toBeTruthy();

    const conflicted = await api.getInstallationStatus(skillIds.nameConflict, "8b37c0a5-f1c9-4f4e-a71b-b6f06f671015");
    expect(conflicted.status).toBe("NAME_CONFLICT");
    expect(conflicted.nameConflictReason).toBeTruthy();

    const withdrawn = await api.getInstallationStatus(skillIds.withdrawn, "8b37c0a5-f1c9-4f4e-a71b-b6f06f671116");
    expect(withdrawn.versionStatus).toBe("WITHDRAWN");
    expect(withdrawn.recommendedVersion?.version).toBe("1.2.0");

    const localApi = new MockLocalSkillService(0);
    const unavailable = (await localApi.scanSkills()).find((record) => record.skillName === "online-unavailable-demo")!;
    await expect(api.getInstallationStatus(unavailable.skillId!, unavailable.versionId!))
      .rejects.toSatisfy((reason: unknown) => expectApiError(reason, "SKILL_NOT_FOUND"));
  });

  it("安装包校验失败时停止签发下载凭证", async () => {
    const api = new MockSkillApi({ delayMs: 0 });
    await api.signIn();
    const skill = await api.getSkill(skillIds.packageHash);
    await expect(api.getDownloadTicket(skill.id, skill.currentVersion.id))
      .rejects.toSatisfy((reason: unknown) => expectApiError(reason, "PACKAGE_HASH_MISMATCH"));
  });

  it("下载凭证包含可安装且哈希一致的模拟 ZIP", async () => {
    const api = new MockSkillApi({ delayMs: 0 });
    await api.signIn();
    const skill = (await api.listSkills()).items[0];
    const ticket = await api.getDownloadTicket(skill.id, skill.currentVersion.id);
    const encoded = ticket.url.split(",", 2)[1];
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    const packageSha256 = `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const archive = await JSZip.loadAsync(bytes);

    expect(ticket.url.startsWith("data:application/zip;base64,")).toBe(true);
    expect(packageSha256).toBe(ticket.packageSha256);
    expect(await archive.file("SKILL.md")?.async("string")).toContain(`name: ${skill.skillName}`);
  });

  it("本地修改和替换失败场景保留强制安装与恢复结果", async () => {
    const api = new MockSkillApi({ delayMs: 0 });
    const localApi = new MockLocalSkillService(0);
    const modified = await api.getSkill(skillIds.localModified);
    await expect(localApi.install({ skill: modified, version: modified.currentVersion }))
      .rejects.toSatisfy((reason: unknown) => expectApiError(reason, "LOCAL_SKILL_CONFLICT"));

    const rollback = await api.getSkill(skillIds.rollback);
    await expect(localApi.install({ skill: rollback, version: rollback.currentVersion }))
      .rejects.toSatisfy((reason: unknown) => expectApiError(reason, "LOCAL_SKILL_CONFLICT"));
    await expect(localApi.install({ skill: rollback, version: rollback.currentVersion, force: true }))
      .rejects.toSatisfy((reason: unknown) => expectApiError(reason, "INSTALL_ROLLBACK_COMPLETED"));
  });

  it("Claude 目录非空时保留安装结果并返回迁移说明", async () => {
    const api = new MockSkillApi({ delayMs: 0 });
    const localApi = new MockLocalSkillService(0);
    const skill = await api.getSkill(skillIds.claudeLink);
    const result = await localApi.install({ skill, version: skill.currentVersion });
    expect(result.record.status).toBe("PLATFORM_INSTALLED");
    expect(result.notices).toHaveLength(2);
  });
});
