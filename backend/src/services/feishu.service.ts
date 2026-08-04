import { config } from "../config";

export type FeishuUser = {
  feishuOpenId: string;
  feishuUnionId?: string | null;
  name: string;
  email?: string | null;
  avatarUrl?: string | null;
  departmentPath?: string[];
  isCompanyUser: boolean;
};

const FEISHU_USER_SCOPES = [
  "contact:contact.base:readonly",
  "contact:user.department:readonly",
  "contact:user.department_path:readonly",
].join(" ");

type FeishuTokenResponse = {
  code?: number;
  msg?: string;
  data?: {
    access_token?: string;
  };
  access_token?: string;
};

type FeishuUserInfoResponse = {
  code?: number;
  msg?: string;
  data?: {
    name?: string;
    en_name?: string;
    avatar_url?: string;
    avatar_thumb?: string;
    avatar_middle?: string;
    avatar_big?: string;
    open_id?: string;
    union_id?: string;
    email?: string;
    enterprise_email?: string;
  };
};

type FeishuDepartmentPathName = {
  name?: string;
  i18n_name?: {
    zh_cn?: string;
    en_us?: string;
    ja_jp?: string;
  };
};

type FeishuContactUserResponse = {
  code?: number;
  msg?: string;
  data?: {
    user?: {
      orders?: Array<{
        department_id?: string;
        is_primary_dept?: boolean;
      }>;
      department_path?: Array<{
        department_id?: string;
        department_name?: FeishuDepartmentPathName;
        department_path?: {
          department_ids?: string[];
          department_path_name?: FeishuDepartmentPathName;
        };
      }>;
    };
  };
};

async function feishuFetch<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Feishu request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function readDepartmentName(value?: FeishuDepartmentPathName): string {
  return (
    value?.name ||
    value?.i18n_name?.zh_cn ||
    value?.i18n_name?.en_us ||
    value?.i18n_name?.ja_jp ||
    ""
  ).trim();
}

function splitDepartmentPath(value: string): string[] {
  return value
    .split(/\s*[\\/／>＞]\s*/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function resolvePrimaryDepartmentPath(
  user?: NonNullable<FeishuContactUserResponse["data"]>["user"],
): string[] {
  const departmentDetails = user?.department_path || [];
  const primaryDepartmentId = user?.orders?.find(
    (order) => order.is_primary_dept,
  )?.department_id;
  const primaryDepartment =
    departmentDetails.find(
      (department) => department.department_id === primaryDepartmentId,
    ) || departmentDetails[0];
  if (!primaryDepartment) return [];

  const pathName = readDepartmentName(
    primaryDepartment.department_path?.department_path_name,
  );
  const path = splitDepartmentPath(pathName);
  if (path.length > 0) return path;

  const departmentName = readDepartmentName(
    primaryDepartment.department_name,
  );
  return departmentName ? [departmentName] : [];
}

async function getDepartmentPath(
  accessToken: string,
  openId: string,
): Promise<string[]> {
  const url = new URL(
    `https://open.feishu.cn/open-apis/contact/v3/users/${encodeURIComponent(openId)}`,
  );
  url.searchParams.set("user_id_type", "open_id");
  url.searchParams.set("department_id_type", "open_department_id");
  const response = await feishuFetch<FeishuContactUserResponse>(
    url.toString(),
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );
  if (response.code && response.code !== 0) {
    throw new Error(response.msg || "Feishu department lookup failed");
  }
  return resolvePrimaryDepartmentPath(response.data?.user);
}

export const feishuService = {
  buildAuthorizeUrl(state: string): string {
    const url = new URL(
      "https://open.feishu.cn/open-apis/authen/v1/authorize",
    );
    url.searchParams.set("app_id", config.feishuAppId);
    url.searchParams.set("redirect_uri", config.feishuRedirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("scope", FEISHU_USER_SCOPES);
    return url.toString();
  },

  async getUserInfo(code: string): Promise<FeishuUser> {
    const tokenResponse = await feishuFetch<FeishuTokenResponse>(
      "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: config.feishuAppId,
          client_secret: config.feishuAppSecret,
          code,
          redirect_uri: config.feishuRedirectUri,
        }),
      },
    );

    const accessToken =
      tokenResponse.data?.access_token || tokenResponse.access_token;
    if (!accessToken) {
      throw new Error(tokenResponse.msg || "Feishu access token missing");
    }

    const userInfoResponse = await feishuFetch<FeishuUserInfoResponse>(
      "https://open.feishu.cn/open-apis/authen/v1/user_info",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );
    const user = userInfoResponse.data;
    if (!user?.open_id) {
      throw new Error(
        userInfoResponse.msg || "Feishu user open_id missing",
      );
    }

    let departmentPath: string[] | undefined;
    try {
      departmentPath = await getDepartmentPath(
        accessToken,
        user.open_id,
      );
    } catch (error) {
      console.warn(
        "Feishu department sync failed; continuing without department information",
        error instanceof Error ? error.message : error,
      );
    }

    return {
      feishuOpenId: user.open_id,
      feishuUnionId: user.union_id,
      name: user.name || user.en_name || user.email || "Feishu user",
      email: user.email || user.enterprise_email,
      avatarUrl:
        user.avatar_url ||
        user.avatar_big ||
        user.avatar_middle ||
        user.avatar_thumb,
      departmentPath,
      isCompanyUser: true,
    };
  },
};
