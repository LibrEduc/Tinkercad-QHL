/**
 * Cache pour les vérifications d'existence de fichiers (éviction FIFO, TTL)
 */
const fs = require('fs');

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_TTL_MS = 5000;

/**
 * Crée un cache qui mémorise fs.existsSync(path) avec TTL et éviction FIFO.
 * @param {{ maxEntries?: number, ttl?: number }} [options]
 * @returns {{ exists: (path: string) => boolean, invalidate: (path: string) => void, clear: () => void }}
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

/** Instance par défaut (500 entrées, TTL 5 s) pour usage dans l'app */
const fileCache = createFileCache();

module.exports = {
    createFileCache,
    fileCache
};
