import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  SkillApiError,
  type SignInOptions,
  type UserDto,
} from "./contracts";
import { apiUrl, readApiData } from "./httpClient";
const CALLBACK_SCHEME = "kocotree-skills:";
const CALLBACK_HOST = "auth";
const CUSTOM_CALLBACK_PATH = "/callback";
const LOOPBACK_CALLBACK_PATH = "/auth/callback";
const SESSION_STORAGE_KEY = "kocotree.desktop.auth-session";
const LEGACY_TOKEN_STORAGE_KEY = "kocotree.desktop.session-token";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const AUTH_STATUS_TIMEOUT_MS = 15_000;

interface ExchangeResult {
  user: UserDto;
  token: string;
  expiresAt: string;
}

interface StoredDesktopSession {
  schemaVersion: 1;
  token: string;
  expiresAt: string | null;
}

interface DesktopAuthCallback {
  callbackUrl: string;
}

interface PendingLogin {
  attemptId: string;
  authorizationUrl: string | null;
  promise: Promise<UserDto>;
  resolve: (user: UserDto) => void;
  reject: (reason: unknown) => void;
  timeoutId: number;
}

function createLoginAttemptId(): string {
  const values = new Uint32Array(4);
  globalThis.crypto.getRandomValues(values);
  return Array.from(
    values,
    (value) => value.toString(16).padStart(8, "0"),
  ).join("");
}

function sessionIsExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const timestamp = Date.parse(expiresAt);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function clearStoredSession(): void {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    localStorage.removeItem(LEGACY_TOKEN_STORAGE_KEY);
  } catch {
    // WebView 禁用持久存储时仍允许当前会话继续运行。
  }
  try {
    sessionStorage.removeItem(LEGACY_TOKEN_STORAGE_KEY);
  } catch {
    // 兼容无 sessionStorage 的非浏览器环境。
  }
}

function saveStoredSession(session: StoredDesktopSession): void {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    localStorage.removeItem(LEGACY_TOKEN_STORAGE_KEY);
  } catch {
    // 持久化失败不影响本次登录会话。
  }
  try {
    sessionStorage.removeItem(LEGACY_TOKEN_STORAGE_KEY);
  } catch {
    // 兼容无 sessionStorage 的非浏览器环境。
  }
}

function readStoredSession(): StoredDesktopSession | null {
  let storedValue: string | null = null;
  try {
    storedValue = localStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    // 不可用时继续尝试读取旧会话存储。
  }

  if (storedValue) {
    try {
      const parsed = JSON.parse(storedValue) as Partial<StoredDesktopSession>;
      if (
        parsed.schemaVersion === 1 &&
        typeof parsed.token === "string" &&
        parsed.token.length > 0 &&
        (typeof parsed.expiresAt === "string" || parsed.expiresAt === null)
      ) {
        const session: StoredDesktopSession = {
          schemaVersion: 1,
          token: parsed.token,
          expiresAt: parsed.expiresAt,
        };
        if (!sessionIsExpired(session.expiresAt)) return session;
      }
    } catch {
      // 损坏的会话数据按未登录处理。
    }
    clearStoredSession();
    return null;
  }

  let legacyToken: string | null = null;
  try {
    legacyToken = sessionStorage.getItem(LEGACY_TOKEN_STORAGE_KEY);
  } catch {
    // 旧会话存储不可用时按未登录处理。
  }
  if (!legacyToken) return null;

  const migratedSession: StoredDesktopSession = {
    schemaVersion: 1,
    token: legacyToken,
    expiresAt: null,
  };
  saveStoredSession(migratedSession);
  return migratedSession;
}

/** Tauri 桌面端飞书 OAuth 身份适配器。 */
export class DesktopAuthApi {
  private token = readStoredSession()?.token ?? null;
  private initializePromise: Promise<void> | null = null;
  private currentUserPromise: Promise<UserDto | null> | null = null;
  private pendingLogin: PendingLogin | null = null;
  private readonly processedCodes = new Set<string>();
  private readonly cancelledAttempts = new Set<string>();
  private readonly completedAttempts = new Set<string>();

