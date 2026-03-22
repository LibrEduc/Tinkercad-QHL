/**
 * @file index.ts
 * @description Point d’entrée du **processus principal** Electron : fenêtre Tinkercad, menu (`getMenuContext` + `lib/menu`),
 * pont IPC (traductions, icônes, téléversement Arduino/micro:bit, installation de bibliothèque),
 * chargement des HEX MicroPython, compilation Python → HEX, détection des ports Arduino et des lecteurs micro:bit.
 *
 * @remarks
 * - Données utilisateur : `data/` (voir `paths.ts`), locales dans `locales/`.
 * - Pour suivre le flux : IPC → handlers → `lib/*` ; le menu ne doit pas importer ce fichier directement (contexte injecté).
 * - Scripts utiles : `npm run compile`, `npm start`, `npm run docs` (TypeDoc).
 *
 * @module index
 * @author scanet\@libreduc.cc (Sébastien Canet)
 * @license GPL-3.0
 */

import { app, BrowserWindow, Menu, clipboard, ipcMain, webContents, shell, dialog } from 'electron';
import path from 'node:path';
import fs from 'fs';
import { fileURLToPath } from 'node:url';
import { exec, spawnSync } from 'child_process';
import { MicropythonFsHex, microbitBoardId } from '@microbit/microbit-fs';

import { isDev, directory, directoryAppAsar, PATHS, getPortableDataDir, ensurePortableDataDir, getExtraResourcePath } from './lib/paths.js';
import { CONSTANTS, DETECTION_INTERVAL, MICROBIT_DETAILS_PATTERNS } from './lib/constants.js';
import { isMakeCodePython, convertMakeCodeToMicroPython } from './lib/microbitConversion.js';
import { cleanPythonCode, validatePythonSyntax, validatePythonSyntaxWithDisplay } from './lib/pythonUtils.js';
import { isWindows, isMac } from './lib/platform.js';
import { parseBoardListJson, parseBoardListText, buildArduinoMenuList, boardListsEqual } from './lib/boardDetection.js';
import { logger, logFile, DEBUG_FILE_LOGGING } from './lib/logger.js';
import { showNotification } from './lib/notifications.js';
import { getMicrobitV1HexUrl, getMicrobitV2HexUrl } from './lib/github.js';
import { checkForUpdates } from './lib/updates.js';
import { downloadToFile } from './lib/download.js';
import { CODE_EXTRACTION_SCRIPT, executeScriptInWebview, extractCodeFromEditor } from './lib/codeExtraction.js';
import {
    buildArduinoCliCommand,
    execCommand,
    ensureArduinoCli,
    compileAndUploadArduino
} from './lib/arduino.js';
import { fileCache } from './lib/fileCache.js';
import { buildApplicationMenu } from './lib/menu.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageInfo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

// ---------------------------------------------------------------------------
// IPC : communication avec le preload (`window.api`) et la page chargée
// ---------------------------------------------------------------------------

// IPC handlers for library dialog
ipcMain.on('close-library-dialog', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.close();
});

// Handle translation requests
ipcMain.handle('get-translation', (event, key) => {
    const keys = key.split('.');
    let value = translations;
    for (const k of keys) {
        if (!value || typeof value !== 'object') {
            logger.warn(`Translation key not found: ${key}`);
            return key;
        }
        value = value[k];
    }
    return value || key;
});

