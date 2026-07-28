import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SkillApiError, type UserDto } from "./contracts";
import { apiUrl, readApiData } from "./httpClient";
const CALLBACK_SCHEME = "kocotree-skills:";
const CALLBACK_HOST = "auth";
const CUSTOM_CALLBACK_PATH = "/callback";
const LOOPBACK_CALLBACK_PATH = "/auth/callback";
const TOKEN_STORAGE_KEY = "kocotree.desktop.session-token";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const AUTH_STATUS_TIMEOUT_MS = 15_000;

interface ExchangeResult {
  user: UserDto;
  token: string;
  expiresAt: string;
}

interface DesktopAuthCallback {
  callbackUrl: string;
}

interface PendingLogin {
  promise: Promise<UserDto>;
  resolve: (user: UserDto) => void;
  reject: (reason: unknown) => void;
  timeoutId: number;
}

/** Tauri 桌面端飞书 OAuth 身份适配器。 */
export class DesktopAuthApi {
  private token = sessionStorage.getItem(TOKEN_STORAGE_KEY);
  private initializePromise: Promise<void> | null = null;
  private currentUserPromise: Promise<UserDto | null> | null = null;
  private pendingLogin: PendingLogin | null = null;
  private readonly processedCodes = new Set<string>();

  private initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = this.initializeDeepLinks();
    }
    return this.initializePromise;
  }

  private async initializeDeepLinks(): Promise<void> {
    await listen<string>("desktop-auth-callback", (event) => {
      void this.handleDeepLinks([event.payload]);
    });
    await onOpenUrl((urls) => {
      void this.handleDeepLinks(urls);
    });
    const currentUrls = await getCurrent();
    if (currentUrls) {
      await this.handleDeepLinks(currentUrls);
    }
  }

  private async handleDeepLinks(urls: string[]): Promise<void> {
    for (const rawUrl of urls) {
      const url = this.parseCallbackUrl(rawUrl);
      if (!url) {
        continue;
      }

      const error = url.searchParams.get("error");
      if (error) {
        this.rejectPending(
          new SkillApiError("FEISHU_AUTH_FAILED", error),
        );
        continue;
      }

      const code = url.searchParams.get("code");
      if (!code || this.processedCodes.has(code)) {
        continue;
      }
      this.processedCodes.add(code);

      try {
        const user = await this.exchangeCode(code);
        this.resolvePending(user);
      } catch (reason) {
        this.rejectPending(reason);
      }
    }
  }

  private parseCallbackUrl(rawUrl: string): URL | null {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return null;
    }

    const isCustomProtocol =
      url.protocol === CALLBACK_SCHEME &&
      url.hostname === CALLBACK_HOST &&
      url.pathname === CUSTOM_CALLBACK_PATH;
    const isDevelopmentLoopback =
      import.meta.env.DEV &&
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.pathname === LOOPBACK_CALLBACK_PATH;
    return isCustomProtocol || isDevelopmentLoopback ? url : null;
  }

  private async exchangeCode(code: string): Promise<UserDto> {
    const response = await fetch(apiUrl("/api/auth/desktop/exchange"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code }),
    });
    const result = await readApiData<ExchangeResult>(response);
    this.token = result.token;
    sessionStorage.setItem(TOKEN_STORAGE_KEY, result.token);
    return result.user;
  }

  private resolvePending(user: UserDto): void {
    const pending = this.takePendingLogin();
    pending?.resolve(user);
  }

  private rejectPending(reason: unknown): void {
    const pending = this.takePendingLogin();
    pending?.reject(reason);
  }

  private takePendingLogin(): PendingLogin | null {
    const pending = this.pendingLogin;
    if (!pending) return null;
    window.clearTimeout(pending.timeoutId);
    this.pendingLogin = null;
    return pending;
  }

  getCurrentUser(): Promise<UserDto | null> {
    if (!this.currentUserPromise) {
      const request = this.loadCurrentUser();
      this.currentUserPromise = request;
      const clearPendingRequest = () => {
        if (this.currentUserPromise === request) {
          this.currentUserPromise = null;
        }
      };
      void request.then(clearPendingRequest, clearPendingRequest);
    }
    return this.currentUserPromise;
  }

  private async loadCurrentUser(): Promise<UserDto | null> {
    const initialization = this.initialize();
    if (!this.token) {
      await initialization;
      if (!this.token) return null;
    }
    const token = this.token;
    if (!token) return null;

    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(
      () => controller.abort(),
      AUTH_STATUS_TIMEOUT_MS,
    );
    let response: Response;
    try {
      const responsePromise = fetch(apiUrl("/api/users/me"), {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      });
      [, response] = await Promise.all([
        initialization,
        responsePromise,
      ]);
    } catch (reason) {
      if (controller.signal.aborted) {
        throw new SkillApiError(
          "REQUEST_TIMEOUT",
          "登录状态加载超时，请稍后重试",
        );
      }
      throw reason;
    } finally {
      globalThis.clearTimeout(timeoutId);
    }
    if (response.status === 401) {
      this.clearToken();
      return null;
    }
    return readApiData<UserDto>(response);
  }

  async signIn(): Promise<UserDto> {
    await this.initialize();
    if (this.pendingLogin) {
      return this.pendingLogin.promise;
    }

    let resolveLogin!: (user: UserDto) => void;
    let rejectLogin!: (reason: unknown) => void;
    const promise = new Promise<UserDto>((resolve, reject) => {
      resolveLogin = resolve;
      rejectLogin = reject;
    });
    const timeoutId = window.setTimeout(() => {
      this.rejectPending(
        new SkillApiError(
          "FEISHU_AUTH_TIMEOUT",
          "飞书授权等待超时，请重新登录",
        ),
      );
    }, LOGIN_TIMEOUT_MS);
    this.pendingLogin = {
      promise,
      resolve: resolveLogin,
      reject: rejectLogin,
      timeoutId,
    };

    try {
      const loginUrl = new URL(apiUrl("/api/auth/feishu/login"));
      if (import.meta.env.DEV) {
        const callback = await invoke<DesktopAuthCallback>(
          "begin_desktop_auth_callback",
        );
        loginUrl.searchParams.set(
          "desktopCallbackUrl",
          callback.callbackUrl,
        );
      }
      await openUrl(loginUrl);
    } catch (reason) {
      this.rejectPending(reason);
    }
    return promise;
  }

  async signOut(): Promise<void> {
    await this.initialize();
    const token = this.token;
    try {
      if (token) {
        const response = await fetch(apiUrl("/api/auth/logout"), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        if (!response.ok && response.status !== 401) {
          await readApiData<Record<string, never>>(response);
        }
      }
    } finally {
      this.clearToken();
    }
  }

  getAccessToken(): string | null {
    return this.token;
  }

  invalidateSession(): void {
    this.clearToken();
  }

  private clearToken(): void {
    this.token = null;
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}
