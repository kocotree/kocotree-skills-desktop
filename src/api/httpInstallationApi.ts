import {
  SkillApiError,
  type DownloadTicketDto,
  type InstallationEventDto,
} from "./contracts";
import type { AuthenticatedHttpClient } from "./httpClient";

const INSTALLATION_REPORT_RETRY_DELAYS_MS = [0, 250, 1_000];

function isRetryableReportError(reason: unknown): boolean {
  return (
    reason instanceof TypeError ||
    (reason instanceof SkillApiError &&
      (reason.code === "INSTALLATION_REPORT_UNAVAILABLE" ||
        /^HTTP_5\d\d$/.test(reason.code)))
  );
}

async function wait(milliseconds: number): Promise<void> {
  if (milliseconds > 0) {
    await new Promise((resolve) =>
      globalThis.setTimeout(resolve, milliseconds),
    );
  }
}

/** 已迁移到真实后端的 Skill 安装接口。 */
export class HttpInstallationApi {
  constructor(private readonly http: AuthenticatedHttpClient) {}

  getDownloadTicket(
    skillId: string,
    versionId: string,
  ): Promise<DownloadTicketDto> {
    return this.http.request<DownloadTicketDto>(
      `/api/skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(versionId)}/download-tickets`,
      {
        method: "POST",
      },
    );
  }

  async recordInstallation(
    event: InstallationEventDto,
  ): Promise<void> {
    for (
      let attempt = 0;
      attempt < INSTALLATION_REPORT_RETRY_DELAYS_MS.length;
      attempt += 1
    ) {
      await wait(INSTALLATION_REPORT_RETRY_DELAYS_MS[attempt]);
      try {
        await this.http.request<Record<string, never>>(
          "/api/installations/events",
          {
            method: "POST",
            body: JSON.stringify(event),
          },
        );
        return;
      } catch (reason) {
        const isLastAttempt =
          attempt ===
          INSTALLATION_REPORT_RETRY_DELAYS_MS.length - 1;
        if (isLastAttempt || !isRetryableReportError(reason)) {
          throw reason;
        }
      }
    }
  }
}
