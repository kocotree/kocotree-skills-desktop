import "dotenv/config";

function readNumber(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const config = {
    port: readNumber("PORT", 4000),
    host: process.env.HOST || "0.0.0.0",
    frontendOrigins: (process.env.FRONTEND_ORIGINS ||
        "http://localhost:1420,tauri://localhost,http://tauri.localhost")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    feishuAppId: process.env.FEISHU_APP_ID || "",
    feishuAppSecret: process.env.FEISHU_APP_SECRET || "",
    feishuRedirectUri:
        process.env.FEISHU_REDIRECT_URI ||
        "http://localhost:4000/api/auth/feishu/callback",
    tokenSecret: process.env.TOKEN_SECRET || "local-dev-token-secret",
    desktopAuthCallbackUrl:
        process.env.DESKTOP_AUTH_CALLBACK_URL ||
        "kocotree-skills://auth/callback",
    oauthStateTtlSeconds: readNumber("OAUTH_STATE_TTL_SECONDS", 600),
    desktopAuthCodeTtlSeconds: readNumber(
        "DESKTOP_AUTH_CODE_TTL_SECONDS",
        120,
    ),
    desktopTokenTtlSeconds: readNumber(
        "DESKTOP_TOKEN_TTL_SECONDS",
        60 * 60 * 24 * 180,
    ),
};
