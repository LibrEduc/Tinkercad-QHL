/**
 * @file updates.js
 * @description Update check via GitHub releases (getLatestAppReleaseVersion).
 * Shows a notification depending on whether the current version is up to date or an update is available.
 * @module lib/updates
 * @author Sébastien Canet
 * @license CC0-1.0
 */

import { getLatestAppReleaseVersion, compareVersions } from './github.js';
import { logger } from './logger.js';
import { showNotification } from './notifications.js';

/**
 * Checks the latest version published on GitHub and shows a notification (up to date / update available / error).
 * @param {Electron.BrowserWindow|null} browserWindow - Window for the notification
 * @param {Function} getMainWindow - Fallback to get the window
 * @param {Object} t - Translations (translations.menu.help: checkUpdateChecking, checkUpdateCurrent, etc.)
 * @param {string} currentVersion - Current app version (e.g. package.json version)
 */
async function checkForUpdates(browserWindow, getMainWindow, t, currentVersion) {
    const win = browserWindow || getMainWindow();
    if (win) showNotification(win, t.checkUpdateChecking);
    const latestVersion = await getLatestAppReleaseVersion();
    if (!win) return;
    if (!latestVersion) {
        showNotification(win, t.checkUpdateError);
        return;
    }
    const compare = compareVersions(currentVersion, latestVersion);
    if (compare >= 0) {
        showNotification(win, t.checkUpdateCurrent.replace('{version}', currentVersion));
    } else {
        showNotification(win, t.checkUpdateAvailable.replace('{version}', latestVersion));
    }
}

export { checkForUpdates };
