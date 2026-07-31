import type {
  CreateSkillDto,
  PublishSkillVersionDto,
  SkillDetailDto,
  UpdateSkillMetadataDto,
} from "./contracts";
import { AuthenticatedHttpClient } from "./httpClient";

function appendValues(
  formData: FormData,
  name: string,
  values?: string[],
): void {
  for (const value of values || []) {
    formData.append(name, value);
  }
}

function appendOptional(
  formData: FormData,
  name: string,
  value?: string,
): void {
  if (value !== undefined) {
    formData.append(name, value);
  }
}

export class HttpPublishingApi {
  constructor(private readonly http: AuthenticatedHttpClient) {}

  createSkill(input: CreateSkillDto): Promise<SkillDetailDto> {
    const formData = new FormData();
    formData.append("file", input.file, input.file.name);
    formData.append("displayName", input.displayName);
    formData.append(
      "displayDescription",
      input.displayDescription,
    );
    appendOptional(formData, "changelog", input.changelog);
    appendValues(formData, "tagIds", input.tagIds);
    appendValues(formData, "newTagNames", input.newTagNames);
    appendOptional(
      formData,
      "forkedFromSkillId",
      input.forkedFromSkillId,
    );
    appendOptional(
      formData,
      "forkedFromVersionId",
      input.forkedFromVersionId,
    );
    if (input.confirmDuplicateDisplayName) {
      formData.append("confirmDuplicateDisplayName", "true");
    }
    return this.http.request<SkillDetailDto>("/api/skills", {
      method: "POST",
      body: formData,
    });
  }

  publishSkillVersion(
    skillId: string,
    input: PublishSkillVersionDto,
  ): Promise<SkillDetailDto> {
    const formData = new FormData();
    formData.append("file", input.file, input.file.name);
    formData.append("baseVersionId", input.baseVersionId);
    formData.append("version", input.version);
    formData.append("changelog", input.changelog);
    appendOptional(formData, "displayName", input.displayName);
    appendOptional(
      formData,
      "displayDescription",
      input.displayDescription,
    );
    if (
      input.tagIds !== undefined ||
      input.newTagNames !== undefined
    ) {
      formData.append("replaceTags", "true");
      appendValues(formData, "tagIds", input.tagIds);
      appendValues(formData, "newTagNames", input.newTagNames);
    }
    if (input.confirmDuplicateDisplayName) {
      formData.append("confirmDuplicateDisplayName", "true");
    }
    return this.http.request<SkillDetailDto>(
      `/api/skills/${encodeURIComponent(skillId)}/versions`,
      {
        method: "POST",
        body: formData,
      },
    );
  }

  updateSkillMetadata(
    skillId: string,
    input: UpdateSkillMetadataDto,
  ): Promise<SkillDetailDto> {
    const payload: UpdateSkillMetadataDto = {
      ...input,
      tagIds:
        input.tagIds && input.tagIds.length > 0
          ? input.tagIds
          : undefined,
      newTagNames:
        input.newTagNames && input.newTagNames.length > 0
          ? input.newTagNames
          : undefined,
    };
    return this.http.request<SkillDetailDto>(
      `/api/skills/${encodeURIComponent(skillId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(payload),
      },
    );
  }
}
