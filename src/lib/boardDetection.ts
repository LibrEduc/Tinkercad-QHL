/**
 * @file boardDetection.ts
 * @description Analyse la sortie de `arduino-cli board list` (JSON ou texte) pour alimenter le menu « ports ».
 * Exclut les ports dont le VID correspond au micro:bit (`0D28`) pour éviter les doublons avec le menu micro:bit.
 * @module lib/boardDetection
 * @author scanet\@libreduc.cc (Sébastien Canet)
 * @license GPL-3.0
 */

/** VID USB du micro:bit : ces ports ne figurent pas dans le menu Arduino. */
const MICROBIT_VID = '0D28';

export type ParsedPort = { address: string; vid: string | null };
export type BoardMenuEntry = { port: string; boardName: string };

/**
 * Normalise un identifiant vendeur USB (`0x0D28`, `0D28` → `0D28`).
 */
function normalizeVid(v: unknown): string | null {
    if (v == null || v === '') return null;
    const s = String(v).toUpperCase().replace(/^0X/, '').trim();
    return s || null;
}

/**
 * Parcourt le JSON renvoyé par le CLI pour trouver un tableau de ports (formes variables selon les versions).
 */
function findPortsArray(obj: unknown, depth = 0): unknown[] | null {
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
 * Parse la sortie `--json` : extrait adresse de port et VID pour chaque entrée.
 */
function parseBoardListJson(stdout: string): ParsedPort[] {
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
 * Filtre les ports micro:bit puis projette en entrées de menu (libellé = port pour l’instant).
 */
function buildArduinoMenuList(parsed: ParsedPort[]): BoardMenuEntry[] {
    return parsed
        .filter(({ vid }) => {
            if (vid == null || vid === '') return true;
            return normalizeVid(vid) !== MICROBIT_VID;
        })
        .map(({ address }) => ({ port: address, boardName: address }));
}

/**
 * Égalité des listes de cartes : même ports dans le même ordre.
 */
function boardListsEqual(a: BoardMenuEntry[], b: BoardMenuEntry[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i].port !== b[i].port) return false;
    }
    return true;
}

/** Regex to identify a port name (COM3, /dev/ttyACM0, etc.) */
const PORT_REGEX = /^(COM\d+|\/dev\/tty[A-Z0-9]+|\/dev\/cu\.[^\s]+)$/i;

/**
 * Secours si le JSON est vide ou invalide : première colonne = port si format COM / tty reconnu ; VID inconnu.
 */
function parseBoardListText(stdout: string): ParsedPort[] {
    const result = [];
    const lines = stdout.split(/\n/).map(l => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
        const firstWord = lines[i].split(/\s+/)[0];
        if (firstWord && PORT_REGEX.test(firstWord)) result.push({ address: firstWord, vid: null });
    }
    return result;
}

export {
    MICROBIT_VID,
    parseBoardListJson,
    parseBoardListText,
    buildArduinoMenuList,
    boardListsEqual
};
