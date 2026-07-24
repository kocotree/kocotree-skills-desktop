import { isTauri } from "@tauri-apps/api/core";
import type { ListSkillsQuery, SkillApi } from "./contracts";
import { DesktopAuthApi } from "./desktopAuthApi";
import { HttpCatalogApi } from "./httpCatalogApi";
import { AuthenticatedHttpClient } from "./httpClient";
import { MockSkillApi } from "./mockSkillApi";

export const AUTH_INVALIDATED_EVENT = "kocotree-auth-invalidated";

class IncrementalSkillApi extends MockSkillApi {
  private readonly auth = new DesktopAuthApi();
  private readonly catalog = new HttpCatalogApi(
    new AuthenticatedHttpClient(
      () => this.auth.getAccessToken(),
      () => {
        this.auth.invalidateSession();
        this.setCurrentUser(null);
        window.dispatchEvent(new Event(AUTH_INVALIDATED_EVENT));
      },
    ),
  );

  override listTags(query?: string) {
    return this.catalog.listTags(query);
  }

  override listSkills(query: ListSkillsQuery = {}) {
    return this.catalog.listSkills(query);
  }

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
