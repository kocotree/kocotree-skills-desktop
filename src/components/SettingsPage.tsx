import packageJson from "../../package.json";
import {
  checkForAppUpdate,
  dismissAvailableAppUpdate,
  installAvailableAppUpdate,
  setAutomaticUpdateChecks,
  useAppUpdater,
  type AppUpdatePhase,
} from "../appUpdater";
import { AppIcon } from "./AppIcon";
import { Button } from "./ui";

function displayVersion(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

function updateStatusTitle(
  phase: AppUpdatePhase,
  availableVersion: string | null,
): string {
  if (phase === "checking") return "正在检查更新…";
  if (phase === "available" && availableVersion) {
    return `发现新版本 ${displayVersion(availableVersion)}`;
  }
  if (phase === "downloading" && availableVersion) {
    return `正在下载 ${displayVersion(availableVersion)}`;
  }
  if (phase === "installing") return "正在验证并安装更新…";
  if (phase === "restarting") return "更新完成，正在重启…";
  if (phase === "current") return "当前已是最新版本";
  if (phase === "unsupported") return "请在桌面客户端中检查更新";
  if (phase === "error") return "更新未完成";
  return "当前版本运行正常";
}

function updateStatusDescription(
  phase: AppUpdatePhase,
  automaticChecks: boolean,
  progress: number | null,
  errorMessage: string,
): string {
  if (phase === "checking") return "正在连接更新服务";
  if (phase === "available") return "可以立即下载，安装前会自动验证更新签名";
  if (phase === "downloading") {
    return progress === null ? "正在下载更新包" : `已下载 ${progress}%`;
  }
  if (phase === "installing") return "请保持客户端运行，安装完成后会自动重启";
  if (phase === "restarting") return "新版本将在重启后生效";
  if (phase === "current") return "已完成最新版本检查";
  if (phase === "unsupported" || phase === "error") return errorMessage;
  return automaticChecks
    ? "启动客户端后会自动检查新版本"
    : "自动检查更新已关闭";
}

/**
 * 功能说明：展示客户端设置与真实版本更新入口。
 * @returns 设置与关于页面。
 */
export function SettingsPage() {
  const update = useAppUpdater();
  const busy = ["checking", "downloading", "installing", "restarting"].includes(update.phase);
  const showAvailablePanel = Boolean(update.availableVersion) && [
    "available",
    "downloading",
    "installing",
    "restarting",
    "error",
  ].includes(update.phase);
  const showProgress = ["downloading", "installing", "restarting"].includes(update.phase);

  return (
    <main className="page-content settings-page">
      <header className="page-heading settings-heading">
        <div>
          <h1>设置与关于</h1>
          <p>管理客户端更新，查看当前安装版本。</p>
        </div>
      </header>

      <div className="settings-content">
        <section className={`update-settings-card ${showAvailablePanel ? "has-update" : ""}`}>
          <header className="update-card-header">
            <span className="update-card-mark" aria-hidden="true">
              <AppIcon name="update" size={22} />
            </span>
            <div>
              <span className="settings-eyebrow">软件更新</span>
              <h2>Kocotree Skills</h2>
            </div>
            <span className="current-version-badge">v{packageJson.version}</span>
          </header>

          <div className="update-status-row" aria-live="polite">
            <div className="update-status-copy">
              <span className={`update-status-dot ${showAvailablePanel ? "available" : ""} ${update.phase === "error" ? "error" : ""}`} />
              <div>
                <strong>{updateStatusTitle(update.phase, update.availableVersion)}</strong>
                <small>{updateStatusDescription(
                  update.phase,
                  update.automaticChecks,
                  update.progress,
                  update.errorMessage,
                )}</small>
              </div>
            </div>
            <Button
              className="update-check-button"
              loading={update.phase === "checking"}
              disabled={busy && update.phase !== "checking"}
              onClick={() => void checkForAppUpdate()}
            >
              检查更新
            </Button>
          </div>

          {showAvailablePanel && update.availableVersion && (
            <div className="update-available-panel">
              <div className="version-route" aria-label={`从当前版本 ${packageJson.version} 更新到 ${update.availableVersion}`}>
                <span><small>当前版本</small><strong>v{packageJson.version}</strong></span>
                <i><span /></i>
                <span className="next-version"><small>可用版本</small><strong>{displayVersion(update.availableVersion)}</strong></span>
              </div>
              <div className="release-notes-preview">
                <strong>本次更新</strong>
                <p className="release-notes-content">
                  {update.notes || "此版本没有提供更新说明。"}
                </p>
              </div>
              {showProgress && (
                <div className={`update-download-progress ${update.progress === null ? "indeterminate" : ""}`}>
                  <span style={update.progress === null ? undefined : { width: `${update.progress}%` }} />
                </div>
              )}
              {(update.phase === "available" || update.phase === "error") && (
                <div className="update-preview-actions">
                  <Button onClick={dismissAvailableAppUpdate}>稍后提醒</Button>
                  <Button
                    type="primary"
                    theme="solid"
                    onClick={() => void installAvailableAppUpdate()}
                  >
                    {update.phase === "error" ? "重新更新" : "立即更新"}
                  </Button>
                </div>
              )}
            </div>
          )}

          <div className="settings-preference-row">
            <div>
              <strong>自动检查更新</strong>
              <small>客户端启动后静默检查，有新版本时再提醒你。</small>
            </div>
            <button
              className={`settings-switch ${update.automaticChecks ? "enabled" : ""}`}
              type="button"
              role="switch"
              aria-checked={update.automaticChecks}
              aria-label="自动检查更新"
              onClick={() => setAutomaticUpdateChecks(!update.automaticChecks)}
            >
              <span />
            </button>
          </div>
        </section>

        <section className="about-settings-card">
          <div>
            <span className="settings-eyebrow">关于</span>
            <h2>Kocotree 技能广场</h2>
            <p>浏览、发布并管理提供给 Claude Code 和 Codex 使用的 Skill。</p>
          </div>
          <dl>
            <div><dt>客户端版本</dt><dd>v{packageJson.version}</dd></div>
            <div><dt>更新渠道</dt><dd>正式版</dd></div>
          </dl>
        </section>

        <section className="support-settings-card">
          <span className="support-card-mark" aria-hidden="true">
            <AppIcon name="help" size={21} />
          </span>
          <div>
            <span className="settings-eyebrow">帮助与反馈</span>
            <h2>遇到问题？请联系 <span>KK树运营中心 · AI部的同学</span></h2>
          </div>
        </section>
      </div>
    </main>
  );
}
