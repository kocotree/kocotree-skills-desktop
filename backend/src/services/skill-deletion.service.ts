import { skillDeletionRepository } from "../repositories/skill-deletion.repository";
import { catalogEventService } from "./catalog-event.service";
import { storageService } from "./storage.service";

export const skillDeletionService = {
  async deleteOwnedSkill(skillId: string, userId: string) {
    const result = await skillDeletionRepository.deleteOwnedSkill(
      skillId,
      userId,
    );
    if (result.status !== "DELETED") return result;
    catalogEventService.publish("skill.deleted", skillId);

    const cleanupResults = await Promise.allSettled(
      result.objectKeys.map(({ objectKey, bucket }) =>
        storageService.deleteObject(objectKey, bucket),
      ),
    );
    return {
      status: "DELETED" as const,
      deletedObjectCount: cleanupResults.filter(
        (item) => item.status === "fulfilled",
      ).length,
      objectCount: cleanupResults.length,
      ossCleaned: cleanupResults.every(
        (item) => item.status === "fulfilled",
      ),
    };
  },
};
