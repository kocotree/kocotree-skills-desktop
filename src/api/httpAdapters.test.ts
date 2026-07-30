import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedHttpClient } from "./httpClient";
import { HttpCatalogApi } from "./httpCatalogApi";
import { HttpInstallationApi } from "./httpInstallationApi";
import { HttpNotificationApi } from "./httpNotificationApi";
import { HttpSkillApi } from "./httpSkillApi";
import { localSkillService, skillApi } from "./index";
import { TauriInstaller } from "./tauriInstaller";

function createHttpStub() {
  const request = vi.fn().mockResolvedValue({});
  return {
    request,
    client: { request } as unknown as AuthenticatedHttpClient,
  };
}

describe("真实 HTTP API 适配器", () => {
  it("运行时组合入口不注入 Mock 实现", () => {
    expect(skillApi).toBeInstanceOf(HttpSkillApi);
    expect(localSkillService).toBeInstanceOf(TauriInstaller);
  });

  it("通过真实目录接口读取指定版本详情", async () => {
    const { client, request } = createHttpStub();
    const api = new HttpCatalogApi(client);

    await api.getSkillVersion("skill/id", "version/id");

    expect(request).toHaveBeenCalledWith(
      "/api/skills/skill%2Fid/versions/version%2Fid",
    );
  });

  it("通过真实安装接口查询状态并恢复关联", async () => {
    const { client, request } = createHttpStub();
    const api = new HttpInstallationApi(client);

    await api.getInstallationStatus("skill/id", "version/id");
    await api.resolveInstallation({
      skillName: "real-skill",
      contentHash: "sha256:real",
    });

    expect(request).toHaveBeenNthCalledWith(
      1,
      "/api/skills/skill%2Fid/installation-status?versionId=version%2Fid",
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/api/installations/resolve",
      {
        method: "POST",
        body: JSON.stringify({
          skillName: "real-skill",
          contentHash: "sha256:real",
        }),
      },
    );
  });

  it("通过真实通知接口读取并更新通知", async () => {
    const { client, request } = createHttpStub();
    const api = new HttpNotificationApi(client);

    await api.listNotifications({
      unreadOnly: true,
      page: 2,
      pageSize: 10,
    });
    await api.readNotification("notification/id");
    await api.readAllNotifications();

    expect(request).toHaveBeenNthCalledWith(
      1,
      "/api/notifications?unreadOnly=true&page=2&pageSize=10",
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "/api/notifications/notification%2Fid/read",
      { method: "POST" },
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      "/api/notifications/read-all",
      { method: "POST" },
    );
  });
});
