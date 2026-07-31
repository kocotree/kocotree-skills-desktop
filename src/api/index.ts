import { isTauri } from "@tauri-apps/api/core";
import {
  AUTH_INVALIDATED_EVENT,
  HttpSkillApi,
} from "./httpSkillApi";
import { TauriInstaller } from "./tauriInstaller";

export * from "./contracts";
export { AUTH_INVALIDATED_EVENT };
export * from "./skillPackage";
export * from "./localSkillSource";

/** 所有在线业务数据均来自真实后端，不提供运行时 Mock 回退。 */
export const skillApi = new HttpSkillApi();
export const usesRealInstaller = isTauri();
export const localSkillService = new TauriInstaller();
export const installer = localSkillService;
