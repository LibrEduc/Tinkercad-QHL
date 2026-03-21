/**
 * @file fileCache.js
 * @description Cache for file existence checks (fs.existsSync) with TTL and FIFO eviction.
 * Reduces disk calls for repeated checks (micro:bit HEX, etc.). Exposes createFileCache and fileCache.
 * @module lib/fileCache
 * @author Sébastien Canet
 * @license CC0-1.0
 */

import fs from 'fs';

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_TTL_MS = 5000;

/**
 * Creates a cache that memoizes fs.existsSync(path) with TTL and FIFO eviction.
 * @param {Object} [options] - maxEntries (default 500), ttl in ms (default 5000)
 * @returns {Object} Object { exists(path), invalidate(path), clear() }
 */
function createFileCache(options = {}) {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const ttl = options.ttl ?? DEFAULT_TTL_MS;

    const _cache = new Map();
    const _timestamps = new Map();
    const _order = [];

    function _evictOne() {
        while (_cache.size > maxEntries && _order.length > 0) {
            const k = _order.shift();
            if (_cache.has(k)) {
                _cache.delete(k);
                _timestamps.delete(k);
                return;
            }
        }
    }

    function exists(path) {
        const now = Date.now();
        const cached = _cache.get(path);
        const timestamp = _timestamps.get(path);

        if (cached !== undefined && timestamp != null && (now - timestamp) < ttl) {
            return cached;
        }

        const result = fs.existsSync(path);
        if (!_cache.has(path)) {
            _order.push(path);
        }
        _cache.set(path, result);
        _timestamps.set(path, now);
        _evictOne();
        return result;
    }

    function invalidate(path) {
        _cache.delete(path);
        _timestamps.delete(path);
        const idx = _order.indexOf(path);
        if (idx !== -1) _order.splice(idx, 1);
    }

    function clear() {
        _cache.clear();
        _timestamps.clear();
        _order.length = 0;
    }

    return { exists, invalidate, clear };
}

/** Default instance (500 entries, 5 s TTL) for use in the app */
const fileCache = createFileCache();

export {
    createFileCache,
    fileCache
};