// Handle icon paths requests
ipcMain.handle('get-icon-paths', (event) => {
    // In production, resources are in extraResources
    // In development, they are in the project's assets folder
    let assetsDir;
    if (isDev()) {
        assetsDir = path.join(directory, 'assets');
    } else {
        // In production, extraResources with "to": "../assets" are copied at the parent of resources/
        // Structure: app/ -> assets/, resources/ -> app.asar
        // Use the executable path to find the application directory
        const exePath = process.execPath; // Path to the executable
        const appDir = path.dirname(exePath); // Application directory (win-unpacked/)
        assetsDir = path.join(appDir, 'assets');
        
        // Check if the path exists, otherwise try other paths
        if (!fs.existsSync(path.join(assetsDir, 'arduino-logo.svg'))) {
            // Fallback: try from resources/
            const fallbackPaths = [
                path.join(path.dirname(directoryAppAsar), 'assets'),  // ../assets from resources/
                path.join(directoryAppAsar, 'assets'),                  // assets/ in resources/
            ];
            
            const foundPath = fallbackPaths.find(p => {
                return fs.existsSync(path.join(p, 'arduino-logo.svg'));
            });
            
            if (foundPath) {
                assetsDir = foundPath;
            } else {
                logger.warn('Assets directory not found at:', assetsDir);
                logger.warn('Tried paths:', [assetsDir, ...fallbackPaths]);
            }
        }
    }
    
    // Normalize paths for file:// (replace backslashes with slashes)
    // On Windows, absolute paths start with C:\..., so file:///C:/...
    const normalizePath = (p) => {
        const resolved = path.resolve(p);
        let normalized = resolved.replace(/\\/g, '/');
        // Ensure Windows paths start with / for file://
        if (normalized.match(/^[A-Z]:\//)) {
            normalized = '/' + normalized;
        }
        return normalized;
    };
    
    const arduinoIcon = path.join(assetsDir, 'arduino-logo.svg');
    const microbitIcon = path.join(assetsDir, 'Microbit_Hex.png');
    
    // Check that the files exist
    if (!fs.existsSync(arduinoIcon)) {
        logger.warn('Arduino icon not found at:', arduinoIcon);
        logger.warn('Assets directory:', assetsDir);
        logger.warn('App path:', app.getAppPath());
        logger.warn('Resources path:', process.resourcesPath);
    }
    if (!fs.existsSync(microbitIcon)) {
        logger.warn('Micro:bit icon not found at:', microbitIcon);
    }
    
    return {
        arduino: normalizePath(arduinoIcon),
        microbit: normalizePath(microbitIcon)
    };
});

// Handle upload requests from toolbar icons
ipcMain.on('upload-arduino', (event) => {
    const mainWindow = BrowserWindow.fromWebContents(event.sender);
    if (mainWindow) runArduinoUploadFlow(mainWindow);
});

ipcMain.on('upload-microbit', (event) => {
    const mainWindow = BrowserWindow.fromWebContents(event.sender);
    if (mainWindow) runMicrobitUploadFlow(mainWindow);
});

ipcMain.on('install-library', (event, libraryName) => {
    const sender = event.sender;
    const win = BrowserWindow.fromWebContents(sender);
    const mainWindow = getMainWindowExcluding(win);
    const t = translations.menu;

    const reply = (result) => {
        try {
            if (!sender.isDestroyed()) sender.send('install-library-done', result);
        } catch (_) {}
    };

    if (!libraryName || typeof libraryName !== 'string') {
        if (mainWindow) showNotification(mainWindow, t.installLibrary.notifications.empty);
        reply({ ok: false, error: t.installLibrary.notifications.empty });
        return;
    }
    const sanitized = libraryName.trim().replace(/[^\w\s.-]/g, '');
    if (!sanitized) {
        if (mainWindow) showNotification(mainWindow, t.installLibrary.notifications.empty);
        reply({ ok: false, error: t.installLibrary.notifications.empty });
        return;
    }

    if (mainWindow) showNotification(mainWindow, t.installLibrary.notifications.progress);

    execCommand(buildArduinoCliCommand(`lib install "${sanitized}"`), {
        browserWindow: mainWindow,
        showError: t.installLibrary.notifications.error,
        showSuccess: t.installLibrary.notifications.success,
        onSuccess: () => {
            reply({ ok: true });
            if (win) win.close();
        },
        onError: (error) => {
            const message = error && error.message ? error.message : String(error);
            reply({ ok: false, error: message });
            if (win) win.close();
        }
    }).catch(error => {
        logger.error(`Error installing library: ${error}`);
        reply({ ok: false, error: error && error.message ? error.message : String(error) });
    });
});

// Load translations
// Cache for loaded translations
const translationCache = new Map();

function loadTranslations(locale) {
    // Check cache first
    if (translationCache.has(locale)) {
        return translationCache.get(locale);
    }

    const translationPath = path.join(PATHS.locales, `${locale}.json`);
    try {
        const translations = JSON.parse(fs.readFileSync(translationPath, 'utf8'));
        translationCache.set(locale, translations);
        return translations;
    } catch (error) {
        logger.error(`Failed to load translations for ${locale}:`, error);
        return null;
    }
}

// Get system locale and handle language code extraction (ex: 'en-US' -> 'en')
const rawLocale = app.getLocale();
const systemLocale = (rawLocale || '').split('-')[0] || 'en';
let translations = loadTranslations(systemLocale);
let currentLocale = systemLocale;

const CONFIG_FILENAME = 'config.json';

/** Lit `data/config.json` pour la clé `locale` (`fr` ou `en`). */
function getSavedLocale(): 'fr' | 'en' | null {
    try {
        const configPath = path.join(getPortableDataDir(), CONFIG_FILENAME);
        if (fs.existsSync(configPath)) {
            const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (data.locale === 'fr' || data.locale === 'en') return data.locale;
        }
    } catch (e) {
        logger.debug('getSavedLocale:', e.message);
    }
    return null;
}

/** Enregistre la langue dans `data/config.json`. */
function saveLocale(locale: string): void {
    try {
        ensurePortableDataDir();
        const configPath = path.join(getPortableDataDir(), CONFIG_FILENAME);
        fs.writeFileSync(configPath, JSON.stringify({ locale }, null, 2), 'utf8');
    } catch (e) {
        logger.warn('Could not save locale:', e.message);
    }
}
let selectedBoard = '';

// Only fallback to English if the translation file doesn't exist or is invalid
if (!translations) {
    logger.info(`No translations found for ${systemLocale}, falling back to English`);
    translations = loadTranslations('en');
}

// Menu: built on first refreshMenu() (in app.whenReady via switchLanguage(systemLocale))

/**
 * Crée la fenêtre principale (toolbar locale, webview Tinkercad, preload sandboxé).
 * Ouvre les DevTools en dev uniquement si le mode debug fichier est actif.
 */
function createWindow(): void {
    const mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: 'Tinkercad QHL',
        icon: PATHS.icon,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.resolve(directory, 'preload.cjs'),
            webviewTag: true  // Required to use <webview> tags
        }
    });

    // Close all windows when main window is closed
    mainWindow.on('closed', () => {
        BrowserWindow.getAllWindows().forEach(win => {
            if (win !== mainWindow) win.close();
        });
    });

    // Load index.html with toolbar
    mainWindow.loadFile('index.html');

    // Open DevTools automatically only in debug mode (TINKERCAD_DEBUG=1 or npm run start:debug)
    if (isDev() && DEBUG_FILE_LOGGING) {
        mainWindow.webContents.openDevTools();
    }
    
    // Show log file path on startup (only when debug mode is enabled)
    if (DEBUG_FILE_LOGGING) {
        logger.info(`Log file: ${logFile}`);
        if (!isDev()) {
            mainWindow.webContents.once('did-finish-load', () => {
                showNotification(mainWindow, `Log file: ${logFile}`);
            });
        }
    }

    // Ensure the title stays "Tinkercad QHL" even after the page loads
    mainWindow.on('page-title-updated', (event) => {
        event.preventDefault();
        mainWindow.setTitle('Tinkercad QHL');
    });

    // Handle new window creation
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

// ============================================================================
// Utilitaires internes (fenêtres, listes, détection micro:bit)
// ============================================================================

logger.info('Application started');
if (DEBUG_FILE_LOGGING) {
    logger.info(`Log file: ${logFile}`);
}
logger.info(`Platform: ${isWindows ? 'win32' : isMac ? 'darwin' : 'linux'}`);
logger.info(`Node version: ${process.version}`);
logger.info(`Electron version: ${process.versions.electron}`);

/** Exécute une fonction en ignorant les erreurs (rafraîchissements UI non bloquants). */
function safeExecute(fn: () => void): void {
    try {
        fn();
    } catch (error) {
        // Ignore errors silently
        logger.debug('safeExecute error:', error.message);
    }
}

/** Première fenêtre ouverte, ou `null` (aucune fenêtre). */
function getMainWindow(): BrowserWindow | null {
    const windows = BrowserWindow.getAllWindows();
    return windows.length > 0 ? windows[0] : null;
}

