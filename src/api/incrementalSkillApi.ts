import { isTauri } from "@tauri-apps/api/core";
import type { SkillApi } from "./contracts";
import { DesktopAuthApi } from "./desktopAuthApi";
import { MockSkillApi } from "./mockSkillApi";

class IncrementalSkillApi extends MockSkillApi {
  private readonly auth = new DesktopAuthApi();

  override async getCurrentUser() {
    const user = await this.auth.getCurrentUser();
    this.setCurrentUser(user);
    return user;
  }

  override async signIn() {
    const user = await this.auth.signIn();
    this.setCurrentUser(user);
    return user;
  }

  override async signOut() {
    await this.auth.signOut();
    this.setCurrentUser(null);
  }
}

/**
 * 迁移期间只在 Tauri 环境替换真实身份方法，其余在线能力继续由 Mock 提供。
 */
export function createIncrementalSkillApi(): SkillApi {
  return isTauri() ? new IncrementalSkillApi() : new MockSkillApi();
}
