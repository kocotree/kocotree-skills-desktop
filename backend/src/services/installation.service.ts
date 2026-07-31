import { config } from "../config";
import { installationRepository } from "../repositories/installation.repository";
import {
  computeVersionContentHash,
  normalizeSha256,
} from "./skill-version-hash";
import { storageService } from "./storage.service";

export type DownloadTicketResult =
  | {
      status: "OK";
      data: {
        url: string;
        expiresAt: string;
        packageSha256: string;
        contentHash: string;
      };
    }
  | {
      status: "VERSION_NOT_FOUND";
    }
  | {
      status: "INSTALLATION_UNAVAILABLE";
    };

export const installationService = {
  async createDownloadTicket(
    skillId: string,
    versionId: string,
  ): Promise<DownloadTicketResult> {
    const version =
      await installationRepository.getVersionForDownload(
        skillId,
        versionId,
      );
    if (!version) {
      return { status: "VERSION_NOT_FOUND" };
    }
    if (
      version.status !== "PUBLISHED" ||
      version.skill.status !== "PUBLISHED"
    ) {
      return { status: "INSTALLATION_UNAVAILABLE" };
    }

    const expiresSeconds = config.ossSignedUrlExpiresSeconds;
    const url = storageService.createSignedDownloadUrl(
      version.ossObjectKey,
      expiresSeconds,
      version.ossBucket,
    );
    return {
      status: "OK",
      data: {
        url,
        expiresAt: new Date(
          Date.now() + expiresSeconds * 1_000,
        ).toISOString(),
        packageSha256: normalizeSha256(
          version.checksumSha256,
        ),
        contentHash: computeVersionContentHash(version.files),
      },
    };
  },

  recordInstallation(input: {
    eventId: string;
    userId: string;
    skillId: string;
    versionId: string;
    installedAt: Date;
  }) {
    return installationRepository.recordInstallation(input);
  },
};
