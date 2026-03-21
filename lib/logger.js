/**
 * @file logger.js
 * @description Unified logging: console + file (data/debug.log) when TINKERCAD_DEBUG=1 or debug-mode.js.
 * Exposes logger (debug, info, warn, error), logFile and DEBUG_FILE_LOGGING.
 * @module lib/logger
 * @author Sébastien Canet
 * @license CC0-1.0
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
 * Writes a message to the file stream (if active) and to the console according to the level.
 * @param {string} level - 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
 * @param {...*} args - Arguments passed to console.log/warn/error
 */
function writeLog(level, ...args) {
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
