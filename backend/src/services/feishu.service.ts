import { config } from "../config";

export type FeishuUser = {
  feishuOpenId: string;
  feishuUnionId?: string | null;
  name: string;
  email?: string | null;
  avatarUrl?: string | null;
  isCompanyUser: boolean;
};

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

async function feishuFetch<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Feishu request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const feishuService = {
  buildAuthorizeUrl(state: string): string {
    const url = new URL(
      "https://open.feishu.cn/open-apis/authen/v1/authorize",
    );
    url.searchParams.set("app_id", config.feishuAppId);
    url.searchParams.set("redirect_uri", config.feishuRedirectUri);
    url.searchParams.set("state", state);
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
      isCompanyUser: true,
    };
  },
};
