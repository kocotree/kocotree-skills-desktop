import { isTauri } from "@tauri-apps/api/core";
import type {
  ListSkillsQuery,
  ListVersionsQuery,
  SkillApi,
} from "./contracts";
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

  override getSkill(skillId: string) {
    return this.catalog.getSkill(skillId);
  }

  override listSkillVersions(
    skillId: string,
    query: ListVersionsQuery = {},
  ) {
    return this.catalog.listSkillVersions(skillId, query);
  }

  override listVersionFiles(skillId: string, versionId: string) {
    return this.catalog.listVersionFiles(skillId, versionId);
  }

  override getVersionFileContent(
    skillId: string,
    versionId: string,
    path: string,
  ) {
    return this.catalog.getVersionFileContent(
      skillId,
      versionId,
      path,
    );
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
 * Tauri 环境使用已迁移的真实接口，尚未迁移的业务能力继续由 Mock 提供。
 */
export function createIncrementalSkillApi(): SkillApi {
  return isTauri() ? new IncrementalSkillApi() : new MockSkillApi();
}
