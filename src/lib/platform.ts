/**
 * @file platform.ts
 * @description Détection d’OS au chargement du module (`process.platform`).
 * Utilisé par `paths`, `arduino` (nom d’archive CLI, PowerShell vs tar), `index` (listing disques micro:bit).
 * @module lib/platform
 * @author scanet\@libreduc.cc (Sébastien Canet)
 * @license GPL-3.0
 */

/** `true` si Windows (chemins, `.exe`, commandes `wmic`, extraction ZIP). */
const isWindows = process.platform === 'win32';
/** `true` si macOS (listing sous `/Volumes`, archive macOS du CLI). */
const isMac = process.platform === 'darwin';
/** `true` si Linux (chemins `/media`, `/mnt`). */
const isLinux = process.platform === 'linux';

export {
    isWindows,
    isMac,
    isLinux
};
