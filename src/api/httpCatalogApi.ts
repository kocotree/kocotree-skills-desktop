import type {
  FileEntryDto,
  ListSkillsQuery,
  ListVersionsQuery,
  SkillDetailDto,
  SkillFileContentDto,
  SkillPageDto,
  TagDto,
  VersionPageDto,
} from "./contracts";
import type { AuthenticatedHttpClient } from "./httpClient";

function queryString(
  values: Record<string, string | number | undefined>,
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

/** 已迁移到真实后端的 Skill 浏览、详情、版本和文件接口。 */
export class HttpCatalogApi {
  constructor(private readonly http: AuthenticatedHttpClient) {}

  listTags(query?: string): Promise<TagDto[]> {
    return this.http.request<TagDto[]>(
      `/api/tags${queryString({ query: query?.trim() || undefined })}`,
    );
  }

  listSkills(query: ListSkillsQuery = {}): Promise<SkillPageDto> {
    return this.http.request<SkillPageDto>(
      `/api/skills${queryString({
        query: query.query,
        tagId: query.tagId,
        sort: query.sort,
        page: query.page,
        pageSize: query.pageSize,
      })}`,
    );
  }

  getSkill(skillId: string): Promise<SkillDetailDto> {
    return this.http.request<SkillDetailDto>(
      `/api/skills/${encodeURIComponent(skillId)}`,
    );
  }

  listSkillVersions(
    skillId: string,
    query: ListVersionsQuery = {},
  ): Promise<VersionPageDto> {
    return this.http.request<VersionPageDto>(
      `/api/skills/${encodeURIComponent(skillId)}/versions${queryString({
        page: query.page,
        pageSize: query.pageSize,
      })}`,
    );
  }

  listVersionFiles(
    skillId: string,
    versionId: string,
  ): Promise<FileEntryDto[]> {
    return this.http.request<FileEntryDto[]>(
      `/api/skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(versionId)}/files`,
    );
  }

  getVersionFileContent(
    skillId: string,
    versionId: string,
    path: string,
  ): Promise<SkillFileContentDto> {
    return this.http.request<SkillFileContentDto>(
      `/api/skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(versionId)}/files/content${queryString({
        path,
      })}`,
    );
  }
}
