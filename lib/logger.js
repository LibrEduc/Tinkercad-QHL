/**
 * Logging (console + fichier si mode debug)
 */
const path = require('node:path');
const fs = require('fs');
const { getPortableDataDir, ensurePortableDataDir } = require('./paths');

let DEBUG_FILE_LOGGING = false;
try {
    DEBUG_FILE_LOGGING = process.env.TINKERCAD_DEBUG === '1' || require('../debug-mode.js');
} catch (e) {
    DEBUG_FILE_LOGGING = false;
}

ensurePortableDataDir();
const logFile = path.join(getPortableDataDir(), 'debug.log');
const logStream = DEBUG_FILE_LOGGING ? fs.createWriteStream(logFile, { flags: 'a' }) : null;

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

module.exports = {
    logger,
    logFile,
    DEBUG_FILE_LOGGING,
    writeLog
};
