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
    oauthStateTtlSeconds: readNumber("OAUTH_STATE_TTL_SECONDS", 300),
    desktopAuthCodeTtlSeconds: readNumber(
        "DESKTOP_AUTH_CODE_TTL_SECONDS",
        300,
    ),
    desktopTokenTtlSeconds: readNumber(
        "DESKTOP_TOKEN_TTL_SECONDS",
        60 * 60 * 24 * 30,
    ),
    storageDriver: process.env.STORAGE_DRIVER || "aliyun-oss",
    ossRegion: process.env.OSS_REGION || "oss-cn-hangzhou",
    ossBucket: process.env.OSS_BUCKET || "kocotree-skill-storage",
    ossEndpoint:
        process.env.OSS_ENDPOINT || "oss-cn-hangzhou.aliyuncs.com",
    ossAccessKeyId: process.env.OSS_ACCESS_KEY_ID || "",
    ossAccessKeySecret: process.env.OSS_ACCESS_KEY_SECRET || "",
    ossSignedUrlExpiresSeconds: readNumber(
        "OSS_SIGNED_URL_EXPIRES_SECONDS",
        300,
    ),
    skillPreviewTextMaxKb: readNumber(
        "SKILL_PREVIEW_TEXT_MAX_KB",
        1024,
    ),
    skillUploadMaxMb: readNumber("SKILL_UPLOAD_MAX_MB", 50),
    deepseekApiKey: process.env.DEEPSEEK_API_KEY || "",
    deepseekApiBaseUrl:
        process.env.DEEPSEEK_API_BASE_URL || "https://api.deepseek.com",
    deepseekTranslationModel:
        process.env.DEEPSEEK_TRANSLATION_MODEL || "deepseek-v4-flash",
    deepseekTranslationTimeoutMs: readNumber(
        "DEEPSEEK_TRANSLATION_TIMEOUT_MS",
        8_000,
    ),
};
