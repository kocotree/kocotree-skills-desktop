import { isTauri } from "@tauri-apps/api/core";
import { createIncrementalSkillApi } from "./incrementalSkillApi";
import { MockLocalSkillService } from "./mockLocalSkillService";
import { TauriInstaller } from "./tauriInstaller";

export * from "./contracts";
export * from "./skillPackage";

/** 在线能力按模块逐步从 Mock 迁移到真实后端。 */
export const skillApi = createIncrementalSkillApi();
export const localSkillService = new MockLocalSkillService();
export const usesRealInstaller = isTauri();
/** 浏览器使用 Mock，Tauri 桌面窗口使用真实磁盘安装器。 */
export const installer = usesRealInstaller ? new TauriInstaller() : localSkillService;
