/**
 * Chemins de l'application (portable, dev/prod)
 */
const { app } = require('electron');
const path = require('node:path');
const fs = require('fs');

function isDev() {
    return !app.getAppPath().includes('app.asar');
}

const directory = isDev() ? path.dirname(require.main.filename) : app.getAppPath();
const directoryAppAsar = isDev() ? directory : path.dirname(directory);

function getArduinoCliExecutable() {
    let basePath;
    if (isDev()) {
        basePath = path.join(directoryAppAsar, 'arduino');
    } else {
        const appDir = path.dirname(process.execPath);
        basePath = path.join(appDir, 'arduino');
    }
    const { isWindows } = require('./platform');
    return path.resolve(path.join(basePath, isWindows ? 'arduino-cli.exe' : 'arduino-cli'));
}

function getExtraResourcePath(resourceName) {
    if (isDev()) {
        return path.join(directoryAppAsar, resourceName);
    }
    const appDir = path.dirname(process.execPath);
    return path.join(appDir, resourceName);
}

function getPortableDataDir() {
    const appDir = isDev() ? directory : path.dirname(process.execPath);
    return path.join(appDir, 'data');
}

function ensurePortableDataDir() {
    const dir = getPortableDataDir();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

const PATHS = {
    arduinoCli: getArduinoCliExecutable(),
    arduinoConfig: (() => {
        const arduinoDir = isDev() ? path.join(directoryAppAsar, 'arduino') : getExtraResourcePath('arduino');
        return path.join(arduinoDir, 'arduino-cli.yaml');
    })(),
    // Sketch = sous-dossier de arduino (arduino/sketch/sketch.ino). En prod : data/arduino/sketch
    sketch: isDev() ? path.join(directory, 'arduino', 'sketch', 'sketch.ino') : path.join(getPortableDataDir(), 'arduino', 'sketch', 'sketch.ino'),
    locales: path.join(directory, 'locales'),
    icon: isDev() ? path.join(directory, 'assets', 'autodesk-tinkercad.png') : path.join(getExtraResourcePath('assets'), 'autodesk-tinkercad.png'),
    preload: path.join(directory, 'preload.js'),
    microbit: {
        v1: path.join(getExtraResourcePath('microbit'), 'MICROBIT_V1.hex'),
        v2: path.join(getExtraResourcePath('microbit'), 'MICROBIT.hex'),
        // Toujours dans le dossier de l'app (portable)
        cache: path.join(getPortableDataDir(), 'microbit-cache')
    }
};

module.exports = {
    isDev,
    directory,
    directoryAppAsar,
    getArduinoCliExecutable,
    getExtraResourcePath,
    getPortableDataDir,
    ensurePortableDataDir,
    PATHS
};
