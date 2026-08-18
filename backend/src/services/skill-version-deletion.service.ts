import { skillVersionDeletionRepository } from "../repositories/skill-version-deletion.repository";
import { catalogEventService } from "./catalog-event.service";
import { storageService } from "./storage.service";

export const skillVersionDeletionService = {
  async deleteOwnedSkillVersion(
    skillId: string,
    versionId: string,
    userId: string,
  ) {
    const result =
      await skillVersionDeletionRepository.deleteOwnedSkillVersion(
        skillId,
        versionId,
        userId,
      );
    if (result.status !== "DELETED") return result;
    catalogEventService.publish("skill.updated", skillId);

    try {
      await storageService.deleteObject(
        result.objectKey,
        result.bucket,
      );
      return {
        status: "DELETED" as const,
        versionId: result.versionId,
        latestVersionId: result.latestVersionId,
        ossCleaned: true,
      };
    } catch {
      return {
        status: "DELETED" as const,
        versionId: result.versionId,
        latestVersionId: result.latestVersionId,
        ossCleaned: false,
      };
    }
  },
};
