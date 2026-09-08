import type {
  CatalogEventListener,
  CreateSkillDto,
  InstallationEventDto,
  ListMySkillsQuery,
  ListNotificationsQuery,
  ListSkillsQuery,
  ListVersionsQuery,
  PublishSkillVersionDto,
  ResolveInstallationDto,
  SkillApi,
  SignInOptions,
  UpdateSkillMetadataDto,
} from "./contracts";
import { CatalogEventStream } from "./catalogEventStream";
import { DesktopAuthApi } from "./desktopAuthApi";
import { HttpCatalogApi } from "./httpCatalogApi";
import { AuthenticatedHttpClient } from "./httpClient";
import { HttpInstallationApi } from "./httpInstallationApi";
import { HttpMySkillsApi } from "./httpMySkillsApi";
import { HttpNotificationApi } from "./httpNotificationApi";
import { HttpPublishingApi } from "./httpPublishingApi";

export const AUTH_INVALIDATED_EVENT = "kocotree-auth-invalidated";

/** 运行时 Skill API；所有业务数据均来自真实 HTTP 接口。 */
export class HttpSkillApi implements SkillApi {
  private readonly auth = new DesktopAuthApi();
  private readonly http = new AuthenticatedHttpClient(
    () => this.auth.getAccessToken(),
    () => {
      this.auth.invalidateSession();
      window.dispatchEvent(new Event(AUTH_INVALIDATED_EVENT));
    },
  );
  private readonly catalog = new HttpCatalogApi(this.http);
  private readonly installation = new HttpInstallationApi(this.http);
  private readonly mySkills = new HttpMySkillsApi(this.http);
  private readonly notifications = new HttpNotificationApi(this.http);
  private readonly publishing = new HttpPublishingApi(this.http);
  private readonly catalogEvents = new CatalogEventStream(
    () => this.auth.getAccessToken(),
    () => {
      this.auth.invalidateSession();
      window.dispatchEvent(new Event(AUTH_INVALIDATED_EVENT));
    },
  );

  subscribeCatalogEvents(listener: CatalogEventListener) {
    return this.catalogEvents.subscribe(listener);
  }

  listTags(query?: string) {
    return this.catalog.listTags(query);
  }

  listSkills(query: ListSkillsQuery = {}) {
    return this.catalog.listSkills(query);
  }

  listPublishedSkillDepartments() {
    return this.catalog.listPublishedSkillDepartments();
  }

  listBusinessScenarios() {
    return this.catalog.listBusinessScenarios();
  }

  listMySkills(query: ListMySkillsQuery) {
    return this.mySkills.listMySkills(query);
  }

  resolvePublishTarget(skillName: string) {
    return this.mySkills.resolvePublishTarget(skillName);
  }

  getSkill(skillId: string) {
    return this.catalog.getSkill(skillId);
  }

  listSkillVersions(skillId: string, query: ListVersionsQuery = {}) {
    return this.catalog.listSkillVersions(skillId, query);
  }

  getSkillVersion(skillId: string, versionId: string) {
    return this.catalog.getSkillVersion(skillId, versionId);
  }

  listVersionFiles(skillId: string, versionId: string) {
    return this.catalog.listVersionFiles(skillId, versionId);
  }

  getVersionFileContent(
    skillId: string,
    versionId: string,
    path: string,
  ) {
    return this.catalog.getVersionFileContent(skillId, versionId, path);
  }

  getInstallationStatus(skillId: string, versionId?: string) {
    return this.installation.getInstallationStatus(skillId, versionId);
  }

  getDownloadTicket(skillId: string, versionId: string) {
    return this.installation.getDownloadTicket(skillId, versionId);
  }

  resolveInstallation(input: ResolveInstallationDto) {
    return this.installation.resolveInstallation(input);
  }

  recordInstallation(event: InstallationEventDto) {
    return this.installation.recordInstallation(event);
  }

  createSkill(input: CreateSkillDto) {
    return this.publishing.createSkill(input);
  }

  translateSkillMetadata(input: {
    skillName: string;
    skillDescription: string;
  }) {
    return this.publishing.translateSkillMetadata(input);
  }
  suggestBusinessScenarios(content: string) { return this.publishing.suggestBusinessScenarios(content); }

  publishSkillVersion(skillId: string, input: PublishSkillVersionDto) {
    return this.publishing.publishSkillVersion(skillId, input);
  }

  updateSkillMetadata(skillId: string, input: UpdateSkillMetadataDto) {
    return this.publishing.updateSkillMetadata(skillId, input);
  }

  deleteSkill(skillId: string) {
    return this.mySkills.deleteSkill(skillId);
  }

  deleteSkillVersion(skillId: string, versionId: string) {
    return this.mySkills.deleteSkillVersion(skillId, versionId);
  }

  listNotifications(query: ListNotificationsQuery = {}) {
    return this.notifications.listNotifications(query);
  }

  readNotification(notificationId: string) {
    return this.notifications.readNotification(notificationId);
  }

  readAllNotifications() {
    return this.notifications.readAllNotifications();
  }

  getCurrentUser() {
    return this.auth.getCurrentUser();
  }

  signIn(options?: SignInOptions) {
    return this.auth.signIn(options);
  }

  cancelSignIn() {
    this.auth.cancelSignIn();
  }

  signOut() {
    return this.auth.signOut();
  }
}
