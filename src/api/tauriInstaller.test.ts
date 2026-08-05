import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DownloadTicketDto,
  SkillSummaryDto,
  SkillVersionDto,
} from "./contracts";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import { TauriInstaller } from "./tauriInstaller";

describe("TauriInstaller", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("确认覆盖时向桌面命令传递 force 并返回备份信息", async () => {
    invokeMock.mockResolvedValue({
      installedPath: "/Users/test/.kocotree-skills/skills/research",
      replacedSkillName: "research",
      backupPath: "/Users/test/.kocotree-skills/backups/research-123",
    });
    const skill = {
      id: "skill-1",
      displayName: "Research",
    } as SkillSummaryDto;
    const version = {
      id: "version-1",
      version: "2.0.0",
      skillName: "research",
      contentHash: "sha256:content",
    } as SkillVersionDto;
    const ticket = {
      url: "https://example.com/research.zip",
      packageSha256: "sha256:package",
    } as DownloadTicketDto;

    const result = await new TauriInstaller().install({
      skill,
      version,
      ticket,
      force: true,
    });

    expect(invokeMock).toHaveBeenCalledWith("install_skill", {
      input: expect.objectContaining({ force: true }),
    });
    expect(result.replacedSkillName).toBe("research");
    expect(result.backupPath).toBe(
      "/Users/test/.kocotree-skills/backups/research-123",
    );
  });
});
