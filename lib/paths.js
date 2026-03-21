/**
 * @file paths.js
 * @description Application paths (portable, dev/prod). Resolves paths to Arduino CLI,
 * config file, sketch, locales, icon, preload and micro:bit folders.
 * Used by the Electron main process and lib/ modules.
 * @module lib/paths
 * @author Sébastien Canet
 * @license CC0-1.0
 */

import { app } from 'electron';
import path from 'node:path';
import fs from 'fs';
import { fileURLToPath } from 'node:url';
import { isWindows } from './platform.js';

/**
 * Indicates whether the application runs in development mode (unpackaged).
 * @returns {boolean} true if the app path does not contain "app.asar"
 */
function isDev() {
    return !app.getAppPath().includes('app.asar');
}

const directory = isDev() ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') : app.getAppPath();
const directoryAppAsar = isDev() ? directory : path.dirname(directory);

/**
 * Returns the absolute path of the Arduino CLI executable (arduino-cli or arduino-cli.exe).
 * @returns {string} Resolved path to the executable
 */
function getArduinoCliExecutable() {
    let basePath;
    if (isDev()) {
        basePath = path.join(directoryAppAsar, 'arduino');
    } else {
        const appDir = path.dirname(process.execPath);
        basePath = path.join(appDir, 'arduino');
    }
    return path.resolve(path.join(basePath, isWindows ? 'arduino-cli.exe' : 'arduino-cli'));
}

/**
 * Path to an extra resource (arduino, microbit, assets) depending on the environment.
 * @param {string} resourceName - Folder name (e.g. 'arduino', 'microbit', 'assets')
 * @returns {string} Absolute path to the resource
 */
function getExtraResourcePath(resourceName) {
    if (isDev()) {
        return path.join(directoryAppAsar, resourceName);
    }
    const appDir = path.dirname(process.execPath);
    return path.join(appDir, resourceName);
}

/**
 * Portable data directory (next to the executable in prod, or the project in dev).
 * Contains data/arduino/sketch, data/microbit-cache, debug.log, etc.
 * @returns {string} Path to the data directory
 */
function getPortableDataDir() {
    const appDir = isDev() ? directory : path.dirname(process.execPath);
    return path.join(appDir, 'data');
}

/**
 * Creates the portable data directory if it does not exist (recursive for parent dirs).
 */
function ensurePortableDataDir() {
    const dir = getPortableDataDir();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

/** Main paths object (computed when the module loads). */
const PATHS = {
    arduinoCli: getArduinoCliExecutable(),
    arduinoConfig: (() => {
        const arduinoDir = isDev() ? path.join(directoryAppAsar, 'arduino') : getExtraResourcePath('arduino');
        return path.join(arduinoDir, 'arduino-cli.yaml');
    })(),
    /** Sketch: in dev arduino/sketch/sketch.ino, in prod data/arduino/sketch/sketch.ino */
    sketch: isDev() ? path.join(directory, 'arduino', 'sketch', 'sketch.ino') : path.join(getPortableDataDir(), 'arduino', 'sketch', 'sketch.ino'),
    locales: path.join(directory, 'locales'),
    icon: isDev() ? path.join(directory, 'assets', 'autodesk-tinkercad.png') : path.join(getExtraResourcePath('assets'), 'autodesk-tinkercad.png'),
    preload: path.join(directory, 'preload.cjs'),
    microbit: {
        v1: path.join(getExtraResourcePath('microbit'), 'MICROBIT_V1.hex'),
        v2: path.join(getExtraResourcePath('microbit'), 'MICROBIT.hex'),
        cache: path.join(getPortableDataDir(), 'microbit-cache')
    }
};

export {
    isDev,
    directory,
    directoryAppAsar,
    getArduinoCliExecutable,
    getExtraResourcePath,
    getPortableDataDir,
    ensurePortableDataDir,
    PATHS
};
