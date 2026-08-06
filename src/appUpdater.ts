import { isTauri } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  check,
  type DownloadEvent,
  type Update,
} from "@tauri-apps/plugin-updater";
import { useSyncExternalStore } from "react";

export type AppUpdatePhase =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "installing"
  | "restarting"
  | "unsupported"
  | "error";

export interface AppUpdateSnapshot {
  phase: AppUpdatePhase;
  automaticChecks: boolean;
  availableVersion: string | null;
  notes: string;
  progress: number | null;
  errorMessage: string;
  lastCheckedAt: string | null;
}

const AUTOMATIC_CHECKS_KEY = "kocotree.desktop.automatic-update-checks";
const AUTO_CHECK_DELAY_MS = 4_000;
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

function readAutomaticChecks(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(AUTOMATIC_CHECKS_KEY) !== "false";
  } catch {
    return true;
  }
}

let snapshot: AppUpdateSnapshot = {
  phase: "idle",
  automaticChecks: readAutomaticChecks(),
  availableVersion: null,
  notes: "",
  progress: null,
  errorMessage: "",
  lastCheckedAt: null,
};
let availableUpdate: Update | null = null;
let pendingCheck: Promise<void> | null = null;
let dismissedVersion: string | null = null;
const listeners = new Set<() => void>();

function publish(next: Partial<AppUpdateSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): AppUpdateSnapshot {
  return snapshot;
}

async function closeAvailableUpdate(): Promise<void> {
  const current = availableUpdate;
  availableUpdate = null;
  if (!current) return;
  try {
    await current.close();
  } catch (reason) {
    console.warn("[KocotreeSkills] 释放更新资源失败", reason);
  }
}

/** 订阅全局客户端更新状态。 */
export function useAppUpdater(): AppUpdateSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 保存是否在客户端启动和长时间运行期间自动检查更新。 */
export function setAutomaticUpdateChecks(enabled: boolean): void {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(AUTOMATIC_CHECKS_KEY, String(enabled));
    } catch (reason) {
      console.warn("[KocotreeSkills] 保存自动更新偏好失败", reason);
    }
  }
  publish({ automaticChecks: enabled });
  if (enabled && isTauri() && snapshot.phase === "idle") {
    void checkForAppUpdate({ silent: true });
  }
}

/**
 * 向配置的 Tauri Updater endpoint 查询新版本。
 * @param options.silent - 自动检查失败时是否保持安静。
 */
export function checkForAppUpdate(
  options: { silent?: boolean } = {},
): Promise<void> {
  if (pendingCheck) return pendingCheck;

  if (!isTauri()) {
    publish({
      phase: "unsupported",
      errorMessage: "请在桌面客户端中检查更新",
      progress: null,
    });
    return Promise.resolve();
  }

  const silent = options.silent ?? false;
  pendingCheck = (async () => {
    publish({ phase: "checking", errorMessage: "", progress: null });
    await closeAvailableUpdate();
    try {
      const update = await check({ timeout: 30_000 });
      const checkedAt = new Date().toISOString();
      if (!update) {
        dismissedVersion = null;
        publish({
          phase: "current",
          availableVersion: null,
          notes: "",
          lastCheckedAt: checkedAt,
        });
        return;
      }

      if (silent && dismissedVersion === update.version) {
        await update.close();
        publish({
          phase: "idle",
          availableVersion: null,
          notes: "",
          lastCheckedAt: checkedAt,
        });
        return;
      }

      availableUpdate = update;
      publish({
        phase: "available",
        availableVersion: update.version,
        notes: update.body?.trim() ?? "",
        errorMessage: "",
        lastCheckedAt: checkedAt,
      });
    } catch (reason) {
      console.error("[KocotreeSkills] 检查客户端更新失败", reason);
      publish({
        phase: silent ? "idle" : "error",
        availableVersion: null,
        notes: "",
        errorMessage: silent ? "" : "暂时无法检查更新，请稍后重试",
      });
    } finally {
      pendingCheck = null;
    }
  })();
  return pendingCheck;
}

/** 下载、验证、安装当前查询到的更新，并在安装完成后重启客户端。 */
export async function installAvailableAppUpdate(): Promise<void> {
  const update = availableUpdate;
  if (!update || !snapshot.availableVersion) return;

  let downloadedBytes = 0;
  let contentLength: number | undefined;
  let lastProgress = -1;

  function handleDownloadEvent(event: DownloadEvent): void {
    if (event.event === "Started") {
      contentLength = event.data.contentLength;
      publish({ phase: "downloading", progress: contentLength ? 0 : null });
      return;
    }
    if (event.event === "Progress") {
      downloadedBytes += event.data.chunkLength;
      if (!contentLength) return;
      const progress = Math.min(100, Math.round((downloadedBytes / contentLength) * 100));
      if (progress !== lastProgress) {
        lastProgress = progress;
        publish({ progress });
      }
      return;
    }
    publish({ phase: "installing", progress: 100 });
  }

  publish({ phase: "downloading", progress: 0, errorMessage: "" });
  try {
    await update.downloadAndInstall(handleDownloadEvent, { timeout: 5 * 60_000 });
    publish({ phase: "restarting", progress: 100 });
    await relaunch();
  } catch (reason) {
    console.error("[KocotreeSkills] 下载或安装客户端更新失败", reason);
    publish({
      phase: "error",
      progress: null,
      errorMessage: "更新安装失败，请检查网络后重试",
    });
  }
}

/** 本次运行中暂时忽略当前发现的版本。 */
export function dismissAvailableAppUpdate(): void {
  dismissedVersion = snapshot.availableVersion;
  publish({
    phase: "idle",
    availableVersion: null,
    notes: "",
    progress: null,
    errorMessage: "",
  });
  void closeAvailableUpdate();
}

/** 启动后延迟检查，并为长时间保持运行的客户端安排低频复查。 */
export function startAutomaticAppUpdateChecks(): () => void {
  if (!isTauri()) return () => undefined;

  const run = () => {
    if (snapshot.automaticChecks) {
      void checkForAppUpdate({ silent: true });
    }
  };
  const startupTimer = window.setTimeout(run, AUTO_CHECK_DELAY_MS);
  const interval = window.setInterval(run, AUTO_CHECK_INTERVAL_MS);
  return () => {
    window.clearTimeout(startupTimer);
    window.clearInterval(interval);
  };
}
