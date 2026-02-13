/**
 * Tinkercad QHL - Point d'entrée Electron (processus principal)
 *
 * Organisation du fichier (pour maintenance) :
 * - Lignes ~28-120  : IPC (get-translation, get-icon-paths), handlers upload
 * - ~120-220        : Traductions, createWindow
 * - ~275-420        : Helpers (safeExecute, getMainWindow, areListsEqual, isMicrobitDrive)
 * - ~420-470        : loadHexFile, ensureMicroPythonHexes
 * - ~470-650        : showConvertedCodeWindow (fenêtre code converti)
 * - ~650-820        : compilePythonToHex (micro:bit)
 * - ~820-1010       : listMicrobitDrives, updateMicrobitDrivesList
 * - ~1010-1100      : runArduinoUploadFlow, runMicrobitUploadFlow
 * - ~1100-1320      : checkRequiredBinaries, installMicroPythonRuntimes
 * - ~1320-1450      : listArduinoBoards
 * - ~1450-1580      : app.whenReady, switchLanguage, getMenuContext, refreshMenu, updateBoardStatusIcons
 */
const { app, BrowserWindow, Menu, clipboard, ipcMain, webContents, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('fs');
const { exec } = require('child_process');
const { MicropythonFsHex, microbitBoardId } = require('@microbit/microbit-fs');

const { isDev, directory, directoryAppAsar, PATHS, getPortableDataDir, ensurePortableDataDir, getExtraResourcePath } = require('./lib/paths');
const { CONSTANTS, DETECTION_INTERVAL, MICROBIT_DETAILS_PATTERNS } = require('./lib/constants');
const { isMakeCodePython, convertMakeCodeToMicroPython } = require('./lib/microbitConversion');
const { cleanPythonCode, validatePythonSyntax, validatePythonSyntaxWithDisplay } = require('./lib/pythonUtils');
const { isWindows, isMac } = require('./lib/platform');
const { parseBoardListJson, parseBoardListText, buildArduinoMenuList, boardListsEqual } = require('./lib/boardDetection');
const { logger, logFile, DEBUG_FILE_LOGGING } = require('./lib/logger');
const { showNotification } = require('./lib/notifications');
const { getMicrobitV1HexUrl, getMicrobitV2HexUrl } = require('./lib/github');
const { checkForUpdates } = require('./lib/updates');
const { downloadToFile } = require('./lib/download');
const { CODE_EXTRACTION_SCRIPT, normalizeUnicode, executeScriptInWebview, extractCodeFromEditor } = require('./lib/codeExtraction');
const {
    buildArduinoCliCommand,
    execCommand,
    ensureArduinoCli,
    compileAndUploadArduino
} = require('./lib/arduino');
const { fileCache } = require('./lib/fileCache');
const { buildApplicationMenu } = require('./lib/menu');

const packageInfo = require('./package.json');

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
    // En mode production, les ressources sont dans extraResources
    // En mode développement, elles sont dans le dossier assets du projet
    let assetsDir;
    if (isDev()) {
        assetsDir = path.join(directory, 'assets');
    } else {
        // En production, extraResources avec "to": "../assets" sont copiés au niveau parent de resources/
        // Structure: app/ -> assets/, resources/ -> app.asar
        // Utiliser le chemin de l'exécutable pour trouver le dossier de l'application
        const exePath = process.execPath; // Chemin vers l'exécutable
        const appDir = path.dirname(exePath); // Dossier de l'application (win-unpacked/)
        assetsDir = path.join(appDir, 'assets');
        
        // Vérifier si le chemin existe, sinon essayer d'autres chemins
        if (!fs.existsSync(path.join(assetsDir, 'arduino-logo.svg'))) {
            // Fallback: essayer depuis resources/
            const fallbackPaths = [
                path.join(path.dirname(directoryAppAsar), 'assets'),  // ../assets depuis resources/
                path.join(directoryAppAsar, 'assets'),                  // assets/ dans resources/
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
    
    // Normaliser les chemins pour file:// (remplacer les backslashes par des slashes)
    // Sur Windows, les chemins absolus commencent par C:\..., donc file:///C:/...
    const normalizePath = (p) => {
        const resolved = path.resolve(p);
        let normalized = resolved.replace(/\\/g, '/');
        // S'assurer que les chemins Windows commencent par / pour file://
        if (normalized.match(/^[A-Z]:\//)) {
            normalized = '/' + normalized;
        }
        return normalized;
    };
    
    const arduinoIcon = path.join(assetsDir, 'arduino-logo.svg');
    const microbitIcon = path.join(assetsDir, 'Microbit_Hex.png');
    
    // Vérifier que les fichiers existent
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
// Cache pour les traductions chargées
const translationCache = new Map();

function loadTranslations(locale) {
    // Vérifier le cache d'abord
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

/** Retourne la langue mémorisée ('fr' ou 'en') ou null si absente/invalide */
function getSavedLocale() {
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

/** Enregistre le choix de langue dans le dossier portable (data/config.json) */
function saveLocale(locale) {
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

// Menu : construit au premier refreshMenu() (dans app.whenReady via switchLanguage(systemLocale))

/**
 * Crée la fenêtre principale de l'application Electron
 */
function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: 'Tinkercad QHL',
        icon: PATHS.icon,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.resolve(directory, 'preload.js'),
            webviewTag: true  // Nécessaire pour utiliser les balises <webview>
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

    // Ouvrir les DevTools automatiquement pour voir les logs de débogage (uniquement en développement)
    if (isDev()) {
        mainWindow.webContents.openDevTools();
    }
    
    // Afficher le chemin du fichier de log au démarrage (uniquement si mode debug activé)
    if (DEBUG_FILE_LOGGING) {
        logger.info(`Fichier de log: ${logFile}`);
        if (!isDev()) {
            mainWindow.webContents.once('did-finish-load', () => {
                showNotification(mainWindow, `Fichier de log: ${logFile}`);
            });
        }
    }

    // S'assurer que le titre reste "Tinkercad QHL" même après le chargement de la page
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
// HELPERS ET UTILITAIRES
// ============================================================================

logger.info('Application started');
if (DEBUG_FILE_LOGGING) {
    logger.info(`Log file: ${logFile}`);
}
logger.info(`Platform: ${isWindows ? 'win32' : isMac ? 'darwin' : 'linux'}`);
logger.info(`Node version: ${process.version}`);
logger.info(`Electron version: ${process.versions.electron}`);

/**
 * Exécute une fonction de manière sécurisée, en gérant les erreurs silencieusement
 * @param {Function} fn - La fonction à exécuter
 */
function safeExecute(fn) {
    try {
        fn();
    } catch (error) {
        // Ignorer les erreurs silencieusement
        logger.debug('safeExecute error:', error.message);
    }
}

// Obtenir la fenêtre principale avec vérification
function getMainWindow() {
    const windows = BrowserWindow.getAllWindows();
    return windows.length > 0 ? windows[0] : null;
}

// Obtenir la fenêtre principale en excluant une fenêtre spécifique
function getMainWindowExcluding(excludeWindow) {
    const windows = BrowserWindow.getAllWindows();
    return windows.find(w => w !== excludeWindow) || getMainWindow();
}

// Comparer deux listes d'objets de manière optimisée
function areListsEqual(list1, list2) {
    // Comparaison rapide de la longueur
    if (list1.length !== list2.length) {
        return false;
    }

    // Si les listes sont vides, elles sont égales
    if (list1.length === 0) {
        return true;
    }

    // Pour de petites listes, comparaison directe champ par champ est plus rapide
    if (list1.length <= 5) {
        for (let i = 0; i < list1.length; i++) {
            const item1 = list1[i];
            const item2 = list2[i];
            // Comparaison rapide des clés principales
            if (item1.port !== item2.port || item1.drive !== item2.drive ||
                item1.boardName !== item2.boardName || item1.volName !== item2.volName) {
                return false;
            }
        }
        return true;
    }

    // Pour de plus grandes listes, utiliser JSON.stringify (acceptable)
    return JSON.stringify(list1) === JSON.stringify(list2);
}

/**
 * Vérifie si un chemin correspond à un lecteur micro:bit
 * @param {string} drivePath - Le chemin du lecteur à vérifier
 * @returns {boolean} true si c'est un lecteur micro:bit, false sinon
 */
function isMicrobitDrive(drivePath) {
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

// Charger un fichier HEX (V1 ou V2)
/**
 * Charge un fichier HEX MicroPython (v1 ou v2) depuis les ressources ou le cache
 * @param {string} version - Version du micro:bit ('v1' ou 'v2')
 * @param {string} directoryAppAsar - Répertoire de l'application
 * @returns {string|null} Le contenu du fichier HEX ou null si introuvable
 */
function loadHexFile(version, directoryAppAsar) {
    const isV1 = version === 'v1';
    const hexFileName = isV1 ? 'MICROBIT_V1.hex' : 'MICROBIT.hex';
    const hexPath = hexFileName === 'MICROBIT_V1.hex' ? PATHS.microbit.v1 : PATHS.microbit.v2;
    const cacheDir = PATHS.microbit.cache;
    const cachePath = path.join(cacheDir, hexFileName);

    let hexContent = null;

    // Vérifier d'abord dans les ressources packagées
    if (fileCache.exists(hexPath)) {
        hexContent = fs.readFileSync(hexPath, 'utf8');
        if (hexContent.trim().startsWith(':')) {
            // Copier dans le cache pour usage futur
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

    // Vérifier dans le cache si pas trouvé dans les ressources
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

// Méthode PythonEditor : utiliser microbit-fs pour créer le HEX
// PythonEditor charge les runtimes MicroPython et écrit le code dans main.py
/**
 * S'assure que les fichiers HEX MicroPython sont disponibles
 * @returns {Promise<{v1Hex: string|null, v2Hex: string|null}>} Objet contenant les fichiers HEX
 * @throws {Error} Si aucun fichier HEX n'est trouvé
 */
async function ensureMicroPythonHexes() {

    const v1Hex = loadHexFile('v1', directoryAppAsar);
    const v2Hex = loadHexFile('v2', directoryAppAsar);

    if (!v1Hex || !v2Hex) {
        throw new Error(t.microbit.notifications.installErrorMissing || 'Fichiers HEX MicroPython introuvables. Utilisez "Micro:bit > Installer les runtimes" pour les télécharger.');
    }

    return { v1Hex, v2Hex };
}

// Afficher le code MicroPython converti dans une fenêtre
/**
 * Affiche une fenêtre avec le code MicroPython converti
 * @param {string} code - Le code MicroPython à afficher
 */
function showConvertedCodeWindow(code) {
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

    // Masquer complètement la barre de menu
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
        
        // Générer les numéros de ligne
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
                console.error('Erreur lors de la copie:', err);
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

// Compiler le code Python en HEX (méthode PythonEditor)
/**
 * Compile le code Python/MicroPython en fichier HEX pour micro:bit
 * @param {string} code - Le code Python/MicroPython à compiler
 * @returns {Promise<string>} Le contenu du fichier HEX généré
 * @throws {Error} Si la compilation échoue ou si les runtimes sont introuvables
 */
async function compilePythonToHex(code) {
    logger.info('Compiling Python to HEX using microbit-fs (PythonEditor method)...');

    try {
        // Convertir le code MakeCode en MicroPython standard si nécessaire
        let microPythonCode = code;
        if (code.includes('basic.') || code.includes('IconNames.') || code.includes('basic.forever')) {
            microPythonCode = convertMakeCodeToMicroPython(code);
        } else if (!microPythonCode.includes('from microbit import')) {
            // Ajouter l'import si absent même pour du code MicroPython standard
            microPythonCode = 'from microbit import *\n\n' + microPythonCode;
        }

        // Charger les runtimes MicroPython V1 et V2
        const { v1Hex, v2Hex } = await ensureMicroPythonHexes();

        // Créer le système de fichiers MicroPython avec les deux runtimes
        const fsHex = new MicropythonFsHex([
            { hex: v1Hex, boardId: microbitBoardId.V1 },
            { hex: v2Hex, boardId: microbitBoardId.V2 }
        ]);

        // Écrire le code Python dans main.py (comme PythonEditor)
        fsHex.write('main.py', microPythonCode);

        // Générer le HEX universel (compatible V1 et V2)
        const hexContent = fsHex.getUniversalHex();

        logger.info('Compilation successful, HEX length:', hexContent.length);
        return hexContent;
    } catch (err) {
        logger.error('Error compiling Python to HEX:', err && err.stack ? err.stack : err);
        const errMsg = (err && err.message) ? err.message : (err && err.toString) ? err.toString() : translations.menu?.errors?.unknownError || 'Erreur inconnue';
        throw new Error((translations.menu?.errors?.compileErrorPrefix || 'Erreur lors de la compilation: ') + errMsg);
    }
}

// Détecter les lecteurs micro:bit disponibles (comme listArduinoBoards)
/**
 * Liste les lecteurs micro:bit disponibles et met à jour le menu
 * @param {BrowserWindow|null} browserWindow - La fenêtre pour afficher les notifications
 */
function listMicrobitDrives(browserWindow) {
    const drives = [];

    if (isWindows) {
        // Windows : lister tous les lecteurs et vérifier la présence de DETAILS.TXT
        exec('wmic logicaldisk get Name', (error, stdout) => {
            if (error) {
                logger.error(`Error listing drives: ${error.message || error}`);
                updateMicrobitDrivesList(drives, browserWindow);
                return;
            }

            // Parser les lettres de lecteurs (C:, D:, E:, etc.)
            const driveLetterMatches = stdout.matchAll(/([A-Z]):/gi);
            const driveLetters = [];
            for (const match of driveLetterMatches) {
                const driveLetter = match[1].toUpperCase() + ':';
                if (!driveLetters.includes(driveLetter)) {
                    driveLetters.push(driveLetter);
                }
            }

            // Vérifier chaque lecteur pour la présence de DETAILS.TXT de micro:bit
            let checkedCount = 0;
            for (const driveLetter of driveLetters) {
                try {
                    if (isMicrobitDrive(driveLetter)) {
                        // Essayer de récupérer le nom du volume
                        let volName = CONSTANTS.DEFAULT_MICROBIT_VOLUME_NAME;
                        try {
                            // Utiliser spawnSync au lieu de execSync avec shell pour éviter l'erreur dans la version compilée
                            const { spawnSync } = require('child_process');
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
                            // Utiliser le nom par défaut
                        }

                        drives.push({
                            drive: driveLetter,
                            volName: volName
                        });
                    }
                } catch (e) {
                    // Ignorer les erreurs (lecteur peut être inaccessible)
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

// Mettre à jour la liste des lecteurs micro:bit détectés
function updateMicrobitDrivesList(drives, browserWindow) {
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
 * Flux unifié : extraire le code → compiler → téléverser sur Arduino
 * @param {BrowserWindow|null} browserWindow - Fenêtre pour les notifications
 * @returns {Promise<void>}
 */
function runArduinoUploadFlow(browserWindow) {
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
 * Flux unifié : extraire le code → nettoyer/convertir → compiler en HEX → écrire sur micro:bit
 * @param {BrowserWindow|null} browserWindow - Fenêtre pour les notifications
 * @returns {Promise<void>}
 */
function runMicrobitUploadFlow(browserWindow) {
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
                                resolve();
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

/**
 * Vérifie les binaires requis (Arduino CLI et MicroPython) au démarrage
 * @param {BrowserWindow|null} browserWindow - La fenêtre pour afficher les popups
 */
async function checkRequiredBinaries(browserWindow) {
    const missingBinaries = [];
    
    // Vérifier Arduino CLI
    if (!fs.existsSync(PATHS.arduinoCli)) {
        missingBinaries.push('Arduino CLI');
    }
    
    // Vérifier les binaires MicroPython
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
 * Installe les runtimes MicroPython (v1 et v2) depuis les ressources ou en les téléchargeant
 * @param {BrowserWindow|null} browserWindow - La fenêtre pour afficher les notifications
 */
async function installMicroPythonRuntimes(browserWindow) {
    try {
        const t = translations.menu;
        // Ne pas afficher la notification de début pour éviter la superposition
        // Elle sera remplacée par le message final (succès ou erreur)

        const cacheDir = PATHS.microbit.cache;
        // Créer le répertoire de cache avec gestion d'erreur améliorée
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

        // Vérifier que le cache est bien inscriptible (test d'écriture)
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

        // Vérifier d'abord dans les ressources packagées
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

        // Vérifier dans le cache
        if (!v1Hex && fileCache.exists(v1Cache)) {
            v1Hex = fs.readFileSync(v1Cache, 'utf8');
            if (!v1Hex.trim().startsWith(':')) v1Hex = null;
        }
        if (!v2Hex && fileCache.exists(v2Cache)) {
            v2Hex = fs.readFileSync(v2Cache, 'utf8');
            if (!v2Hex.trim().startsWith(':')) v2Hex = null;
        }

        // Télécharger si nécessaire
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


async function listArduinoBoards(browserWindow) {
    // Vérifier si Arduino CLI est disponible (sans téléchargement automatique)
    const arduinoCliAvailable = await ensureArduinoCli(browserWindow, false, translations.menu);
    if (!arduinoCliAvailable) {
        // Si Arduino CLI n'est pas disponible, mettre à jour le menu avec une liste vide
        previousBoards = [];
        refreshMenu();
            return;
        }

    execCommand(buildArduinoCliCommand(`board list --json`), {
        browserWindow,
        showError: null,
        onSuccess: (stdout) => {
        // 1. Parser le JSON : port.address et port.properties.vid pour chaque objet
        let parsed = parseBoardListJson(stdout);
        if (parsed.length === 0 && stdout.trim()) {
            parsed = parseBoardListText(stdout);
        }
        // 2. VID 0D28 = micro:bit → on ne l'ajoute pas ; sinon on ajoute port.address au menu
        const boards = buildArduinoMenuList(parsed);
        // 3. Comparer à l'état précédent ; si rien n'a changé, ne rien faire
        const hasChanges = !boardListsEqual(boards, previousBoards);
        previousBoards = boards;

        if (hasChanges) {
            refreshMenu();
            updateBoardStatusIcons();
            if (boards.length === 0) {
                // Réinitialiser la sélection si aucune carte n'est disponible
                selectedPort = null;
                // Ne pas afficher de notification si aucune carte n'est connectée (c'est normal)
            } else {
                // Auto-sélectionner la première carte si aucune n'est sélectionnée
                if (!selectedPort || !boards.some(b => b.port === selectedPort)) {
                    selectedPort = boards[0].port;
                    selectedBoard = boards[0].boardName;
                }
            }
        }
        },
        onError: (error) => {
            // Si la commande échoue, traiter comme une liste vide (aucune carte connectée)
            // Ce n'est pas une vraie erreur, juste qu'il n'y a pas de cartes
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
        // Même chose ici - traiter comme une liste vide
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

    // Initial language setup : langue mémorisée si présente, sinon langue système
    const savedLocale = getSavedLocale();
    const initialLocale = (savedLocale === 'fr' || savedLocale === 'en') ? savedLocale : systemLocale;
    switchLanguage(initialLocale);

    // Vérifier les binaires requis au démarrage
    const mainWindow = getMainWindow();
    checkRequiredBinaries(mainWindow);

    // Initialiser l'état des icônes au démarrage
    updateBoardStatusIcons();

    // Détection des cartes Arduino (une fois au démarrage, puis à intervalle)
    listArduinoBoards(mainWindow).catch(() => {});
    boardDetectionInterval = setInterval(() => {
        listArduinoBoards(mainWindow).catch(() => {});
    }, DETECTION_INTERVAL);

    // Détection des lecteurs micro:bit (une fois au démarrage, puis à intervalle)
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

/**
 * Change la langue de l'interface utilisateur
 * @param {string} locale - Code de langue ('fr' ou 'en')
 */
function switchLanguage(locale) {
    const newTranslations = loadTranslations(locale) || loadTranslations('en');
    translations = newTranslations;
    currentLocale = locale;
    saveLocale(locale);
    BrowserWindow.getAllWindows().forEach(win => {
        win.webContents.send('language-changed', locale);
    });
    refreshMenu();
}

function getMenuContext() {
    return {
        t: translations.menu,
        locale: currentLocale,
        getMainWindow,
        showNotification,
        path,
        directory,
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

/**
 * Met à jour l'état des icônes dans la barre d'outils selon la disponibilité des cartes
 */
function updateBoardStatusIcons() {
    const mainWindow = getMainWindow();
    if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('update-board-status', {
            arduino: previousBoards,
            microbit: previousMicrobitDrives
        });
    }
}

/**
 * Rafraîchit le menu de l'application en reconstruisant tous les sous-menus
 */
function refreshMenu() {
    const template = buildApplicationMenu(getMenuContext());
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
