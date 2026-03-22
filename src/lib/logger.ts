/**
 * @file logger.ts
 * @description Journalisation unifiée : console toujours ; fichier `data/debug.log` si `TINKERCAD_DEBUG=1`
 * ou si `debug-mode.ts` exporte `true`.
 * @remarks Les messages d’erreur utilisateur passent plutôt par `notifications.ts` ; le logger sert au diagnostic.
 * @module lib/logger
 * @author scanet\@libreduc.cc (Sébastien Canet)
 * @license GPL-3.0
 */

import path from 'node:path';
import fs from 'fs';
import { getPortableDataDir, ensurePortableDataDir } from './paths.js';
import debugModeFlag from '../debug-mode.js';

let DEBUG_FILE_LOGGING = false;
try {
    DEBUG_FILE_LOGGING = process.env.TINKERCAD_DEBUG === '1' || debugModeFlag;
} catch (e) {
    DEBUG_FILE_LOGGING = false;
}

ensurePortableDataDir();
const logFile = path.join(getPortableDataDir(), 'debug.log');
const logStream = DEBUG_FILE_LOGGING ? fs.createWriteStream(logFile, { flags: 'a' }) : null;

/**
 * Écrit une ligne horodatée dans le fichier (si actif) et affiche sur la console selon le niveau.
 * @param level - Niveau logique (`DEBUG`, `INFO`, `WARN`, `ERROR`)
 * @param args - Valeurs à sérialiser (objets en JSON indenté)
 */
function writeLog(level: string, ...args: unknown[]): void {
    const timestamp = new Date().toISOString();
    const message = `[${timestamp}] [${level}] ${args.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ')}\n`;

    if (logStream) {
        try {
            logStream.write(message);
        } catch (err) {}
    }

    if (level === 'DEBUG') {
        console.log('[DEBUG]', ...args);
    } else if (level === 'INFO') {
        console.log('[INFO]', ...args);
    } else if (level === 'WARN') {
        console.warn('[WARN]', ...args);
    } else if (level === 'ERROR') {
        console.error('[ERROR]', ...args);
    }
}

const logger = {
    debug: (...args) => writeLog('DEBUG', ...args),
    info: (...args) => writeLog('INFO', ...args),
    warn: (...args) => writeLog('WARN', ...args),
    error: (...args) => writeLog('ERROR', ...args)
};

export {
    logger,
    logFile,
    DEBUG_FILE_LOGGING
};
