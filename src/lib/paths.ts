/**
 * @file paths.ts
 * @description Résolution des chemins applicatifs (développement vs exécutable packagé).
 * Point d’entrée : répertoire du `package.json` / asar ; en prod, données utilisateur sous `data/` à côté de l’exe.
 * Expose `PATHS` (Arduino CLI, YAML, sketch, locales, icône, preload, HEX micro:bit et cache).
 * @remarks Pour un nouveau binaire ou dossier de données : ajouter un getter ici plutôt que des chemins en dur dans `index.ts`.
 * @module lib/paths
 * @author scanet\@libreduc.cc (Sébastien Canet)
 * @license GPL-3.0
 */

import { app } from 'electron';
import path from 'node:path';
import fs from 'fs';
import { isWindows } from './platform.js';

/**
 * Indique si l’app tourne en développement (hors asar), pour pointer vers les dossiers du dépôt.
 */
function isDev(): boolean {
    return !app.getAppPath().includes('app.asar');
}

/** Project / app root (répertoire du package.json) — requis quand le point d’entrée est compilé dans out/ */
const directory = app.getAppPath();
const directoryAppAsar = isDev() ? directory : path.dirname(directory);

/**
 * Chemin absolu de l’exécutable Arduino CLI (`arduino-cli` / `arduino-cli.exe`) dans le dossier `arduino/` packagé ou à côté de l’exe.
 */
function getArduinoCliExecutable(): string {
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
 * Chemin vers une ressource extra empaquetée (`arduino`, `microbit`, `assets`) : à côté de l’exe en prod, racine du projet en dev.
 * @param resourceName - Nom du dossier à la racine des ressources
 */
function getExtraResourcePath(resourceName: string): string {
    if (isDev()) {
        return path.join(directoryAppAsar, resourceName);
    }
    const appDir = path.dirname(process.execPath);
    return path.join(appDir, resourceName);
}

/**
 * Répertoire de données utilisateur portable : `data/` à côté de l’exe (prod) ou du projet (dev).
 * Contient sketch Arduino, cache micro:bit, `config.json` de langue, `debug.log`, etc.
 */
function getPortableDataDir(): string {
    const appDir = isDev() ? directory : path.dirname(process.execPath);
    return path.join(appDir, 'data');
}

/**
 * Crée `data/` (et parents) s’il n’existe pas.
 */
function ensurePortableDataDir(): void {
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
