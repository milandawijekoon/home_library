// Auto-update: checks the update server on launch and every few hours, downloads in the
// background and offers a restart. A small remote file (app-config.json) can mark older
// versions as "critical", which makes the update mandatory. Books are never touched.
import electronUpdater from 'electron-updater';
import { app, dialog, shell } from 'electron';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { compareVersions, isTrustedDownloadUrl } from './guards.js';

const { autoUpdater } = electronUpdater;

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const CRITICAL_CHECK_EVERY_MS = 30 * 60 * 1000;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const CONFIG_URL = 'https://raw.githubusercontent.com/milandawijekoon/home_library/main/release-config/app-config.json';
const DEFAULT_DOWNLOAD_PAGE = 'https://github.com/milandawijekoon/home_library/releases/latest';

// electron-builder strips the "build" section from the packaged package.json, but it writes the
// publish settings to app-update.yml beside the app, which is what electron-updater itself reads.
// macOS only installs updates for apps signed with a Developer ID. Until the app is signed, the app
// tells the user about the new version and opens the download page instead of installing it itself.
function canSelfInstall() {
  if (process.platform !== 'darwin') return true;
  const bundle = path.resolve(app.getPath('exe'), '..', '..', '..');
  const out = spawnSync('codesign', ['-dv', '--verbose=4', bundle], { encoding: 'utf8' });
  return /Authority=Developer ID Application/.test(`${out.stderr}${out.stdout}`);
}

function feedBaseUrl() {
  if (process.env.SHELFIE_UPDATE_URL) return process.env.SHELFIE_UPDATE_URL.replace(/\/+$/, '');
  try {
    const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
    return (yml.match(/^url:\s*(\S+)\s*$/m)?.[1] ?? '').replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function initUpdater({ getWindow }) {
  const base = feedBaseUrl();
  const logFile = path.join(app.getPath('userData'), 'updater.log');
  const log = (message) => {
    try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`); } catch { /* logging is best effort */ }
  };

  // A plain `electron .` run has no update feed, so only packaged builds (or an explicit test feed) update.
  const enabled = Boolean(base) && (app.isPackaged || Boolean(process.env.SHELFIE_UPDATE_URL));
  if (!enabled) return { checkNow: async () => {}, enabled };

  if (process.env.SHELFIE_UPDATE_URL) autoUpdater.setFeedURL({ provider: 'generic', url: base });
  const selfInstall = canSelfInstall();
  autoUpdater.autoDownload = selfInstall;
  autoUpdater.autoInstallOnAppQuit = selfInstall;
  autoUpdater.logger = { info: log, warn: log, error: log, debug() {} };

  let critical = false;
  let config = null;
  let manual = false;
  let timer = null;
  let promptedVersion = '';

  const box = (options) => {
    const win = getWindow();
    return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
  };

  async function fetchConfig() {
    try {
      const res = await fetch(process.env.SHELFIE_UPDATE_URL ? `${base}/app-config.json` : CONFIG_URL, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
      if (!res.ok) return null;
      const body = await res.json();
      return VERSION_RE.test(body?.minimumVersion ?? '') ? body : null;
    } catch {
      return null;
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => checkNow(), critical ? CRITICAL_CHECK_EVERY_MS : CHECK_EVERY_MS);
    timer.unref();
  }

  const downloadPage = () => (isTrustedDownloadUrl(config?.downloadUrl) ? config.downloadUrl : DEFAULT_DOWNLOAD_PAGE);

  // Critical: blocks until the user downloads the new version, then quits.
  async function requireManualDownload() {
    const { response } = await box({
      type: 'warning',
      buttons: ['Download update', 'Quit'],
      defaultId: 0,
      message: 'An important update is required',
      detail: config?.message || 'This version is no longer supported. Please install the latest version. Your books are not affected.',
    });
    if (response === 0) await shell.openExternal(downloadPage());
    app.quit();
  }

  // Unsigned macOS builds: say a new version exists and open the download page.
  async function offerManualDownload(version) {
    log(`manual download offered ${version} critical=${critical}`);
    if (critical) return requireManualDownload();
    if (!manual && promptedVersion === version) return undefined;
    promptedVersion = version;
    const { response } = await box({
      type: 'info', buttons: ['Open download page', 'Later'], defaultId: 0, cancelId: 1,
      message: `Version ${version} is available`, detail: 'Download it, then open the installer. Your books are safe and will not be changed.',
    });
    if (response === 0) await shell.openExternal(downloadPage());
    return undefined;
  }

  autoUpdater.on('update-downloaded', async (info) => {
    log(`downloaded ${info.version} critical=${critical}`);
    const detail = 'Your books are safe and will not be changed.';
    if (critical) {
      await box({
        type: 'warning', buttons: ['Restart and update'], defaultId: 0,
        message: `Important update ${info.version}`, detail: config?.message ? `${config.message}\n\n${detail}` : detail,
      });
      autoUpdater.quitAndInstall();
      return;
    }
    const { response } = await box({
      type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
      message: `Shelfie Home Library ${info.version} is ready`, detail: `Restart to finish updating. ${detail}`,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  async function checkNow({ userInitiated = false } = {}) {
    manual = userInitiated;
    config = await fetchConfig();
    critical = Boolean(config) && compareVersions(app.getVersion(), config.minimumVersion) < 0;
    log(`check version=${app.getVersion()} minimum=${config?.minimumVersion ?? '-'} critical=${critical}`);
    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result?.isUpdateAvailable) {
        if (critical) await requireManualDownload();
        else if (manual) await box({ type: 'info', message: "You're up to date", detail: `Version ${app.getVersion()} is the latest.` });
      } else if (!selfInstall) {
        await offerManualDownload(result.updateInfo.version);
      }
    } catch (err) {
      log(`check failed: ${err.message}`);
      if (critical) await requireManualDownload();
      else if (manual) await box({ type: 'error', message: 'Could not check for updates', detail: 'Check your internet connection and try again.' });
    } finally {
      schedule();
    }
  }

  setTimeout(() => checkNow(), 10_000).unref();
  return { checkNow, enabled };
}