  private initialize(): Promise<void> {
    if (!isTauri()) {
      return Promise.resolve();
    }
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

      const attemptId = url.searchParams.get("attempt");
      if (
        attemptId &&
        (this.cancelledAttempts.has(attemptId) ||
          this.completedAttempts.has(attemptId))
      ) {
        continue;
      }
      if (
        attemptId &&
        this.pendingLogin &&
        attemptId !== this.pendingLogin.attemptId
      ) {
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
      const activeAttemptId =
        attemptId || this.pendingLogin?.attemptId || null;

      try {
        const result = await this.exchangeCode(code);
        if (
          activeAttemptId &&
          (this.cancelledAttempts.has(activeAttemptId) ||
            (this.pendingLogin &&
              activeAttemptId !== this.pendingLogin.attemptId))
        ) {
          continue;
        }
        this.token = result.token;
        saveStoredSession({
          schemaVersion: 1,
          token: result.token,
          expiresAt: result.expiresAt,
        });
        if (activeAttemptId) {
          this.rememberAttempt(this.completedAttempts, activeAttemptId);
        }
        this.resolvePending(result.user);
      } catch (reason) {
        if (
          activeAttemptId &&
          (this.cancelledAttempts.has(activeAttemptId) ||
            (this.pendingLogin &&
              activeAttemptId !== this.pendingLogin.attemptId))
        ) {
          continue;
        }
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

  private async exchangeCode(code: string): Promise<ExchangeResult> {
    const response = await fetch(apiUrl("/api/auth/desktop/exchange"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code }),
    });
    return readApiData<ExchangeResult>(response);
  }

  private resolvePending(user: UserDto): void {
    const pending = this.takePendingLogin();
    pending?.resolve(user);
  }

  private rejectPending(reason: unknown): void {
    const pending = this.takePendingLogin();
    pending?.reject(reason);
  }

  private cancelPending(reason: unknown): void {
    const attemptId = this.pendingLogin?.attemptId;
    if (attemptId) {
      this.rememberAttempt(this.cancelledAttempts, attemptId);
    }
    this.rejectPending(reason);
  }

  private rememberAttempt(attempts: Set<string>, attemptId: string): void {
    attempts.add(attemptId);
    if (attempts.size > 20) {
      const oldestAttempt = attempts.values().next().value;
      if (oldestAttempt) {
        attempts.delete(oldestAttempt);
      }
    }
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

  async signIn(options: SignInOptions = {}): Promise<UserDto> {
    if (!isTauri()) {
      throw new SkillApiError(
        "DESKTOP_RUNTIME_REQUIRED",
        "真实飞书登录仅支持 Kocotree Skills 桌面客户端",
      );
    }
    if (this.pendingLogin) {
      if (this.pendingLogin.authorizationUrl) {
        options.onAuthorizationUrl?.(this.pendingLogin.authorizationUrl);
      }
      return this.pendingLogin.promise;
    }

    const attemptId = createLoginAttemptId();
    let resolveLogin!: (user: UserDto) => void;
    let rejectLogin!: (reason: unknown) => void;
    const promise = new Promise<UserDto>((resolve, reject) => {
      resolveLogin = resolve;
      rejectLogin = reject;
    });
    const timeoutId = window.setTimeout(() => {
      this.cancelPending(
        new SkillApiError(
          "FEISHU_AUTH_TIMEOUT",
          "飞书授权已超时（5 分钟），请重新登录",
        ),
      );
    }, LOGIN_TIMEOUT_MS);
    this.pendingLogin = {
      attemptId,
      authorizationUrl: null,
      promise,
      resolve: resolveLogin,
      reject: rejectLogin,
      timeoutId,
    };

    try {
      await this.initialize();
      if (this.pendingLogin?.attemptId !== attemptId) {
        return promise;
      }
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
      loginUrl.searchParams.set("desktopAttemptId", attemptId);
      const authorizationUrl = loginUrl.toString();
      if (this.pendingLogin?.attemptId !== attemptId) {
        return promise;
      }
      this.pendingLogin.authorizationUrl = authorizationUrl;
      options.onAuthorizationUrl?.(authorizationUrl);
      if (options.openBrowser !== false) {
        await openUrl(authorizationUrl);
      }
    } catch (reason) {
      this.rejectPending(reason);
    }
    return promise;
  }

  cancelSignIn(): void {
    this.cancelPending(
      new SkillApiError("FEISHU_AUTH_CANCELLED", "已取消飞书登录"),
    );
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
    clearStoredSession();
  }
}
