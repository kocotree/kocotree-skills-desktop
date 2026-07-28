import { isTauri } from "@tauri-apps/api/core";
import { createIncrementalSkillApi } from "./incrementalSkillApi";
import { MockLocalSkillService } from "./mockLocalSkillService";
import { TauriInstaller } from "./tauriInstaller";

export * from "./contracts";
export { AUTH_INVALIDATED_EVENT } from "./incrementalSkillApi";
export * from "./skillPackage";

/** 在线能力按模块逐步从 Mock 迁移到真实后端。 */
export const skillApi = createIncrementalSkillApi();
export const usesRealInstaller = isTauri();
export const localSkillService = usesRealInstaller
  ? new TauriInstaller()
  : new MockLocalSkillService();
/** 浏览器使用 Mock，Tauri 桌面窗口使用真实磁盘安装器。 */
export const installer = localSkillService;
