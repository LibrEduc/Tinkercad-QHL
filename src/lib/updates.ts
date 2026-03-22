/**
 * @file updates.ts
 * @description Vérification de mise à jour en comparant la version locale (`package.json`) à la dernière release GitHub
 * du dépôt configuré dans `repository` du package (voir `getAppRepositorySlug` dans `github.ts`).
 * @module lib/updates
 * @author scanet\@libreduc.cc (Sébastien Canet)
 * @license GPL-3.0
 */

import type { BrowserWindow } from 'electron';
import { getLatestAppReleaseVersion, compareVersions } from './github.js';
import { showNotification } from './notifications.js';

/**
 * Interroge l’API GitHub puis affiche une notification : à jour, mise à jour disponible, ou erreur réseau/API.
 * @param browserWindow - Fenêtre pour l’affichage (sinon résolu via `getMainWindow`)
 * @param getMainWindow - Callback pour obtenir la fenêtre principale si `browserWindow` est absent
 * @param t - Clés sous `menu.help` (checkUpdateChecking, checkUpdateCurrent, checkUpdateAvailable, checkUpdateError)
 * @param currentVersion - Version courante, en général `package.json` → `version`
 */
async function checkForUpdates(
    browserWindow: BrowserWindow | null,
    getMainWindow: () => BrowserWindow | null,
    t: Record<string, string>,
    currentVersion: string
): Promise<void> {
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