/** Fenêtre « principale » en excluant une fenêtre (ex. dialogue bibliothèque). */
function getMainWindowExcluding(excludeWindow: BrowserWindow | null | undefined): BrowserWindow | null {
    const windows = BrowserWindow.getAllWindows();
    return windows.find(w => w !== excludeWindow) || getMainWindow();
}

/** Compare deux listes d’objets { port, drive, ... } (rapide pour petites listes, JSON pour les grandes). */
function areListsEqual(list1: { port?: string; drive?: string; boardName?: string; volName?: string }[], list2: typeof list1): boolean {
    // Quick length comparison
    if (list1.length !== list2.length) {
        return false;
    }

    // If lists are empty, they are equal
    if (list1.length === 0) {
        return true;
    }

    // For small lists, direct field-by-field comparison is faster
    if (list1.length <= 5) {
        for (let i = 0; i < list1.length; i++) {
            const item1 = list1[i];
            const item2 = list2[i];
            // Quick comparison of main keys
            if (item1.port !== item2.port || item1.drive !== item2.drive ||
                item1.boardName !== item2.boardName || item1.volName !== item2.volName) {
                return false;
            }
        }
        return true;
    }

    // For larger lists, use JSON.stringify (acceptable)
    return JSON.stringify(list1) === JSON.stringify(list2);
}

/** Détecte un volume micro:bit via la présence et le contenu de `DETAILS.TXT` (motifs DAPLink, etc.). */
function isMicrobitDrive(drivePath: string): boolean {
    try {
        const detailsPath = path.join(drivePath, 'DETAILS.TXT');
        if (!fs.existsSync(detailsPath)) {
            return false;
        }
        const content = fs.readFileSync(detailsPath, 'utf8');
        return MICROBIT_DETAILS_PATTERNS.some(pattern => content.includes(pattern));
    } catch (e) {
        return false;
    }
}

/**
 * Lit un fichier HEX MicroPython (v1 ou v2) depuis les ressources packagées ou le cache utilisateur.
 * @param version - `'v1'` ou `'v2'`
 * @param _directoryAppAsar - Paramètre historique (chemins résolus via `PATHS`)
 */
function loadHexFile(version: string, _directoryAppAsar: string): string | null {
    const isV1 = version === 'v1';
    const hexFileName = isV1 ? 'MICROBIT_V1.hex' : 'MICROBIT.hex';
    const hexPath = hexFileName === 'MICROBIT_V1.hex' ? PATHS.microbit.v1 : PATHS.microbit.v2;
    const cacheDir = PATHS.microbit.cache;
    const cachePath = path.join(cacheDir, hexFileName);

    let hexContent = null;

    // Check packaged resources first
    if (fileCache.exists(hexPath)) {
        hexContent = fs.readFileSync(hexPath, 'utf8');
        if (hexContent.trim().startsWith(':')) {
            // Copy to cache for future use
            if (!fileCache.exists(cacheDir)) {
                fs.mkdirSync(cacheDir, { recursive: true });
                fileCache.invalidate(cacheDir);
            }
            try {
                fs.writeFileSync(cachePath, hexContent, 'utf8');
            } catch (e) {
                logger.warn(`Could not write to cache: ${e.message}`);
            }
        } else {
            hexContent = null;
        }
    }

    // Check cache if not found in resources
    if (!hexContent && fileCache.exists(cachePath)) {
        hexContent = fs.readFileSync(cachePath, 'utf8');
        if (!hexContent.trim().startsWith(':')) {
            hexContent = null;
        }
    }

    return hexContent;
}

let selectedPort = null;
let boardDetectionInterval;
let selectedMicrobitDrive = null;
let microbitDetectionInterval;
let previousBoards = [];
let previousMicrobitDrives = [];

/**
 * Vérifie que les deux HEX (carte v1 et v2) sont disponibles via `loadHexFile`.
 * @throws Si l’un des deux fichiers manque (message traduit ou texte par défaut).
 */
async function ensureMicroPythonHexes(): Promise<{ v1Hex: string; v2Hex: string }> {

    const v1Hex = loadHexFile('v1', directoryAppAsar);
    const v2Hex = loadHexFile('v2', directoryAppAsar);

    if (!v1Hex || !v2Hex) {
        throw new Error(translations.menu.microbit.notifications.installErrorMissing || 'Fichiers HEX MicroPython introuvables. Utilisez "Micro:bit > Installer les runtimes" pour les télécharger.');
    }

    return { v1Hex, v2Hex };
}

/**
 * Ouvre une fenêtre secondaire (HTML inline) affichant le code MicroPython avec numéros de ligne et copie.
 */
