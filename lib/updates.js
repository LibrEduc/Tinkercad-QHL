/**
 * Vérification des mises à jour (GitHub releases)
 */
const { getLatestAppReleaseVersion, compareVersions } = require('./github');
const { logger } = require('./logger');
const { showNotification } = require('./notifications');

/**
 * Vérifie s'il existe une mise à jour et affiche une notification
 * @param {BrowserWindow|null} browserWindow
 * @param {Function} getMainWindow
 * @param {Object} t - translations.menu.help
 * @param {string} currentVersion
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

module.exports = { checkForUpdates };
