import { SkillApiError } from "./contracts";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ??
  (import.meta.env.DEV ? "http://localhost:4000" : "");

interface ApiResponse<T> {
  code: number;
  data: T;
  msg: string;
}

interface ApiErrorResponse {
  code?: number;
  data?: {
    errorCode?: string;
    [key: string]: unknown;
  };
  msg?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function apiUrl(path: string): string {
  if (!API_BASE_URL) {
    throw new SkillApiError(
      "API_BASE_URL_MISSING",
      "正式构建缺少 VITE_API_BASE_URL",
    );
  }
  return `${API_BASE_URL.replace(/\/$/, "")}${path}`;
}

export async function readApiData<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const error = isRecord(payload) ? (payload as ApiErrorResponse) : null;
    throw new SkillApiError(
      error?.data?.errorCode || `HTTP_${response.status}`,
      error?.msg || `请求失败：${response.status}`,
      error?.data,
    );
  }
  if (
    !isRecord(payload) ||
    typeof payload.code !== "number" ||
    typeof payload.msg !== "string" ||
    !("data" in payload)
  ) {
    throw new SkillApiError(
      "INVALID_API_RESPONSE",
      "服务端返回了无法识别的响应",
    );
  }
  return (payload as unknown as ApiResponse<T>).data;
}

/** 为所有业务接口统一附加登录 Token、请求头和错误处理。 */
export class AuthenticatedHttpClient {
  constructor(
    private readonly getAccessToken: () => string | null,
    private readonly onUnauthorized: () => void,
  ) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = this.getAccessToken();
    if (!token) {
      this.onUnauthorized();
      throw new SkillApiError("UNAUTHENTICATED", "请先登录");
    }

    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const isFormData =
      typeof FormData !== "undefined" && init.body instanceof FormData;
    if (init.body != null && !isFormData && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const response = await fetch(apiUrl(path), {
      ...init,
      headers,
    });
    if (response.status === 401) {
      this.onUnauthorized();
    }
    return readApiData<T>(response);
  }
}
