/**
 * Détection des cartes Arduino (multi-OS).
 * 1. Parser le JSON pour recueillir port.address et port.properties.vid de chaque objet.
 * 2. Comparer à l'état précédent (tableau en mémoire) ; si rien n'a changé, ne rien faire.
 * 3. Si port.properties.vid === '0D28' (micro:bit) on ne l'ajoute pas au menu ; sinon on ajoute port.address au menu.
 */
const MICROBIT_VID = '0D28';

/**
 * Normalise un VID (0x0D28, 0D28 → 0D28).
 * @param {*} v
 * @returns {string|null}
 */
function normalizeVid(v) {
    if (v == null || v === '') return null;
    const s = String(v).toUpperCase().replace(/^0X/, '').trim();
    return s || null;
}

function findPortsArray(obj, depth = 0) {
    if (depth > 5) return null;
    if (Array.isArray(obj) && obj.length > 0) {
        const first = obj[0];
        if (first && typeof first === 'object' && (first.address || first.port || first.port?.address)) return obj;
    }
    if (obj && typeof obj === 'object') {
        for (const v of Object.values(obj)) {
            const found = findPortsArray(v, depth + 1);
            if (found) return found;
        }
    }
    return null;
}

/**
 * Parse la sortie de "arduino-cli board list --json".
 * Ne recueille que port.address et port.properties.vid pour chaque objet.
 * @param {string} stdout - Sortie de la commande
 * @returns {{ address: string, vid: string | null }[]}
 */
function parseBoardListJson(stdout) {
    const result = [];
    try {
        const raw = stdout.trim();
        if (!raw || !raw.startsWith('[') && !raw.startsWith('{')) return result;
        const data = JSON.parse(raw);
        const list = Array.isArray(data) ? data : findPortsArray(data);
        if (!Array.isArray(list)) return result;
        for (const item of list) {
            const portObj = item.port != null ? item.port : item;
            const address =
                portObj.address || portObj.Address || portObj.label || portObj.port
                || item.address || item.port_address;
            if (!address) continue;
            const props = portObj.properties || portObj.property || item.properties || (item.port && item.port.properties) || {};
            const rawVid = props.vid ?? props.VID ?? props.Vid;
            const vid = rawVid != null && rawVid !== '' ? normalizeVid(rawVid) : null;
            result.push({ address, vid });
        }
        return result;
    } catch (e) {
        return [];
    }
}

/**
 * À partir de la liste parsée (address + vid), on n'exclut que si VID est explicitement 0D28 (micro:bit).
 * Si VID est absent ou différent de 0D28, on ajoute le port au menu.
 * @param {{ address: string, vid: string | null }[]} parsed
 * @returns {{ port: string, boardName: string }[]}
 */
function buildArduinoMenuList(parsed) {
    return parsed
        .filter(({ vid }) => {
            if (vid == null || vid === '') return true;
            return normalizeVid(vid) !== MICROBIT_VID;
        })
        .map(({ address }) => ({ port: address, boardName: address }));
}

/**
 * Compare deux listes de cartes (par port uniquement).
 * @param {{ port: string, boardName: string }[]} a
 * @param {{ port: string, boardName: string }[]} b
 */
function boardListsEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i].port !== b[i].port) return false;
    }
    return true;
}

/** Regex pour identifier un nom de port (COM3, /dev/ttyACM0, etc.) */
const PORT_REGEX = /^(COM\d+|\/dev\/tty[A-Z0-9]+|\/dev\/cu\.[^\s]+)$/i;

/**
 * Secours : parse la sortie TEXTE de "board list" (sans --json).
 * Format : première ligne = en-tête, suivantes = une colonne "Port" en premier.
 * On prend la première colonne (premier mot) si ça ressemble à un port ; vid = null → tout est conservé au menu.
 * @param {string} stdout
 * @returns {{ address: string, vid: string | null }[]}
 */
function parseBoardListText(stdout) {
    const result = [];
    const lines = stdout.split(/\n/).map(l => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
        const firstWord = lines[i].split(/\s+/)[0];
        if (firstWord && PORT_REGEX.test(firstWord)) result.push({ address: firstWord, vid: null });
    }
    return result;
}

module.exports = {
    MICROBIT_VID,
    parseBoardListJson,
    parseBoardListText,
    buildArduinoMenuList,
    boardListsEqual
};
