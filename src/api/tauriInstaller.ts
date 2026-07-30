import { invoke } from "@tauri-apps/api/core";
import {
  SkillApiError,
  type AgentInstallationStatus,
  type LocalInstallRequest,
  type LocalInstallResult,
  type LocalSkillRecord,
  type LocalSkillService,
  type RemoveLocalSkillInput,
  type SetLocalSkillEnabledInput,
} from "./contracts";

interface InstallSkillCommandResult {
  installedPath: string;
}

interface InstallSkillCommandError {
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
}

function parseCommandError(reason: unknown): InstallSkillCommandError | null {
  if (typeof reason === "object" && reason !== null) {
    return reason as InstallSkillCommandError;
  }
  if (typeof reason !== "string") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(reason);
    return typeof parsed === "object" && parsed !== null
      ? parsed as InstallSkillCommandError
      : null;
  } catch {
    return { message: reason };
  }
}

/** Tauri 桌面环境使用的真实 Skill 安装器。 */
export class TauriInstaller implements LocalSkillService {
  /** 检测当前设备是否安装了需要单独投放 Skill 的 Agent。 */
  async getAgentInstallationStatus(): Promise<AgentInstallationStatus> {
    try {
      return await invoke<AgentInstallationStatus>(
        "get_agent_installation_status",
      );
    } catch (reason) {
      const commandError = parseCommandError(reason);
      throw new SkillApiError(
        commandError?.code ?? "AGENT_INSTALLATION_DETECTION_FAILED",
        commandError?.message ?? "Agent 安装状态检测失败",
        commandError?.details,
      );
    }
  }

  /**
   * 功能说明：调用 Rust 命令下载、校验并写入指定平台版本。
   * @param input - 目标 Skill、版本和下载凭证。
   * @returns 最终本地记录和安装路径。
   */
  async install(input: LocalInstallRequest): Promise<LocalInstallResult> {
    if (!input.ticket) {
      throw new SkillApiError("DOWNLOAD_TICKET_REQUIRED", "真实安装需要有效的下载凭证");
    }
    console.info("[TauriInstaller] 开始真实安装", {
      skillId: input.skill.id,
      versionId: input.version.id,
      skillName: input.version.skillName,
    });
    try {
      const installedAt = new Date().toISOString();
      const result = await invoke<InstallSkillCommandResult>("install_skill", {
        input: {
          skillId: input.skill.id,
          versionId: input.version.id,
          version: input.version.version,
          skillName: input.version.skillName,
          displayName: input.skill.displayName,
          contentHash: input.version.contentHash,
          installedAt,
          downloadUrl: input.ticket.url,
          packageSha256: input.ticket.packageSha256,
        },
      });
      console.info("[TauriInstaller] 真实安装完成", {
        skillName: input.version.skillName,
        installedPath: result.installedPath,
      });
      return {
        record: {
          id: crypto.randomUUID(),
          skillId: input.skill.id,
          versionId: input.version.id,
          version: input.version.version,
          skillName: input.version.skillName,
          displayName: input.skill.displayName,
          installPath: result.installedPath,
          contentHash: input.version.contentHash,
          installedAt,
          status: "PLATFORM_INSTALLED",
          location: "MANAGER",
          entryKind: "DIRECTORY",
          resolvedPath: result.installedPath,
        },
        replacedSkillName: null,
        backupPath: null,
        notices: [],
      };
    } catch (reason) {
      const commandError = parseCommandError(reason);
      console.error("[TauriInstaller] 真实安装失败", {
        skillName: input.version.skillName,
        code: commandError?.code,
        reason,
      });
      throw new SkillApiError(
        commandError?.code ?? "LOCAL_INSTALL_FAILED",
        commandError?.message ?? "本地安装失败",
        commandError?.details,
      );
    }
  }

  /** 读取 Skill 私有仓库以及 Claude Code/Codex 生效目录。 */
  async scanSkills(): Promise<LocalSkillRecord[]> {
    try {
      return await invoke<LocalSkillRecord[]>("scan_local_skills");
    } catch (reason) {
      const commandError = parseCommandError(reason);
      throw new SkillApiError(
        commandError?.code ?? "LOCAL_SKILL_SCAN_FAILED",
        commandError?.message ?? "本地 Skill 扫描失败",
        commandError?.details,
      );
    }
  }

  async setSkillEnabled(
    input: SetLocalSkillEnabledInput,
  ): Promise<LocalSkillRecord[]> {
    try {
      return await invoke<LocalSkillRecord[]>(
        "set_local_skill_enabled",
        { input },
      );
    } catch (reason) {
      const commandError = parseCommandError(reason);
      throw new SkillApiError(
        commandError?.code ?? "LOCAL_SKILL_CONTROL_FAILED",
        commandError?.message ?? "更新本地 Skill 状态失败",
        commandError?.details,
      );
    }
  }

  async remove(input: RemoveLocalSkillInput): Promise<LocalSkillRecord[]> {
    try {
      return await invoke<LocalSkillRecord[]>(
        "remove_local_skill",
        { input },
      );
    } catch (reason) {
      const commandError = parseCommandError(reason);
      throw new SkillApiError(
        commandError?.code ?? "LOCAL_UNINSTALL_FAILED",
        commandError?.message ?? "本地 Skill 卸载失败",
        commandError?.details,
      );
    }
  }
}
