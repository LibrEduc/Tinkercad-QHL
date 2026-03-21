/**
 * @file boardDetection.js
 * @description Arduino board detection (multi-OS): parses "arduino-cli board list --json" output
 * (or plain text fallback), extracts port.address and port.properties.vid, excludes micro:bit ports (VID 0D28)
 * from the Arduino menu. Provides parseBoardListJson, parseBoardListText, buildArduinoMenuList, boardListsEqual.
 * @module lib/boardDetection
 * @author Sébastien Canet
 * @license CC0-1.0
 */

/** micro:bit USB VID; ports with this VID are excluded from the Arduino menu. */
const MICROBIT_VID = '0D28';

/**
 * Normalizes a VID (0x0D28, 0D28 → 0D28).
 * @param {*} v - Raw value (string or number)
 * @returns {string|null} VID in uppercase without 0x prefix, or null
 */
function normalizeVid(v) {
    if (v == null || v === '') return null;
    const s = String(v).toUpperCase().replace(/^0X/, '').trim();
    return s || null;
}

/**
 * Recursively searches a JSON object for the ports array (elements with address or port.address).
 * @param {*} obj - Object or array parsed from arduino-cli board list --json
 * @param {number} [depth=0] - Max depth to avoid infinite recursion
 * @returns {Array|null} Ports array or null
 */
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
 * Parses "arduino-cli board list --json" output.
 * Only collects port.address and port.properties.vid for each item.
 * @param {string} stdout - Command output
 * @returns {Array} Array of { address: string, vid: string|null }
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
 * From the parsed list (address + vid), we only exclude when VID is explicitly 0D28 (micro:bit).
 * If VID is absent or different from 0D28, the port is added to the menu.
 * @param {Array} parsed - Array of { address: string, vid: string|null }
 * @returns {Array} Array of { port: string, boardName: string }
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
 * Compares two board lists (by port only).
 * @param {Array} a - First list ({ port, boardName }[])
 * @param {Array} b - Second list
 * @returns {boolean} true if same ports in the same order
 */
function boardListsEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i].port !== b[i].port) return false;
    }
    return true;
}

/** Regex to identify a port name (COM3, /dev/ttyACM0, etc.) */
const PORT_REGEX = /^(COM\d+|\/dev\/tty[A-Z0-9]+|\/dev\/cu\.[^\s]+)$/i;

/**
 * Fallback: parses plain TEXT output of "board list" (without --json). First column = port if COM/dev format.
 * vid = null so all ports are kept in the menu.
 * @param {string} stdout - Raw arduino-cli board list output
 * @returns {Array} Array of { address: string, vid: string|null }
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

export {
    MICROBIT_VID,
    parseBoardListJson,
    parseBoardListText,
    buildArduinoMenuList,
    boardListsEqual
};
