import type {
  ListNotificationsQuery,
  NotificationPageDto,
} from "./contracts";
import type { AuthenticatedHttpClient } from "./httpClient";

function queryString(
  values: Record<string, string | number | boolean | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) {
      params.set(name, String(value));
    }
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** 真实后端的站内通知接口。 */
export class HttpNotificationApi {
  constructor(private readonly http: AuthenticatedHttpClient) {}

  listNotifications(
    query: ListNotificationsQuery = {},
  ): Promise<NotificationPageDto> {
    return this.http.request<NotificationPageDto>(
      `/api/notifications${queryString({
        unreadOnly: query.unreadOnly,
        page: query.page,
        pageSize: query.pageSize,
      })}`,
    );
  }

  async readNotification(notificationId: string): Promise<void> {
    await this.http.request<Record<string, never>>(
      `/api/notifications/${encodeURIComponent(notificationId)}/read`,
      { method: "POST" },
    );
  }

  async readAllNotifications(): Promise<void> {
    await this.http.request<Record<string, never>>(
      "/api/notifications/read-all",
      { method: "POST" },
    );
  }
}
