/**
 * @file utils.js
 * @description Shared utilities: silent file removal and stream closing.
 * Used by download.js, arduino.js and other modules that handle files or streams.
 * @module lib/utils
 * @author Sébastien Canet
 * @license CC0-1.0
 */

import fs from 'fs';

/**
 * Removes a file silently (ignores errors).
 * @param {string} p - File path
 */
function safeUnlink(p) {
    try {
        fs.unlinkSync(p);
    } catch (_) {}
}

/**
 * Closes a stream silently (ignores errors).
 * @param {Object|null} stream - Stream or object with close() method
 */
function safeClose(stream) {
    try {
        if (stream && typeof stream.close === 'function') {
            stream.close();
        }
    } catch (_) {}
}

export {
    safeUnlink,
    safeClose
};
