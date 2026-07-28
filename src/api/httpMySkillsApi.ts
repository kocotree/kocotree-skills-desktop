import type {
  DeleteSkillResultDto,
  ListMySkillsQuery,
  SkillPageDto,
} from "./contracts";
import type { AuthenticatedHttpClient } from "./httpClient";

function queryString(
  values: Record<string, string | number | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) params.set(name, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export class HttpMySkillsApi {
  constructor(private readonly http: AuthenticatedHttpClient) {}

  listMySkills(
    query: ListMySkillsQuery,
  ): Promise<SkillPageDto> {
    return this.http.request<SkillPageDto>(
      `/api/users/me/skills${queryString({
        page: query.page,
        pageSize: query.pageSize,
      })}`,
    );
  }

  deleteSkill(skillId: string): Promise<DeleteSkillResultDto> {
    return this.http.request<DeleteSkillResultDto>(
      `/api/skills/${encodeURIComponent(skillId)}`,
      {
        method: "DELETE",
      },
    );
  }
}
