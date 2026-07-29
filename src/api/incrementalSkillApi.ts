import { isTauri } from "@tauri-apps/api/core";
import type {
  InstallationEventDto,
  CreateSkillDto,
  ListMySkillsQuery,
  ListSkillsQuery,
  ListVersionsQuery,
  PublishSkillVersionDto,
  SkillApi,
  UpdateSkillMetadataDto,
} from "./contracts";
import { DesktopAuthApi } from "./desktopAuthApi";
import { HttpCatalogApi } from "./httpCatalogApi";
import { AuthenticatedHttpClient } from "./httpClient";
import { HttpInstallationApi } from "./httpInstallationApi";
import { HttpMySkillsApi } from "./httpMySkillsApi";
import { HttpPublishingApi } from "./httpPublishingApi";
import { MockSkillApi } from "./mockSkillApi";

export const AUTH_INVALIDATED_EVENT = "kocotree-auth-invalidated";

class IncrementalSkillApi extends MockSkillApi {
  private readonly auth = new DesktopAuthApi();
  private readonly http = new AuthenticatedHttpClient(
    () => this.auth.getAccessToken(),
    () => {
      this.auth.invalidateSession();
      this.setCurrentUser(null);
      window.dispatchEvent(new Event(AUTH_INVALIDATED_EVENT));
    },
  );
  private readonly catalog = new HttpCatalogApi(this.http);
  private readonly installation = new HttpInstallationApi(
    this.http,
  );
  private readonly mySkills = new HttpMySkillsApi(this.http);
  private readonly publishing = new HttpPublishingApi(this.http);

  constructor() {
    // 桌面端尚未迁移的能力不应继续叠加演示用网络延迟。
    super({ delayMs: 0 });
  }

  override listTags(query?: string) {
    return this.catalog.listTags(query);
  }

  override listSkills(query: ListSkillsQuery = {}) {
    return this.catalog.listSkills(query);
  }

  override listMySkills(query: ListMySkillsQuery) {
    return this.mySkills.listMySkills(query);
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

  override getDownloadTicket(skillId: string, versionId: string) {
    return this.installation.getDownloadTicket(skillId, versionId);
  }

  override recordInstallation(event: InstallationEventDto) {
    return this.installation.recordInstallation(event);
  }

  override createSkill(input: CreateSkillDto) {
    return this.publishing.createSkill(input);
  }

  override publishSkillVersion(
    skillId: string,
    input: PublishSkillVersionDto,
  ) {
    return this.publishing.publishSkillVersion(skillId, input);
  }

  override updateSkillMetadata(
    skillId: string,
    input: UpdateSkillMetadataDto,
  ) {
    return this.publishing.updateSkillMetadata(skillId, input);
  }

  override deleteSkill(skillId: string) {
    return this.mySkills.deleteSkill(skillId);
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
