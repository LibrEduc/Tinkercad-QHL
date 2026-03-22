/**
 * @file fileCache.ts
 * @description Cache mémoire des résultats de `fs.existsSync` avec TTL et éviction FIFO.
 * Limite les accès disque répétés (HEX micro:bit, chemins ressources).
 * @remarks Après création/suppression de fichiers, appeler `invalidate` sur le chemin concerné.
 * @module lib/fileCache
 * @author scanet\@libreduc.cc (Sébastien Canet)
 * @license GPL-3.0
 */

import fs from 'fs';

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_TTL_MS = 5000;

export type FileCache = ReturnType<typeof createFileCache>;

/**
 * Fabrique un cache avec `exists`, `invalidate` et `clear`.
 * @param options - `maxEntries` (défaut 500), `ttl` en ms (défaut 5000)
 */
function createFileCache(options: { maxEntries?: number; ttl?: number } = {}) {
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

    function exists(path: string): boolean {
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

    function invalidate(path: string): void {
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