function showConvertedCodeWindow(code: string): void {
    const t = translations?.menu || {};
    const codeWindow = new BrowserWindow({
        width: 900,
        height: 700,
        title: t.microbit?.convertedCode?.title || 'Code MicroPython Converti',
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    // Hide the menu bar completely
    codeWindow.setMenuBarVisibility(false);

    const title = t.microbit?.convertedCode?.title || 'Code MicroPython Converti';
    const description = t.microbit?.convertedCode?.description || 'Ce code a été automatiquement converti depuis MakeCode Python vers MicroPython standard';
    const copyButton = t.microbit?.convertedCode?.copyButton || 'Copier le code';
    const closeButton = t.microbit?.convertedCode?.closeButton || 'Fermer';
    const copySuccess = t.microbit?.convertedCode?.copySuccess || 'Code copié dans le presse-papiers !';

    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>${title}</title>
    <style>
        body {
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            margin: 0;
            padding: 20px;
            background: #1e1e1e;
            color: #d4d4d4;
        }
        .header {
            background: #252526;
            padding: 15px;
            margin: -20px -20px 20px -20px;
            border-bottom: 1px solid #3e3e42;
        }
        h1 {
            margin: 0 0 10px 0;
            font-size: 18px;
            color: #ffffff;
        }
        .info {
            font-size: 12px;
            color: #858585;
            margin-bottom: 10px;
        }
        .code-container {
            background: #1e1e1e;
            border: 1px solid #3e3e42;
            border-radius: 4px;
            overflow: auto;
            max-height: calc(100vh - 200px);
        }
        .code-wrapper {
            position: relative;
        }
        .line-numbers {
            position: absolute;
            left: 0;
            top: 0;
            background: #252526;
            color: #858585;
            padding: 10px 15px;
            border-right: 1px solid #3e3e42;
            font-size: 14px;
            line-height: 1.6;
            user-select: none;
            min-width: 50px;
            text-align: right;
        }
        .code-content {
            margin-left: 70px;
            padding: 10px 15px;
            font-size: 14px;
            line-height: 1.6;
            white-space: pre;
            overflow-x: auto;
        }
        .code-line {
            min-height: 22.4px;
        }
        .actions {
            margin-top: 15px;
            display: flex;
            gap: 10px;
        }
        button {
            background: #0e639c;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        }
        button:hover {
            background: #1177bb;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>${title}</h1>
        <div class="info">${description}</div>
    </div>
    <div class="code-container">
        <div class="code-wrapper">
            <div class="line-numbers" id="lineNumbers"></div>
            <div class="code-content" id="codeContent"></div>
        </div>
    </div>
    <div class="actions">
        <button onclick="copyCode()">${copyButton}</button>
        <button onclick="closeWindow()">${closeButton}</button>
    </div>
    <script>
        const code = ${JSON.stringify(code)};
        const lines = code.split('\\n');
        
        // Generate line numbers
        let lineNumbersHtml = '';
        let codeContentHtml = '';
        lines.forEach((line, index) => {
            lineNumbersHtml += '<div class="code-line">' + (index + 1) + '</div>';
            codeContentHtml += '<div class="code-line">' + escapeHtml(line) + '</div>';
        });
        
        document.getElementById('lineNumbers').innerHTML = lineNumbersHtml;
        document.getElementById('codeContent').innerHTML = codeContentHtml;
        
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        function copyCode() {
            navigator.clipboard.writeText(code).then(() => {
                alert('${copySuccess}');
            }).catch(err => {
                console.error('Copy error:', err);
            });
        }
        
        function closeWindow() {
            window.close();
        }
    </script>
</body>
</html>`;

    codeWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

/**
 * Embarque le code dans un FS MicroPython (`@microbit/microbit-fs`) et produit un HEX universel (v1+v2).
 * Convertit d’abord le MakeCode si des motifs sont détectés.
 */
async function compilePythonToHex(code: string): Promise<string> {
    logger.info('Compiling Python to HEX using microbit-fs (PythonEditor method)...');

    try {
        // Convert MakeCode code to standard MicroPython if needed
        let microPythonCode = code;
        if (code.includes('basic.') || code.includes('IconNames.') || code.includes('basic.forever')) {
            microPythonCode = convertMakeCodeToMicroPython(code);
        } else if (!microPythonCode.includes('from microbit import')) {
            // Add import if missing even for standard MicroPython code
            microPythonCode = 'from microbit import *\n\n' + microPythonCode;
        }

        // Load MicroPython runtimes V1 and V2
        const { v1Hex, v2Hex } = await ensureMicroPythonHexes();

        // Create MicroPython filesystem with both runtimes
        const fsHex = new MicropythonFsHex([
            { hex: v1Hex, boardId: microbitBoardId.V1 },
            { hex: v2Hex, boardId: microbitBoardId.V2 }
        ]);

        // Write Python code to main.py (like PythonEditor)
        fsHex.write('main.py', microPythonCode);

        // Generate universal HEX (V1 and V2 compatible)
        const hexContent = fsHex.getUniversalHex();

        logger.info('Compilation successful, HEX length:', hexContent.length);
        return hexContent;
    } catch (err) {
        logger.error('Error compiling Python to HEX:', err && err.stack ? err.stack : err);
        const errMsg = (err && err.message) ? err.message : (err && err.toString) ? err.toString() : translations.menu?.errors?.unknownError || 'Unknown error';
        throw new Error((translations.menu?.errors?.compileErrorPrefix || 'Compilation error: ') + errMsg);
    }
}

/**
 * Énumère les volumes micro:bit (Windows : lettres de lecteur ; Linux : montages ; macOS : `/Volumes`).
 * Met à jour la liste interne puis le menu via `updateMicrobitDrivesList`.
 */
function listMicrobitDrives(browserWindow: BrowserWindow | null): void {
    const drives = [];

    if (isWindows) {
        // Windows: list all drives and check for DETAILS.TXT
        exec('wmic logicaldisk get Name', (error, stdout) => {
            if (error) {
                logger.error(`Error listing drives: ${error.message || error}`);
                updateMicrobitDrivesList(drives, browserWindow);
                return;
            }

            // Parse drive letters (C:, D:, E:, etc.)
            const driveLetterMatches = stdout.matchAll(/([A-Z]):/gi);
            const driveLetters = [];
            for (const match of driveLetterMatches) {
                const driveLetter = match[1].toUpperCase() + ':';
                if (!driveLetters.includes(driveLetter)) {
                    driveLetters.push(driveLetter);
                }
            }

            // Check each drive for micro:bit DETAILS.TXT
            let checkedCount = 0;
            for (const driveLetter of driveLetters) {
                try {
                    if (isMicrobitDrive(driveLetter)) {
                        // Try to get the volume name
                        let volName = CONSTANTS.DEFAULT_MICROBIT_VOLUME_NAME;
                        try {
                            // Use spawnSync instead of execSync with shell to avoid error in built version
                            const result = spawnSync('wmic', ['logicaldisk', 'where', `Name='${driveLetter}'`, 'get', 'VolumeName'], {
                                encoding: 'utf8'
                            });
                            const volOutput = result.stdout || '';
                            const volLines = volOutput.split('\n').map(l => l.trim()).filter(Boolean);
                            for (const volLine of volLines) {
                                if (volLine && volLine !== 'VolumeName' && volLine.length > 0) {
                                    volName = volLine;
                                    break;
                                }
                            }
                        } catch (e) {
                            // Use default name
                        }

                        drives.push({
                            drive: driveLetter,
                            volName: volName
                        });
                    }
                } catch (e) {
                    // Ignore errors (drive may be inaccessible)
                }
                checkedCount++;
            }

            updateMicrobitDrivesList(drives, browserWindow);
        });
    } else if (!isMac) {
        // Linux : chercher dans /media et /mnt
        exec('lsblk -n -o MOUNTPOINT', (error, stdout) => {
            if (error) {
                logger.error(`Error listing mount points: ${error}`);
                updateMicrobitDrivesList(drives, browserWindow);
                return;
            }

            const mountPoints = stdout.split('\n').map(l => l.trim()).filter(Boolean);
            for (const mountPoint of mountPoints) {
                if (mountPoint.startsWith('/media/') || mountPoint.startsWith('/mnt/')) {
                    try {
                        const detailsPath = path.join(mountPoint, 'DETAILS.TXT');
                        if (isMicrobitDrive(mountPoint)) {
                            drives.push({
                                drive: mountPoint,
                                volName: path.basename(mountPoint) || CONSTANTS.DEFAULT_MICROBIT_VOLUME_NAME
                            });
                        }
                    } catch (e) {
                        // Ignorer les erreurs
                    }
                }
            }

            updateMicrobitDrivesList(drives, browserWindow);
        });
    } else if (isMac) {
        // macOS : chercher dans /Volumes
        try {
            const volumesDir = '/Volumes';
            if (fs.existsSync(volumesDir)) {
                const volumes = fs.readdirSync(volumesDir);
                for (const volume of volumes) {
                    const volumePath = path.join(volumesDir, volume);
                    try {
                        if (isMicrobitDrive(volumePath)) {
                            drives.push({
                                drive: volumePath,
                                volName: volume || CONSTANTS.DEFAULT_MICROBIT_VOLUME_NAME
                            });
                        }
                    } catch (e) {
                        // Ignorer les erreurs
                    }
                }
            }
        } catch (e) {
            logger.error('Error listing macOS volumes:', e);
        }

        updateMicrobitDrivesList(drives, browserWindow);
    }
}

/** Met à jour l’état sélectionné / menu quand la liste des lecteurs micro:bit change. */
function updateMicrobitDrivesList(drives: { drive: string; volName: string }[], browserWindow: BrowserWindow | null): void {
    const hasChanges = !areListsEqual(drives, previousMicrobitDrives);

    previousMicrobitDrives = drives;

    if (hasChanges) {
        refreshMenu();
        updateBoardStatusIcons();
    }

    if (hasChanges && browserWindow) {
        if (drives.length === 0) {
            selectedMicrobitDrive = null;
        } else {
            // Auto-sélectionner la première carte si aucune n'est sélectionnée
            if (!selectedMicrobitDrive || !drives.some(d => d.drive === selectedMicrobitDrive)) {
                selectedMicrobitDrive = drives[0].drive;
            }
        }
    }
}

/**
 * Menu / icône Arduino : extrait le code de l’éditeur, compile et téléverse sur le port sélectionné.
 */
function runArduinoUploadFlow(browserWindow: BrowserWindow | null) {
    const t = translations.menu;
    if (!browserWindow) return Promise.resolve();
    if (!selectedPort) {
        showNotification(browserWindow, t.uploadCode.notifications.noPort);
        return Promise.resolve();
    }
    const portExists = previousBoards.some(board => board.port === selectedPort);
    if (!portExists) {
        showNotification(browserWindow, t.uploadCode.notifications.falsePort);
        return Promise.resolve();
    }
    return extractCodeFromEditor(browserWindow)
        .then(code => {
            if (code === CONSTANTS.EMPTY_CODE) {
                showNotification(browserWindow, t.copyCode.notifications.empty);
                return;
            }
            return compileAndUploadArduino(code, selectedPort, browserWindow, translations.menu).catch(error => {
                logger.error('Error in Arduino upload process:', error);
                const errorMsg = error && error.message ? error.message : translations.menu?.errors?.unknownErrorUpload || 'Erreur inconnue lors de la compilation/téléversement';
                showNotification(browserWindow, t.uploadCode.notifications.error + '\n' + errorMsg);
            });
        })
        .catch(error => {
            logger.error('Error extracting code:', error);
            showNotification(browserWindow, t.copyCode.notifications.error);
        });
}

/**
 * Menu / icône micro:bit : extrait le code Python, nettoie / convertit MakeCode, génère le HEX et l’écrit sur `PROGRAM.HEX`.
 */
function runMicrobitUploadFlow(browserWindow: BrowserWindow | null) {
    const t = translations.menu;
    if (!browserWindow) return Promise.resolve();
    if (!selectedMicrobitDrive) {
        showNotification(browserWindow, t.microbit.notifications.noDrive || 'Aucune micro:bit sélectionnée');
        return Promise.resolve();
    }
    return extractCodeFromEditor(browserWindow, { useAdvancedSelectors: true })
        .then(code => {
            if (code === CONSTANTS.EMPTY_CODE) {
                showNotification(browserWindow, t.copyCode.notifications.empty);
                return;
            }
            let cleanedCode = cleanPythonCode(code);
            showNotification(browserWindow, t.compileCode.notifications.progress || 'Compilation en cours...');
            let microPythonCode = cleanedCode;
            if (isMakeCodePython(cleanedCode)) {
                microPythonCode = convertMakeCodeToMicroPython(cleanedCode);
            } else if (!microPythonCode.includes('from microbit import')) {
                microPythonCode = 'from microbit import *\n\n' + microPythonCode;
            }
            return compilePythonToHex(microPythonCode)
                .then(hexContent => {
                    showNotification(browserWindow, t.microbit.notifications.uploadProgress || 'Téléversement en cours...');
                    const finalPath = path.join(selectedMicrobitDrive, CONSTANTS.PROGRAM_HEX_FILENAME);
                    return new Promise((resolve, reject) => {
                        fs.writeFile(finalPath, hexContent, 'utf8', (err) => {
                            if (err) {
                                logger.error('Error writing HEX file to micro:bit:', err && err.stack ? err.stack : err);
                                showNotification(browserWindow, t.microbit.notifications.uploadError || 'Erreur lors de l\'écriture du fichier HEX');
                                reject(err);
                            } else {
                                logger.info('HEX file written successfully to', finalPath);
                                showNotification(browserWindow, t.microbit.notifications.uploadSuccess || 'Fichier HEX copié sur la carte micro:bit.');
                                resolve(undefined);
                            }
                        });
                    });
                })
                .catch(err => {
                    logger.error('Error compiling Python to HEX:', err && err.stack ? err.stack : err);
                    const errorMsg = (err && err.message) ? err.message : (err && err.toString) ? err.toString() : translations.menu?.errors?.unknownError || 'Erreur inconnue';
                    showNotification(browserWindow, (t.microbit.notifications.uploadError || 'Erreur de compilation') + '\n' + errorMsg);
                });
        })
        .catch(error => {
            logger.error('Error extracting code from editor:', error);
            showNotification(browserWindow, t.copyCode.notifications.error);
        });
}

/** Au démarrage : avertit si Arduino CLI ou HEX MicroPython manquent (téléchargement possible via les menus). */
async function checkRequiredBinaries(browserWindow: BrowserWindow | null): Promise<void> {
    const missingBinaries = [];
    
    // Check Arduino CLI
    if (!fs.existsSync(PATHS.arduinoCli)) {
        missingBinaries.push('Arduino CLI');
    }
    
    // Check MicroPython binaries
    const missingMicrobit = [];
    if (!fs.existsSync(PATHS.microbit.v1)) {
        missingMicrobit.push('MICROBIT_V1.hex');
    }
    if (!fs.existsSync(PATHS.microbit.v2)) {
        missingMicrobit.push('MICROBIT.hex');
    }
    
    if (missingBinaries.length > 0 || missingMicrobit.length > 0) {
        let message = '';
        const t = translations.menu;
        
        if (missingBinaries.length > 0) {
            message += (t.startup?.missingArduinoCli || 'Arduino CLI est introuvable.\n\n') +
                       (t.startup?.missingArduinoCliDetail || 'Le compilateur Arduino sera téléchargé automatiquement lors de la première utilisation.\n\n');
        }
        
        if (missingMicrobit.length > 0) {
            message += (t.startup?.missingMicrobitRuntimes || 'Les runtimes MicroPython sont introuvables :\n') +
                       missingMicrobit.join(', ') + '\n\n' +
                       (t.startup?.missingMicrobitDetail || 'Utilisez le menu "micro:bit > Installer MicroPython" pour les télécharger.');
        }
        
        if (browserWindow) {
            dialog.showMessageBox(browserWindow, {
                type: 'warning',
                title: t.startup?.warningTitle || 'Binaires manquants',
                message: t.startup?.warningMessage || 'Certains binaires requis sont introuvables',
                detail: message,
                buttons: [t.startup?.okButton || 'OK']
            }).catch(error => {
                logger.error('Error showing startup warning:', error);
            });
        }
    }
}

/**
 * Télécharge ou copie les HEX MicroPython v1/v2 (GitHub) vers le cache et les ressources utilisateur.
 */
async function installMicroPythonRuntimes(browserWindow: BrowserWindow | null): Promise<void> {
    try {
        const t = translations.menu;
        // Do not show start notification to avoid overlap
        // It will be replaced by the final message (success or error)

        const cacheDir = PATHS.microbit.cache;
        // Create cache directory with improved error handling
        try {
            if (!fs.existsSync(cacheDir)) {
                fs.mkdirSync(cacheDir, { recursive: true });
                fileCache.invalidate(cacheDir);
                logger.info(`Created micro:bit cache directory: ${cacheDir}`);
            }
        } catch (error) {
            logger.error(`Failed to create cache directory ${cacheDir}:`, error.message);
            if (browserWindow) {
                const msg = (translations.menu?.microbit?.notifications?.installErrorCacheDir || 'Erreur : impossible de créer le répertoire de cache.\n{message}\n\nVérifiez les permissions d\'écriture.').replace('{message}', error.message);
                showNotification(browserWindow, msg);
            }
            return;
        }

        // Check that the cache is writable (write test)
        const testFile = path.join(cacheDir, '.write-test');
        try {
            fs.writeFileSync(testFile, 'ok', 'utf8');
            fs.unlinkSync(testFile);
        } catch (error) {
            logger.error(`Cache directory not writable ${cacheDir}:`, error.message);
            if (browserWindow) {
                const msg = (t.microbit.notifications.installErrorCacheNotWritable || 'Le dossier de cache n\'est pas inscriptible.\n\nCache : {path}').replace('{path}', cacheDir);
                showNotification(browserWindow, msg);
            }
            return;
        }

        const v1Path = PATHS.microbit.v1;
        const v2Path = PATHS.microbit.v2;
        const v1Cache = path.join(cacheDir, 'MICROBIT_V1.hex');
        const v2Cache = path.join(cacheDir, 'MICROBIT.hex');

        let v1Hex = null;
        let v2Hex = null;
        let lastInstallError = null;

        // Check packaged resources first
        if (fileCache.exists(v1Path)) {
            v1Hex = fs.readFileSync(v1Path, 'utf8');
            if (v1Hex.trim().startsWith(':')) {
                safeExecute(() => {
                    fs.writeFileSync(v1Cache, v1Hex, 'utf8');
                    fileCache.invalidate(v1Cache);
                });
            }
        }
        if (fileCache.exists(v2Path)) {
            v2Hex = fs.readFileSync(v2Path, 'utf8');
            if (v2Hex.trim().startsWith(':')) {
                safeExecute(() => {
                    fs.writeFileSync(v2Cache, v2Hex, 'utf8');
                    fileCache.invalidate(v2Cache);
                });
            }
        }

        // Check cache
        if (!v1Hex && fileCache.exists(v1Cache)) {
            v1Hex = fs.readFileSync(v1Cache, 'utf8');
            if (!v1Hex.trim().startsWith(':')) v1Hex = null;
        }
        if (!v2Hex && fileCache.exists(v2Cache)) {
            v2Hex = fs.readFileSync(v2Cache, 'utf8');
            if (!v2Hex.trim().startsWith(':')) v2Hex = null;
        }

        // Download if needed
        if (!v1Hex) {
            try {
                // Récupérer l'URL depuis l'API GitHub
                const url = await getMicrobitV1HexUrl();
                if (url) {
                    logger.info(`Downloading MICROBIT_V1.hex from ${url}`);
                    const nameV1 = 'MICROBIT_V1.hex';
                    await downloadToFile(url, v1Cache, {
                        onProgress: ({ percent, received, total }) => {
                            if (!browserWindow) return;
                            const msg = total != null
                                ? (t.microbit.notifications.downloadHexProgress || '').replace('{name}', nameV1).replace('{percent}', Math.round(percent))
                                : (t.microbit.notifications.downloadHexProgressBytes || '').replace('{name}', nameV1).replace('{received}', (received / 1024 / 1024).toFixed(1));
                            if (msg) showNotification(browserWindow, msg);
                        }
                    });
                    v1Hex = fs.readFileSync(v1Cache, 'utf8');
                    if (v1Hex.trim().startsWith(':')) {
                        logger.info(`Successfully downloaded MICROBIT_V1.hex from ${url}`);
                    } else {
                        logger.warn(`Downloaded file does not appear to be a valid HEX file`);
                        v1Hex = null;
                    }
                } else {
                    logger.warn('Could not get micro:bit v1 HEX URL from GitHub API');
                    lastInstallError = 'URL V1 introuvable (GitHub API).';
                }
            } catch (e) {
                logger.error(`Failed to download MICROBIT_V1.hex:`, e.message || e);
                lastInstallError = (e && e.message) ? e.message : String(e);
            }
        }

        if (!v2Hex) {
            try {
                // Récupérer l'URL depuis l'API GitHub
                const url = await getMicrobitV2HexUrl();
                if (url) {
                    logger.info(`Downloading MICROBIT.hex from ${url}`);
                    const nameV2 = 'MICROBIT.hex';
                    await downloadToFile(url, v2Cache, {
                        onProgress: ({ percent, received, total }) => {
                            if (!browserWindow) return;
                            const msg = total != null
                                ? (t.microbit.notifications.downloadHexProgress || '').replace('{name}', nameV2).replace('{percent}', Math.round(percent))
                                : (t.microbit.notifications.downloadHexProgressBytes || '').replace('{name}', nameV2).replace('{received}', (received / 1024 / 1024).toFixed(1));
                            if (msg) showNotification(browserWindow, msg);
                        }
                    });
                    v2Hex = fs.readFileSync(v2Cache, 'utf8');
                    if (v2Hex.trim().startsWith(':')) {
                        logger.info(`Successfully downloaded MICROBIT.hex from ${url}`);
        } else {
                        logger.warn(`Downloaded file does not appear to be a valid HEX file`);
                        v2Hex = null;
                    }
                } else {
                    logger.warn('Could not get micro:bit v2 HEX URL from GitHub API');
                    if (!lastInstallError) lastInstallError = 'URL V2 introuvable (GitHub API).';
                }
            } catch (e) {
                logger.error(`Failed to download MICROBIT.hex:`, e.message || e);
                lastInstallError = (e && e.message) ? e.message : String(e);
            }
        }

        // Copier les fichiers téléchargés vers les chemins de ressources si nécessaire
        if (v1Hex && !fileCache.exists(v1Path)) {
            try {
                const v1Dir = path.dirname(v1Path);
                if (!fs.existsSync(v1Dir)) {
                    fs.mkdirSync(v1Dir, { recursive: true });
                }
                fs.copyFileSync(v1Cache, v1Path);
                logger.info(`Copied MICROBIT_V1.hex to resources: ${v1Path}`);
            } catch (e) {
                logger.warn(`Could not copy MICROBIT_V1.hex to resources: ${e.message}`);
            }
        }
        
        if (v2Hex && !fileCache.exists(v2Path)) {
            try {
                const v2Dir = path.dirname(v2Path);
                if (!fs.existsSync(v2Dir)) {
                    fs.mkdirSync(v2Dir, { recursive: true });
                }
                fs.copyFileSync(v2Cache, v2Path);
                logger.info(`Copied MICROBIT.hex to resources: ${v2Path}`);
    } catch (e) {
                logger.warn(`Could not copy MICROBIT.hex to resources: ${e.message}`);
            }
        }

        if (v1Hex && v2Hex) {
            showNotification(browserWindow, t.microbit.notifications.installSuccess || 'Runtimes MicroPython installés avec succès.');
        } else if (v1Hex || v2Hex) {
            const v1Status = v1Hex ? (t.microbit.notifications.v1Ok || 'V1: OK') : (t.microbit.notifications.v1Missing || 'V1: Manquant');
            const v2Status = v2Hex ? (t.microbit.notifications.v2Ok || 'V2: OK') : (t.microbit.notifications.v2Missing || 'V2: Manquant');
            const partialMsg = (t.microbit.notifications.installPartial || 'Installation partielle') + '\n' +
                (t.microbit.notifications.installPartialDetails || 'V1: {v1Status}, V2: {v2Status}')
                    .replace('{v1Status}', v1Status)
                    .replace('{v2Status}', v2Status);
            showNotification(browserWindow, partialMsg);
        } else {
            const genericDetail = t.microbit.notifications.installErrorDetailFallback || 'Vérifiez la connexion Internet et les droits d\'écriture du dossier de cache.';
            const detailText = lastInstallError || genericDetail;
            const detail = (t.microbit.notifications.installErrorDetail || 'Détail : {error}').replace('{error}', detailText);
            const cacheHint = cacheDir ? '\n\nCache : ' + cacheDir : '';
            showNotification(browserWindow, (t.microbit.notifications.installError || 'Impossible d\'installer les runtimes MicroPython.') + '\n\n' + detail + cacheHint);
        }
    } catch (e) {
        logger.error('Error installing MicroPython runtimes:', e);
        const te = translations.menu?.microbit?.notifications || {};
        const errMsg = e && e.message ? e.message : String(e);
        const detail = (te.installErrorDetail || 'Détail : {error}').replace('{error}', errMsg);
        showNotification(browserWindow, (te.installError || 'Erreur lors de l\'installation des runtimes MicroPython.') + '\n\n' + detail);
    }
}


/** Interroge `arduino-cli board list`, met à jour le menu des ports et la sélection courante. */
async function listArduinoBoards(browserWindow: BrowserWindow | null): Promise<void> {
    // Check if Arduino CLI is available (without auto-download)
    const arduinoCliAvailable = await ensureArduinoCli(browserWindow, false, translations.menu);
    if (!arduinoCliAvailable) {
        // If Arduino CLI is not available, update menu with empty list
        previousBoards = [];
        refreshMenu();
            return;
        }

    execCommand(buildArduinoCliCommand(`board list --json`), {
        browserWindow,
        showError: null,
        onSuccess: (stdout) => {
        // 1. Parse JSON: port.address and port.properties.vid for each item
        let parsed = parseBoardListJson(stdout);
        if (parsed.length === 0 && stdout.trim()) {
            parsed = parseBoardListText(stdout);
        }
        // 2. VID 0D28 = micro:bit → do not add; otherwise add port.address to menu
        const boards = buildArduinoMenuList(parsed);
        // 3. Compare to previous state; if nothing changed, do nothing
        const hasChanges = !boardListsEqual(boards, previousBoards);
        previousBoards = boards;

        if (hasChanges) {
            refreshMenu();
            updateBoardStatusIcons();
            if (boards.length === 0) {
                // Reset selection if no board is available
                selectedPort = null;
                // Do not show notification when no board is connected (normal)
            } else {
                // Auto-select first board if none is selected
                if (!selectedPort || !boards.some(b => b.port === selectedPort)) {
                    selectedPort = boards[0].port;
                    selectedBoard = boards[0].boardName;
                }
            }
        }
        },
        onError: (error) => {
            // If command fails, treat as empty list (no board connected)
            // Not a real error, just no boards present
            logger.debug(`No boards found or error (this is normal if no boards are connected): ${error}`);
            const hasChanges = previousBoards.length > 0;
            previousBoards = [];
            if (hasChanges) {
                selectedPort = null;
                refreshMenu();
                updateBoardStatusIcons();
            }
        }
    }).catch(error => {
        // Same here - treat as empty list
        logger.debug(`listArduinoBoards catch (no boards connected): ${error.message || error}`);
        const hasChanges = previousBoards.length > 0;
        previousBoards = [];
        if (hasChanges) {
            selectedPort = null;
            refreshMenu();
            updateBoardStatusIcons();
        }
    });
}

app.whenReady().then(() => {
    if (isWindows) {
        app.setAppUserModelId(app.name);
    }
    createWindow();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });

    // Initial language setup: use saved locale if present, otherwise system locale
    const savedLocale = getSavedLocale();
    const initialLocale = (savedLocale === 'fr' || savedLocale === 'en') ? savedLocale : systemLocale;
    switchLanguage(initialLocale);

    // Check required binaries at startup
    const mainWindow = getMainWindow();
    checkRequiredBinaries(mainWindow);

    // Initialize icon state at startup
    updateBoardStatusIcons();

    // Arduino board detection (once at startup, then at interval)
    listArduinoBoards(mainWindow).catch(() => {});
    boardDetectionInterval = setInterval(() => {
        listArduinoBoards(mainWindow).catch(() => {});
    }, DETECTION_INTERVAL);

    // micro:bit drive detection (once at startup, then at interval)
    listMicrobitDrives(mainWindow);
    microbitDetectionInterval = setInterval(() => {
        listMicrobitDrives(mainWindow);
    }, DETECTION_INTERVAL);
});

app.on('window-all-closed', function () {
    // Clear the board detection intervals
    if (boardDetectionInterval) {
        clearInterval(boardDetectionInterval);
    }
    if (microbitDetectionInterval) {
        clearInterval(microbitDetectionInterval);
    }

    if (!isMac) {
        app.quit();
    }
});

/** Recharge les traductions, persiste le choix, notifie les webcontents et reconstruit le menu. */
function switchLanguage(locale: string): void {
    const newTranslations = loadTranslations(locale) || loadTranslations('en');
    translations = newTranslations;
    currentLocale = locale;
    saveLocale(locale);
    BrowserWindow.getAllWindows().forEach(win => {
        win.webContents.send('language-changed', locale);
    });
    refreshMenu();
}

/**
 * Fabrique l’objet passé à `buildApplicationMenu` : traductions, références aux flux Arduino/micro:bit,
 * et accesseurs d’état (ports, lecteurs sélectionnés).
 */
function getMenuContext(): Record<string, unknown> {
    return {
        t: translations.menu,
        locale: currentLocale,
        getMainWindow,
        showNotification,
        path,
        directory,
        iconPath: PATHS.icon,
        BrowserWindow,
        Menu,
        clipboard,
        logger,
        dialog,
        shell,
        getSelectedPort: () => selectedPort,
        setSelectedPort: (v) => { selectedPort = v; },
        getSelectedBoard: () => selectedBoard,
        setSelectedBoard: (v) => { selectedBoard = v; },
        getSelectedMicrobitDrive: () => selectedMicrobitDrive,
        setSelectedMicrobitDrive: (v) => { selectedMicrobitDrive = v; },
        previousBoards,
        previousMicrobitDrives,
        runArduinoUploadFlow,
        runMicrobitUploadFlow,
        switchLanguage,
        buildArduinoCliCommand,
        execCommand,
        ensureArduinoCli,
        translations: { menu: translations.menu },
        executeScriptInWebview,
        CODE_EXTRACTION_SCRIPT,
        CONSTANTS,
        cleanPythonCode,
        isMakeCodePython,
        convertMakeCodeToMicroPython,
        validatePythonSyntaxWithDisplay,
        showConvertedCodeWindow,
        installMicroPythonRuntimes,
        checkForUpdates,
        packageInfo
    };
}

/** Envoie l’état des listes Arduino / micro:bit à la toolbar (preload) pour griser ou activer les icônes. */
function updateBoardStatusIcons(): void {
    const mainWindow = getMainWindow();
    if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('update-board-status', {
            arduino: previousBoards,
            microbit: previousMicrobitDrives
        });
    }
}

/** Reconstruit le menu à partir du contexte courant (après changement de langue ou de listes de cartes). */
function refreshMenu(): void {
    const template = buildApplicationMenu(getMenuContext());
    Menu.setApplicationMenu(Menu.buildFromTemplate(template as Electron.MenuItemConstructorOptions[]));
}
