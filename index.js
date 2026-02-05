const { app, BrowserWindow, Menu, clipboard, ipcMain, webContents } = require('electron');
const path = require('node:path');
const https = require('https');
const fs = require('fs');
const { exec, execSync, spawn, execFile } = require('child_process');
const { MicropythonFsHex, microbitBoardId } = require('@microbit/microbit-fs');

/**
 * Détecte si l'application est en mode développement (non packagée)
 * @returns {boolean} true si en mode développement, false si packagée
 */
function isDev() {
  return !app.getAppPath().includes('app.asar');
}
const directory = isDev() ? __dirname : app.getAppPath();
// En production, extraResources est dans le même dossier que app.asar (resources/)
// app.getAppPath() retourne le chemin vers app.asar, donc path.dirname() donne resources/
const directoryAppAsar = isDev() ? directory : path.dirname(directory);

// ============================================================================
// CONSTANTES
// ============================================================================
const CONSTANTS = {
    EMPTY_CODE: 'empty',
    PROGRAM_HEX_FILENAME: 'PROGRAM.HEX',
    LINE_BREAK: '\\r\\n',
    NOTIFICATION_DELAY: 300,        // Délai d'animation de notification (ms)
    NOTIFICATION_DURATION: 3000,    // Durée d'affichage de la notification (ms)
    DEFAULT_MICROBIT_VOLUME_NAME: 'MICROBIT'  // Nom par défaut du volume micro:bit
};

// ============================================================================
// CHEMINS PRINCIPAUX
// ============================================================================
// Déterminer le nom de l'exécutable Arduino CLI selon la plateforme
const getArduinoCliExecutable = () => {
    let basePath;
    if (isDev()) {
        basePath = path.join(directoryAppAsar, './arduino');
    } else {
        // En production, extraResources avec "to": "../arduino" sont au niveau parent de resources/
        const exePath = process.execPath;
        const appDir = path.dirname(exePath);
        basePath = path.join(appDir, 'arduino');
    }
    
    if (process.platform === 'win32') {
        return path.join(basePath, 'arduino-cli.exe');
    } else if (process.platform === 'darwin') {
        return path.join(basePath, 'arduino-cli');
    } else {
        // Linux
        return path.join(basePath, 'arduino-cli');
    }
};

// Fonction helper pour obtenir le chemin des extraResources en production
const getExtraResourcePath = (resourceName) => {
    if (isDev()) {
        return path.join(directoryAppAsar, resourceName);
    } else {
        // En production, extraResources avec "to": "../resourceName" sont au niveau parent de resources/
        const exePath = process.execPath;
        const appDir = path.dirname(exePath);
        return path.join(appDir, resourceName);
    }
};

/**
 * Dossier de données portable (à côté de l'exécutable en prod, du projet en dev).
 * Permet une utilisation 100 % portable : aucun écrit dans AppData / userData.
 */
function getPortableDataDir() {
    const appDir = isDev() ? __dirname : path.dirname(process.execPath);
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
    sketch: path.join(directory, 'sketch', 'sketch.ino'),
    locales: path.join(directory, 'locales'),
    icon: path.join(directory, 'autodesk-tinkercad.png'),
    preload: path.join(directory, 'preload.js'),
    microbit: {
        v1: path.join(getExtraResourcePath('microbit'), 'MICROBIT_V1.hex'),
        v2: path.join(getExtraResourcePath('microbit'), 'MICROBIT.hex'),
        cache: path.join(getPortableDataDir(), 'microbit-cache')
    }
};

// ============================================================================
// SCRIPTS JAVASCRIPT POUR L'EXTRACTION DE CODE
// ============================================================================
// Fonction helper pour normaliser le texte dans le script d'extraction
// Note: Cette fonction est utilisée dans le script JavaScript exécuté dans le navigateur
// Les helpers Node.js (normalizeQuotes, normalizeDashes) ne peuvent pas être utilisés ici
const CODE_EXTRACTION_SCRIPT = `
    (() => {
        // Essayer plusieurs sélecteurs pour trouver l'éditeur
        let editorElement = document.querySelector('.CodeMirror-code');
        if (!editorElement) {
            editorElement = document.querySelector('.CodeMirror-lines');
        }
        if (!editorElement) {
            editorElement = document.querySelector('.cm-editor .cm-content');
        }
        if (!editorElement) {
            editorElement = document.querySelector('[class*="CodeMirror"]');
        }
        if (!editorElement) {
            // Chercher dans les éléments avec du code Python visible
            const codeContainers = document.querySelectorAll('[class*="code"], [class*="editor"], [class*="program"], pre, code');
            for (const container of codeContainers) {
                const text = container.textContent || container.innerText;
                if (text && text.trim().length > 10 && 
                    (text.includes('def ') || text.includes('import ') || text.includes('basic.') || text.includes('input.'))) {
                    editorElement = container;
                    break;
                }
            }
        }
        
        if (!editorElement) {
            return '${CONSTANTS.EMPTY_CODE}';
        }
        const clonedElement = editorElement.cloneNode(true);
        const gutterWrappers = clonedElement.querySelectorAll('.CodeMirror-gutter-wrapper, .cm-gutter, [class*="gutter"]');
        gutterWrappers.forEach(wrapper => wrapper.remove());
        
        // Essayer plusieurs méthodes d'extraction
        let codeText = '';
        const preElements = clonedElement.querySelectorAll('pre');
        if (preElements.length > 0) {
            codeText = Array.from(preElements)
                .map(pre => pre.textContent || pre.innerText || '')
                .join('\\r\\n');
        } else {
            // Fallback: texte direct
            codeText = clonedElement.textContent || clonedElement.innerText || '';
        }
        
        if (codeText) {
            codeText = codeText
                .replace(/[\\u2018\\u2019\\u201C\\u201D]/g, '"')  // Normaliser les guillemets
                .replace(/[\\u2013\\u2014]/g, '-')                // Normaliser les tirets
                .replace(/[\\u200B]/g, '')                         // Supprimer les espaces insécables
                .trim();
        }
        
        return codeText && codeText !== 'undefined' && codeText.length > 0 ? codeText : '${CONSTANTS.EMPTY_CODE}';
    })()
`;


// ============================================================================
// CACHE POUR LES VÉRIFICATIONS DE FICHIERS
// ============================================================================
const fileCache = {
    _cache: new Map(),
    _timestamps: new Map(),
    TTL: 5000, // 5 secondes

    exists(path) {
        const now = Date.now();
        const cached = this._cache.get(path);
        const timestamp = this._timestamps.get(path);

        if (cached !== undefined && timestamp && (now - timestamp) < this.TTL) {
            return cached;
        }

        const exists = fs.existsSync(path);
        this._cache.set(path, exists);
        this._timestamps.set(path, now);
        return exists;
    },

    invalidate(path) {
        this._cache.delete(path);
        this._timestamps.delete(path);
    },

    clear() {
        this._cache.clear();
        this._timestamps.clear();
    }
};

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
    if (mainWindow) {
        // Simuler le clic sur le menu "Téléverser le programme" Arduino
        const t = translations.menu;
        if (!selectedPort) {
            showNotification(mainWindow, t.uploadCode.notifications.noPort);
            return;
        }
        const portExists = previousBoards.some(board => board.port === selectedPort);
        if (!portExists) {
            showNotification(mainWindow, t.uploadCode.notifications.falsePort);
            return;
        }
        extractCodeFromEditor(mainWindow).then(code => {
            if (code === CONSTANTS.EMPTY_CODE) {
                showNotification(mainWindow, t.copyCode.notifications.empty);
                return;
            }
            compileAndUploadArduino(code, selectedPort, mainWindow).catch(error => {
                logger.error('Error in Arduino upload process:', error);
            });
        }).catch(error => {
            logger.error('Error extracting code:', error);
            showNotification(mainWindow, t.copyCode.notifications.error);
        });
    }
});

ipcMain.on('upload-microbit', (event) => {
    const mainWindow = BrowserWindow.fromWebContents(event.sender);
    if (mainWindow) {
        // Simuler le clic sur le menu "Téléverser le programme" micro:bit
        const t = translations.menu;
        if (!selectedMicrobitDrive) {
            showNotification(mainWindow, t.microbit.notifications.noDrive || 'Aucune micro:bit sélectionnée');
            return;
        }
        extractCodeFromEditor(mainWindow, { useAdvancedSelectors: true }).then(code => {
            if (code === CONSTANTS.EMPTY_CODE) {
                showNotification(mainWindow, t.copyCode.notifications.empty);
                return;
            }
            // Utiliser la même logique que le menu micro:bit
            let microPythonCode = code;
            if (code.includes('basic.') || code.includes('IconNames.') || code.includes('basic.forever')) {
                microPythonCode = convertMakeCodeToMicroPython(code);
            } else if (!microPythonCode.includes('from microbit import')) {
                microPythonCode = 'from microbit import *\n\n' + microPythonCode;
            }
            
            compilePythonToHex(microPythonCode).then(hexContent => {
                const firmwareName = CONSTANTS.PROGRAM_HEX_FILENAME;
                const finalPath = path.join(selectedMicrobitDrive, firmwareName);
                fs.writeFile(finalPath, hexContent, 'utf8', (err) => {
                    if (err) {
                        logger.error('Error writing HEX file to micro:bit:', err && err.stack ? err.stack : err);
                        showNotification(mainWindow, t.microbit.notifications.uploadError || 'Erreur lors de l\'écriture du fichier HEX');
                        return;
                    }
                    logger.info('HEX file written successfully to', finalPath);
                    showNotification(mainWindow, t.microbit.notifications.uploadSuccess || 'Fichier HEX copié sur la carte micro:bit.');
                });
            }).catch(err => {
                logger.error('Error compiling Python to HEX:', err && err.stack ? err.stack : err);
                const errorMsg = (err && err.message) ? err.message : (err && err.toString) ? err.toString() : 'Erreur inconnue';
                showNotification(mainWindow, (t.microbit.notifications.uploadError || 'Erreur de compilation') + '\n' + errorMsg);
            });
        }).catch(error => {
            logger.error('Error extracting code from editor:', error);
            showNotification(mainWindow, t.copyCode.notifications.error);
        });
    }
});

ipcMain.on('install-library', (event, libraryName) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const mainWindow = getMainWindowExcluding(win);

    if (!libraryName) {
        if (mainWindow) showNotification(mainWindow, t.installLibrary.notifications.empty);
        return;
    }

    if (mainWindow) showNotification(mainWindow, t.installLibrary.notifications.progress);

    execCommand(buildArduinoCliCommand(`lib install ${libraryName}`), {
        browserWindow: mainWindow,
        showError: t.installLibrary.notifications.error,
        showSuccess: t.installLibrary.notifications.success,
        onSuccess: () => { if (win) win.close(); },
        onError: () => { if (win) win.close(); }
    }).catch(error => {
        logger.error(`Error installing library: ${error}`);
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

// Get system locale and handle language code extraction
const rawLocale = app.getLocale();
const systemLocale = rawLocale ? rawLocale.split('-')[0] : 'en';
let translations = loadTranslations(systemLocale);
let currentLocale = systemLocale;
let selectedBoard = "";

// Only fallback to English if the translation file doesn't exist or is invalid
if (!translations) {
    logger.info(`No translations found for ${systemLocale}, falling back to English`);
    translations = loadTranslations('en');
}

// Create custom menu template
const t = translations.menu;
const template = [
    {
        label: t.file.label,
        submenu: [
            {
                label: t.file.language,
                submenu: [
                    {
                        label: 'English',
                        type: 'radio',
                        checked: systemLocale === 'en',
                        click: () => switchLanguage('en')
                    },
                    {
                        label: 'Français',
                        type: 'radio',
                        checked: systemLocale === 'fr',
                        click: () => switchLanguage('fr')
                    }
                ]
            },
            { type: 'separator' },
            { role: 'quit', label: t.file.quit }
        ]
    }
];

// Build menu from template
const menu = Menu.buildFromTemplate(template);

// Set the custom menu
Menu.setApplicationMenu(menu);

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
            preload: PATHS.preload,
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
        require('electron').shell.openExternal(url);
        return { action: 'deny' };
    });
}

// ============================================================================
// CONSTANTES
// ============================================================================
const DETECTION_INTERVAL = 2000; // Intervalle de détection des cartes (ms)
const PWM_DUTY_CYCLE = 512; // Duty cycle pour PWM (50%)

// Patterns de détection pour micro:bit
const MICROBIT_DETAILS_PATTERNS = [
    'DAPLink',
    'Interface Version',
    'HIC ID',
    'Unique ID:',
    'Version:'
];

// Patterns de détection pour code MakeCode Python
const MAKECODE_PATTERNS = [
    'basic.',
    'IconNames.',
    'basic.forever',
    'input.on_',
    'pins.analog_pitch'
];

// ============================================================================
// HELPERS ET UTILITAIRES
// ============================================================================

// Mode debug fichier : activé par TINKERCAD_DEBUG=1 (npm run start:debug) ou par build:win:debug
let DEBUG_FILE_LOGGING = false;
try {
    DEBUG_FILE_LOGGING = process.env.TINKERCAD_DEBUG === '1' || require('./debug-mode.js');
} catch (e) {
    DEBUG_FILE_LOGGING = false;
}

ensurePortableDataDir();
const logFile = path.join(getPortableDataDir(), 'debug.log');
const logStream = DEBUG_FILE_LOGGING ? fs.createWriteStream(logFile, { flags: 'a' }) : null;

function writeLog(level, ...args) {
    const timestamp = new Date().toISOString();
    const message = `[${timestamp}] [${level}] ${args.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ')}\n`;

    if (logStream) {
        try {
            logStream.write(message);
        } catch (err) {
            // Ignorer les erreurs d'écriture
        }
    }

    // Aussi dans la console
    if (level === 'DEBUG') {
        console.log('[DEBUG]', ...args);
    } else if (level === 'INFO') {
        console.log('[INFO]', ...args);
    } else if (level === 'WARN') {
        console.warn('[WARN]', ...args);
    } else if (level === 'ERROR') {
        console.error('[ERROR]', ...args);
    }
}

const logger = {
    debug: (...args) => {
        writeLog('DEBUG', ...args);
    },
    info: (...args) => {
        writeLog('INFO', ...args);
    },
    warn: (...args) => {
        writeLog('WARN', ...args);
    },
    error: (...args) => {
        writeLog('ERROR', ...args);
    }
};

// Logger le démarrage
logger.info('Application started');
if (DEBUG_FILE_LOGGING) {
    logger.info(`Log file: ${logFile}`);
}
logger.info(`Platform: ${process.platform}`);
logger.info(`Node version: ${process.version}`);
logger.info(`Electron version: ${process.versions.electron}`);

// Obtenir le répertoire app.asar de manière cohérente
function getAppAsarDirectory() {
    return directoryAppAsar;
}

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

/**
 * Construit la commande Arduino CLI avec le fichier de configuration
 * @param {string} arduinoCommand - La commande Arduino CLI (sans l'exécutable)
 * @returns {string} La commande complète avec l'exécutable et le fichier de configuration
 */
function buildArduinoCliCommand(arduinoCommand) {
    const configFile = PATHS.arduinoConfig;
    // Avec shell: true, utiliser des guillemets pour protéger les chemins avec espaces
    // Fonctionne de manière universelle sur Windows, Linux et macOS
    // Le shell interprétera correctement les guillemets sur toutes les plateformes
    
    // Utiliser --config-file si le fichier existe, sinon Arduino CLI utilisera le fichier par défaut
    if (fs.existsSync(configFile)) {
        return `"${PATHS.arduinoCli}" --config-file "${configFile}" ${arduinoCommand}`;
    }
    return `"${PATHS.arduinoCli}" ${arduinoCommand}`;
}

// Exécuter une commande avec gestion d'erreur unifiée
/**
 * Exécute une commande système avec gestion d'erreur unifiée
 * @param {string} command - La commande à exécuter
 * @param {Object} options - Options de configuration
 * @param {Function} options.onSuccess - Callback en cas de succès
 * @param {Function} options.onError - Callback en cas d'erreur
 * @param {string} options.showProgress - Message de progression à afficher
 * @param {string} options.showSuccess - Message de succès à afficher
 * @param {string} options.showError - Message d'erreur à afficher
 * @param {BrowserWindow|null} options.browserWindow - Fenêtre pour les notifications
 * @returns {Promise<{stdout: string, stderr: string}>} Résultat de la commande
 */
function execCommand(command, options = {}) {
    return new Promise((resolve, reject) => {
        const {
            onSuccess = () => { },
            onError = (error) => logger.error(`Command failed: ${error}`),
            showProgress = null,
            showSuccess = null,
            showError = null,
            browserWindow = null,
            cwd = null
        } = options;

        if (showProgress && browserWindow) {
            showNotification(browserWindow, showProgress);
        }

        // Parser la commande pour utiliser spawn avec des arguments séparés
        // Cela évite l'erreur "spawn cmd.exe ENOENT" dans la version compilée
        const execOptions = { 
            cwd: cwd || directory
        };
        
        // Si la commande commence par un chemin entre guillemets, c'est une commande Arduino CLI
        // Parser la commande pour extraire l'exécutable et les arguments
        let executable, args;
        if (command.startsWith('"') && command.includes('"', 1)) {
            // Commande avec guillemets : "path/to/exe" arg1 arg2
            const endQuote = command.indexOf('"', 1);
            executable = command.substring(1, endQuote);
            const rest = command.substring(endQuote + 1).trim();
            // Parser les arguments restants (supporter les guillemets dans les arguments)
            args = [];
            let currentArg = '';
            let inQuotes = false;
            for (let i = 0; i < rest.length; i++) {
                const char = rest[i];
                if (char === '"') {
                    inQuotes = !inQuotes;
                } else if (char === ' ' && !inQuotes) {
                    if (currentArg) {
                        args.push(currentArg);
                        currentArg = '';
                    }
                } else {
                    currentArg += char;
                }
            }
            if (currentArg) {
                args.push(currentArg);
            }
            
            logger.debug(`[DEBUG] Parsed command: executable="${executable}", args=${JSON.stringify(args)}`);
            
            // Normaliser le chemin de l'exécutable
            executable = path.normalize(executable);
            
            // Vérifier que l'exécutable existe avant de lancer spawn
            if (!fs.existsSync(executable)) {
                const error = new Error(`Executable not found: ${executable}`);
                logger.error(`[DEBUG] Executable does not exist: ${executable}`);
                logger.error(`[DEBUG] Current working directory: ${execOptions.cwd}`);
                logger.error(`[DEBUG] Resolved executable path: ${path.resolve(executable)}`);
                onError(error);
                if (showError && browserWindow) {
                    showNotification(browserWindow, showError);
                }
                reject(error);
                return;
            }
            
            // Vérifier les permissions
            try {
                const stats = fs.statSync(executable);
                logger.debug(`[DEBUG] Executable stats: mode=${stats.mode}, size=${stats.size}`);
            } catch (statError) {
                logger.warn(`[DEBUG] Could not stat executable: ${statError.message}`);
            }
            
            logger.debug(`[DEBUG] About to execute: ${executable} with args: ${JSON.stringify(args)}`);
            
            // Utiliser execFile avec le répertoire de l'exécutable comme cwd
            // Cela aide Windows à trouver les DLL nécessaires dans le même répertoire
            const executableDir = path.dirname(executable);
            const execFileOptions = {
                ...execOptions,
                cwd: executableDir, // Utiliser le répertoire de l'exécutable comme répertoire de travail
                env: {
                    ...process.env,
                    PATH: `${executableDir}${path.delimiter}${process.env.PATH}` // Ajouter le répertoire de l'exécutable au PATH
                }
            };
            
            logger.debug(`[DEBUG] Using execFile with cwd: ${executableDir}`);
            logger.debug(`[DEBUG] PATH: ${execFileOptions.env.PATH.substring(0, 200)}...`);
            
            execFile(executable, args, execFileOptions, (error, stdout, stderr) => {
                if (error) {
                    logger.error(`[DEBUG] execFile error: ${error.message}`);
                    logger.error(`[DEBUG] Error code: ${error.code}`);
                    logger.error(`[DEBUG] Error signal: ${error.signal}`);
                    logger.error(`[DEBUG] Executable path: ${executable}`);
                    logger.error(`[DEBUG] Executable exists: ${fs.existsSync(executable)}`);
                    logger.error(`[DEBUG] Executable directory: ${executableDir}`);
                    logger.error(`[DEBUG] Executable directory exists: ${fs.existsSync(executableDir)}`);
                    
                    // Lister les fichiers dans le répertoire de l'exécutable pour voir les DLL
                    try {
                        const dirContents = fs.readdirSync(executableDir);
                        logger.debug(`[DEBUG] Files in executable directory: ${JSON.stringify(dirContents.slice(0, 10))}`);
                    } catch (dirError) {
                        logger.error(`[DEBUG] Could not read executable directory: ${dirError.message}`);
                    }
                    
                    onError(error);
                    if (showError && browserWindow) {
                        showNotification(browserWindow, showError);
                    }
                    reject(error);
                    return;
                }
                onSuccess(stdout, stderr);
                if (showSuccess && browserWindow) {
                    showNotification(browserWindow, showSuccess);
                }
                resolve({ stdout, stderr });
            });
        } else {
            // Commande simple sans guillemets, utiliser exec normalement
            exec(command, execOptions, (error, stdout, stderr) => {
                if (error) {
                    onError(error);
                    if (showError && browserWindow) {
                        showNotification(browserWindow, showError);
                    }
                    reject(error);
                    return;
                }
                onSuccess(stdout, stderr);
                if (showSuccess && browserWindow) {
                    showNotification(browserWindow, showSuccess);
                }
                resolve({ stdout, stderr });
            });
        }
    });
}

/**
 * Compile et téléverse le code Arduino sur la carte
 * @param {string} code - Le code Arduino à compiler et téléverser
 * @param {string} port - Le port série de la carte Arduino
 * @param {BrowserWindow|null} browserWindow - La fenêtre pour afficher les notifications
 * @returns {Promise<void>}
 * @throws {Error} Si la compilation ou le téléversement échoue
 */
async function compileAndUploadArduino(code, port, browserWindow) {
    const t = translations.menu;
    try {
        // Vérifier et télécharger Arduino CLI si nécessaire
        const arduinoCliAvailable = await ensureArduinoCli(browserWindow);
        if (!arduinoCliAvailable) {
            throw new Error('Arduino CLI n\'est pas disponible');
        }
        
        // S'assurer que le dossier sketch existe
        const sketchDir = path.dirname(PATHS.sketch);
        if (!fs.existsSync(sketchDir)) {
            fs.mkdirSync(sketchDir, { recursive: true });
        }
        
        // Écrire le fichier sketch
        fs.writeFileSync(PATHS.sketch, code, 'utf8');

        // Compiler (le répertoire de travail doit être le parent du dossier sketch)
        await execCommand(buildArduinoCliCommand(`compile --fqbn arduino:avr:uno sketch`), {
            browserWindow,
            showProgress: t.compileCode.notifications.progress,
            showSuccess: t.compileCode.notifications.success,
            showError: t.compileCode.notifications.error,
            onError: (error) => logger.error(`Error compiling code: ${error}`),
            cwd: directory
        });

        // Téléverser
        await execCommand(buildArduinoCliCommand(`upload -p ${port} --fqbn arduino:avr:uno sketch`), {
            browserWindow,
            showProgress: t.uploadCode.notifications.progress,
            showSuccess: t.uploadCode.notifications.success,
            showError: t.uploadCode.notifications.error,
            onError: (error) => logger.error(`Error uploading code: ${error}`),
            cwd: directory
        });
    } catch (error) {
        logger.error('Error in compileAndUploadArduino:', error);
        throw error;
    }
}

// ============================================================================
// HELPERS POUR LES REMPLACEMENTS DE CHAÎNES
// ============================================================================

/**
 * Normalise les guillemets Unicode vers des guillemets ASCII
 * @param {string} text - Le texte à normaliser
 * @returns {string} Le texte avec guillemets normalisés
 */
function normalizeQuotes(text) {
    return text
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"');
}

/**
 * Normalise les tirets Unicode vers des tirets ASCII
 * @param {string} text - Le texte à normaliser
 * @returns {string} Le texte avec tirets normalisés
 */
function normalizeDashes(text) {
    return text
        .replace(/[\u2013\u2014]/g, '-');
}

/**
 * Échappe les caractères HTML pour l'affichage sécurisé
 * @param {string} text - Le texte à échapper
 * @returns {string} Le texte échappé
 */
function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
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

/**
 * Vérifie si le code est du MakeCode Python (vs MicroPython standard)
 * @param {string} code - Le code à vérifier
 * @returns {boolean} true si c'est du MakeCode Python, false sinon
 */
function isMakeCodePython(code) {
    return MAKECODE_PATTERNS.some(pattern => code.includes(pattern));
}

/**
 * Normalise les caractères Unicode dans le texte
 * @param {string} text - Le texte à normaliser
 * @param {Object} options - Options de normalisation
 * @param {boolean} options.useNFKC - Utiliser la normalisation NFKC
 * @returns {string} Le texte normalisé
 */
function normalizeUnicode(text, options = {}) {
    let normalized = text;

    if (options.useNFKC !== false) {
        normalized = normalized.normalize('NFKC');
    }

    // Remplacer les guillemets typographiques
    normalized = normalized.replace(/[\u2018\u2019\u201C\u201D]/g, '"');

    // Remplacer les tirets typographiques
    normalized = normalized.replace(/[\u2013\u2014]/g, '-');

    // Supprimer les espaces de largeur zéro
    if (options.removeZeroWidth !== false) {
        normalized = normalized.replace(/[\u200B-\u200D\uFEFF]/g, '');
    }

    // Remplacer les espaces insécables
    normalized = normalized.replace(/[\u00A0]/g, ' ');

    return normalized;
}

// Extraire le code depuis l'éditeur Tinkercad
/**
 * Exécute un script JavaScript dans le webview Tinkercad (si disponible) ou dans la fenêtre principale
 * @param {BrowserWindow} browserWindow - La fenêtre contenant le webview
 * @param {string} script - Le script JavaScript à exécuter
 * @returns {Promise<string>} Le résultat de l'exécution du script
 */
async function executeScriptInWebview(browserWindow, script) {
    try {
        // Utiliser la méthode statique getAllWebContents() pour trouver tous les webContents
        const allWebContents = webContents.getAllWebContents();
        
        // Essayer d'abord dans le webview (si disponible)
        for (const wc of allWebContents) {
            try {
                const url = wc.getURL();
                if (url && url.includes('tinkercad.com')) {
                    // Attendre que le DOM soit prêt
                    await wc.executeJavaScript(`
                        new Promise((resolve) => {
                            if (document.readyState === 'complete') {
                                resolve();
                            } else {
                                window.addEventListener('load', () => resolve(), { once: true });
                                setTimeout(() => resolve(), 1000);
                            }
                        })
                    `);
                    
                    const result = await wc.executeJavaScript(script);
                    if (result && result !== CONSTANTS.EMPTY_CODE) {
                        return result;
                    }
                }
            } catch (e) {
                // Continuer avec le prochain webContents
            }
        }
        
        // Si pas trouvé dans le webview, essayer dans la fenêtre principale
        return await browserWindow.webContents.executeJavaScript(script);
    } catch (e) {
        logger.error('Error executing script:', e.message);
        return CONSTANTS.EMPTY_CODE;
    }
}

/**
 * Extrait le code depuis l'éditeur CodeMirror dans la fenêtre du navigateur
 * @param {BrowserWindow} browserWindow - La fenêtre contenant l'éditeur
 * @param {Object} options - Options d'extraction
 * @param {boolean} options.useAdvancedSelectors - Utiliser des sélecteurs avancés pour trouver l'éditeur
 * @param {boolean} options.normalizeUnicode - Normaliser les caractères Unicode
 * @returns {Promise<string>} Le code extrait ou CONSTANTS.EMPTY_CODE si aucun code trouvé
 */
async function extractCodeFromEditor(browserWindow, options = {}) {
    const {
        useAdvancedSelectors = true, // Activer par défaut pour une meilleure détection
        normalizeUnicode: shouldNormalize = true
    } = options;

    try {
        // Utiliser le script d'extraction amélioré
        const code = await executeScriptInWebview(browserWindow, CODE_EXTRACTION_SCRIPT);

        if (!code || code === CONSTANTS.EMPTY_CODE) {
            return CONSTANTS.EMPTY_CODE;
        }

        if (shouldNormalize) {
            return normalizeUnicode(code, { useNFKC: useAdvancedSelectors });
        }

        return code;
    } catch (error) {
        logger.error('Error extracting code from editor:', error);
        return CONSTANTS.EMPTY_CODE;
    }
}

// Nettoyer le code Python
/**
 * Nettoie et normalise le code Python
 * @param {string} code - Le code Python à nettoyer
 * @returns {string} Le code nettoyé
 */
function cleanPythonCode(code) {
    // Normaliser les fins de ligne
    let cleaned = code.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Normaliser l'indentation et supprimer les espaces en fin de ligne
    cleaned = cleaned.split('\n')
        .map(line => line.replace(/\t/g, '    ').replace(/[ \t]+$/g, ''))
        .join('\n');

    // Réduire les lignes vides multiples
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

    // S'assurer que le code se termine par un saut de ligne
    if (!cleaned.endsWith('\n')) {
        cleaned += '\n';
    }

    return cleaned;
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
    const directoryAppAsar = getAppAsarDirectory();

    const v1Hex = loadHexFile('v1', directoryAppAsar);
    const v2Hex = loadHexFile('v2', directoryAppAsar);

    if (!v1Hex || !v2Hex) {
        throw new Error(t.microbit.notifications.installErrorMissing || 'Fichiers HEX MicroPython introuvables. Utilisez "Micro:bit > Installer les runtimes" pour les télécharger.');
    }

    return { v1Hex, v2Hex };
}

// ============================================================================
// REGEX COMPILÉES POUR LES CONVERSIONS MAKECODE -> MICROPYTHON
// ============================================================================
const REGEX_MAKECODE = {
    showIcon: /basic\.show_icon\s*\(\s*IconNames\.(\w+)\s*\)/g,
    clearScreen: /basic\.clear_screen\s*\(\s*\)/g,
    forever: /basic\.forever\s*\(\s*(\w+)\s*\)/g,
    buttonPressed: /input\.on_button_pressed\s*\(\s*Button\.([AB])\s*,\s*(\w+)\s*\)/g,
    analogPitch: /pins\.analog_pitch\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)/,
    showString: /basic\.show_string\s*\(\s*([^)]+)\s*\)/g,
    showNumber: /basic\.show_number\s*\(\s*([^)]+)\s*\)/g,
    show: /basic\.show\s*\(/g,
    clear: /basic\.clear\s*\(/g,
    pause: /basic\.pause\s*\(/g,
    onGesture: /input\.on_gesture\s*\(\s*Gesture\.(\w+)\s*,\s*(\w+)\s*\)/g,
    buttonIsPressed: /input\.button_is_pressed\s*\(\s*Button\.([AB])\s*\)/g,
    acceleration: /input\.acceleration\s*\(\s*Dimension\.([XYZ])\s*\)/g,
    compassHeading: /input\.compass_heading\s*\(\s*\)/g,
    calibrateCompass: /input\.calibrate_compass\s*\(\s*\)/g,
    temperature: /input\.temperature\s*\(\s*\)/g,
    digitalWritePin: /pins\.digital_write_pin\s*\(\s*DigitalPin\.P(\d+)\s*,\s*([^)]+)\s*\)/g,
    digitalReadPin: /pins\.digital_read_pin\s*\(\s*DigitalPin\.P(\d+)\s*\)/g,
    analogWritePin: /pins\.analog_write_pin\s*\(\s*AnalogPin\.P(\d+)\s*,\s*([^)]+)\s*\)/g,
    analogReadPin: /pins\.analog_read_pin\s*\(\s*AnalogPin\.P(\d+)\s*\)/g,
    playTone: /music\.play_tone\s*\(\s*([^,]+)\s*,\s*([^)]+)\s*\)/g,
    stopAllSounds: /music\.stop_all_sounds\s*\(\s*\)/g,
    sendString: /radio\.send_string\s*\(\s*([^)]+)\s*\)/g,
    receiveString: /radio\.receive_string\s*\(\s*\)/g,
    setGroup: /radio\.set_group\s*\(\s*([^)]+)\s*\)/g,
    onLogoEvent: /input\.on_logo_event\s*\(\s*TouchButtonEvent\.(\w+)\s*,\s*(\w+)\s*\)/g,
    importMicrobit: /^(from microbit import \*)/m
};

// ============================================================================
// SOUS-FONCTIONS POUR LA CONVERSION MAKECODE -> MICROPYTHON
// ============================================================================

/**
 * Normalise l'indentation du code (remplace les tabs par 4 espaces)
 * @param {string} code - Le code à normaliser
 * @returns {string} Le code avec indentation normalisée
 */
function normalizeCodeIndentation(code) {
    const lines = code.split('\n');
    return lines.map(line => line.replace(/\t/g, '    ')).join('\n');
}

/**
 * Ajoute les imports MicroPython nécessaires (microbit, music, radio, struct)
 * @param {string} code - Le code auquel ajouter les imports
 * @returns {string} Le code avec les imports ajoutés
 */
function addMicrobitImports(code) {
    let converted = code;

    // Ajouter l'import principal si absent
    if (!converted.includes('from microbit import')) {
        converted = 'from microbit import *\n\n' + converted;
    }

    // Ajouter les imports supplémentaires si nécessaires
    const needsStruct = converted.includes('radio.send_value') || converted.includes('radio.receive_value');
    const needsMusic = converted.includes('music.') && !converted.includes('import music');
    const needsRadio = converted.includes('radio.') && !converted.includes('import radio');

    if (needsStruct && !converted.includes('import struct')) {
        converted = converted.replace(REGEX_MAKECODE.importMicrobit, '$1\nimport struct');
    }
    if (needsMusic && !converted.includes('import music')) {
        converted = converted.replace(REGEX_MAKECODE.importMicrobit, '$1\nimport music');
    }
    if (needsRadio && !converted.includes('import radio')) {
        converted = converted.replace(REGEX_MAKECODE.importMicrobit, '$1\nimport radio');
    }

    return converted;
}

/**
 * Convertit les fonctions MakeCode basic.* vers MicroPython display.*
 * @param {string} code - Le code à convertir
 * @param {Object} iconMap - Mappage des icônes MakeCode vers MicroPython
 * @returns {string} Le code converti
 */
function convertBasicFunctions(code, iconMap) {
    let converted = code;

    // Convertir basic.show_icon(IconNames.XXX) en display.show(Image.XXX)
    converted = converted.replace(REGEX_MAKECODE.showIcon, (match, iconName) => {
        const microPythonIcon = iconMap[iconName] || iconName.toUpperCase();
        return `display.show(Image.${microPythonIcon})`;
    });

    // Convertir basic.clear_screen() en display.clear()
    converted = converted.replace(REGEX_MAKECODE.clearScreen, 'display.clear()');

    // Convertir basic.show_string("text") en display.scroll("text")
    converted = converted.replace(REGEX_MAKECODE.showString, 'display.scroll($1)');

    // Convertir basic.show_number(num) en display.scroll(str(num))
    converted = converted.replace(REGEX_MAKECODE.showNumber, 'display.scroll(str($1))');

    // Convertir d'autres fonctions basic.*
    converted = converted.replace(REGEX_MAKECODE.show, 'display.show(');
    converted = converted.replace(REGEX_MAKECODE.clear, 'display.clear(');
    converted = converted.replace(REGEX_MAKECODE.pause, 'sleep(');

    return converted;
}

/**
 * Convertit les fonctions MakeCode input.* vers MicroPython équivalentes
 * @param {string} code - Le code à convertir
 * @returns {string} Le code converti
 */
function convertInputFunctions(code) {
    let converted = code;

    // Convertir input.button_is_pressed(Button.A) en button_a.is_pressed()
    converted = converted.replace(REGEX_MAKECODE.buttonIsPressed, (match, button) => {
        const buttonName = button.toLowerCase() === 'a' ? 'button_a' : 'button_b';
        return `${buttonName}.is_pressed()`;
    });

    // Convertir input.acceleration(Dimension.X) en accelerometer.get_x()
    converted = converted.replace(REGEX_MAKECODE.acceleration, (match, dim) => {
        return `accelerometer.get_${dim.toLowerCase()}()`;
    });

    // Convertir input.compass_heading() en compass.heading()
    converted = converted.replace(REGEX_MAKECODE.compassHeading, 'compass.heading()');

    // Convertir input.calibrate_compass() en compass.calibrate()
    converted = converted.replace(REGEX_MAKECODE.calibrateCompass, 'compass.calibrate()');

    // Convertir input.temperature() en temperature()
    converted = converted.replace(REGEX_MAKECODE.temperature, 'temperature()');

    return converted;
}

/**
 * Convertit les fonctions MakeCode pins.* vers MicroPython pinX.*
 * @param {string} code - Le code à convertir
 * @returns {string} Le code converti
 */
function convertPinFunctions(code) {
    let converted = code;

    // Convertir pins.digital_write_pin(DigitalPin.P0, 1) en pin0.write_digital(1)
    converted = converted.replace(REGEX_MAKECODE.digitalWritePin, (match, pin, value) => {
        return `pin${pin}.write_digital(${value})`;
    });

    // Convertir pins.digital_read_pin(DigitalPin.P0) en pin0.read_digital()
    converted = converted.replace(REGEX_MAKECODE.digitalReadPin, (match, pin) => {
        return `pin${pin}.read_digital()`;
    });

    // Convertir pins.analog_write_pin(AnalogPin.P0, 512) en pin0.write_analog(512)
    converted = converted.replace(REGEX_MAKECODE.analogWritePin, (match, pin, value) => {
        return `pin${pin}.write_analog(${value})`;
    });

    // Convertir pins.analog_read_pin(AnalogPin.P0) en pin0.read_analog()
    converted = converted.replace(REGEX_MAKECODE.analogReadPin, (match, pin) => {
        return `pin${pin}.read_analog()`;
    });

    return converted;
}

/**
 * Convertit les fonctions MakeCode music.* et radio.* vers MicroPython
 * @param {string} code - Le code à convertir
 * @returns {string} Le code converti
 */
function convertMusicAndRadioFunctions(code) {
    let converted = code;

    // Convertir music.play_tone(freq, duration) en music.pitch(freq, duration)
    converted = converted.replace(REGEX_MAKECODE.playTone, 'music.pitch($1, $2)');

    // Convertir music.stop_all_sounds() en music.stop()
    converted = converted.replace(REGEX_MAKECODE.stopAllSounds, 'music.stop()');

    // Convertir radio.send_string("text") en radio.send("text")
    converted = converted.replace(REGEX_MAKECODE.sendString, 'radio.send($1)');

    // Convertir radio.receive_string() en radio.receive()
    converted = converted.replace(REGEX_MAKECODE.receiveString, 'radio.receive()');

    // Convertir radio.set_group(1) en radio.config(group=1)
    converted = converted.replace(REGEX_MAKECODE.setGroup, 'radio.config(group=$1)');

    return converted;
}

// Convertir pins.analog_pitch (nécessite un traitement spécial pour préserver l'indentation)
function convertAnalogPitch(code) {
    if (!REGEX_MAKECODE.analogPitch.test(code)) {
        return code;
    }

    const codeLines = code.split('\n');
    const analogPitchLines = [];

    for (let i = 0; i < codeLines.length; i++) {
        const line = codeLines[i];
        const indentMatch = line.match(/^(\s*)/);
        const indent = indentMatch ? indentMatch[1] : '';

        const analogPitchMatch = line.match(REGEX_MAKECODE.analogPitch);
        if (analogPitchMatch) {
            const pin = analogPitchMatch[1];
            const freq = analogPitchMatch[2];
            const isPinNumber = /^\d+$/.test(pin);
            const pinExpr = isPinNumber ? `pin${pin}` : pin;
            const periodExpr = `int(1000000 / ${freq})`;
            analogPitchLines.push(`${indent}${pinExpr}.set_analog_period_microseconds(${periodExpr})`);
            analogPitchLines.push(`${indent}${pinExpr}.write_analog(${PWM_DUTY_CYCLE})`);
        } else {
            analogPitchLines.push(line);
        }
    }

    return analogPitchLines.join('\n');
}

// Collecter et convertir les gestionnaires d'événements
/**
 * Collecte les gestionnaires d'événements MakeCode (on_button_pressed, on_gesture, etc.)
 * et les convertit pour intégration dans une boucle while True
 * @param {string} code - Le code à analyser
 * @returns {{code: string, buttonHandlers: Array, foreverFuncName: string|null}} 
 *          Code nettoyé, gestionnaires collectés et nom de la fonction forever
 */
function collectEventHandlers(code) {
    const buttonHandlers = [];
    const gestureHandlers = [];
    const logoTouchHandlers = [];
    let foreverFuncName = null;

    // Collecter basic.forever
    const foreverMatch = code.match(REGEX_MAKECODE.forever);
    if (foreverMatch) {
        foreverFuncName = foreverMatch[1];
        code = code.replace(REGEX_MAKECODE.forever, '');
    }

    // Collecter input.on_button_pressed
    code = code.replace(REGEX_MAKECODE.buttonPressed, (match, button, funcName) => {
        const buttonName = button.toLowerCase() === 'a' ? 'button_a' : 'button_b';
        buttonHandlers.push({ button: buttonName, func: funcName });
        return '';
    });

    // Collecter input.on_gesture
    code = code.replace(REGEX_MAKECODE.onGesture, (match, gesture, funcName) => {
        gestureHandlers.push({ gesture: gesture.toLowerCase(), func: funcName });
        return '';
    });

    // Collecter input.on_logo_event
    code = code.replace(REGEX_MAKECODE.onLogoEvent, (match, event, funcName) => {
        logoTouchHandlers.push({ func: funcName });
        return '';
    });

    // Ajouter les gestionnaires de gestes et logo aux gestionnaires de boutons
    gestureHandlers.forEach(h => buttonHandlers.push({ button: 'accelerometer', gesture: h.gesture, func: h.func }));
    logoTouchHandlers.forEach(h => buttonHandlers.push({ button: 'pin_logo', func: h.func }));

    return { code, buttonHandlers, foreverFuncName };
}

// Intégrer les gestionnaires dans la boucle principale
/**
 * Intègre les gestionnaires d'événements dans une boucle while True principale
 * @param {string} code - Le code de base
 * @param {Array} buttonHandlers - Liste des gestionnaires de boutons collectés
 * @param {string|null} foreverFuncName - Nom de la fonction forever si présente
 * @returns {string} Le code avec les gestionnaires intégrés dans la boucle principale
 */
function integrateEventHandlers(code, buttonHandlers, foreverFuncName) {
    if (buttonHandlers.length === 0 && !foreverFuncName) {
        return code;
    }

    const lines = code.split('\n');
    const newLines = [];
    let foundMainLoop = false;
    let mainLoopIndex = -1;

    // Chercher la boucle while True
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('while True:') && !foundMainLoop) {
            foundMainLoop = true;
            mainLoopIndex = i;
            break;
        }
    }

    if (buttonHandlers.length > 0) {
        // Reconstruire le code avec les gestionnaires
        for (let i = 0; i < lines.length; i++) {
            newLines.push(lines[i]);

            if (i === mainLoopIndex && foundMainLoop) {
                const nextLine = lines[i + 1] || '';
                const indentMatch = nextLine.match(/^(\s*)/);
                const indent = indentMatch && indentMatch[1] ? indentMatch[1] : '    ';

                buttonHandlers.forEach(handler => {
                    if (handler.gesture) {
                        newLines.push(`${indent}if accelerometer.was_gesture("${handler.gesture}"):`);
                        newLines.push(`${indent}    ${handler.func}()`);
                    } else if (handler.button === 'pin_logo') {
                        newLines.push(`${indent}if pin_logo.is_touched():`);
                        newLines.push(`${indent}    ${handler.func}()`);
                    } else {
                        newLines.push(`${indent}if ${handler.button}.was_pressed():`);
                        newLines.push(`${indent}    ${handler.func}()`);
                    }
                });

                if (foreverFuncName && code.includes(`def ${foreverFuncName}`)) {
                    newLines.push(`${indent}${foreverFuncName}()`);
                }
            }
        }

        if (!foundMainLoop) {
            newLines.push('');
            newLines.push('while True:');
            buttonHandlers.forEach(handler => {
                if (handler.gesture) {
                    newLines.push(`    if accelerometer.was_gesture("${handler.gesture}"):`);
                    newLines.push(`        ${handler.func}()`);
                } else if (handler.button === 'pin_logo') {
                    newLines.push(`    if pin_logo.is_touched():`);
                    newLines.push(`        ${handler.func}()`);
                } else {
                    newLines.push(`    if ${handler.button}.was_pressed():`);
                    newLines.push(`        ${handler.func}()`);
                }
            });
            const foreverToCall = foreverFuncName || 'on_forever';
            if (code.includes(`def ${foreverToCall}`)) {
                newLines.push(`    ${foreverToCall}()`);
            }
            newLines.push('    sleep(10)');
        }

        code = newLines.join('\n');
    } else if (foreverFuncName && !code.includes('while True:')) {
        // Si pas de gestionnaires mais qu'il y a basic.forever, créer la boucle
        const foreverLines = code.split('\n');
        const foreverNewLines = [];
        let foundForeverDef = false;

        for (let i = 0; i < foreverLines.length; i++) {
            foreverNewLines.push(foreverLines[i]);
            if (foreverLines[i].includes(`def ${foreverFuncName}`) && !foundForeverDef) {
                foundForeverDef = true;
                let j = i + 1;
                while (j < foreverLines.length && (foreverLines[j].trim() === '' || foreverLines[j].match(/^\s+/))) {
                    j++;
                }
                foreverNewLines.push('');
                foreverNewLines.push('while True:');
                foreverNewLines.push(`    ${foreverFuncName}()`);
                foreverNewLines.push('    sleep(10)');
            }
        }

        code = foreverNewLines.join('\n');
    }

    return code;
}

// Mapping des icônes MakeCode vers MicroPython
const ICON_MAP = {
    'Heart': 'HEART',
    'SmallHeart': 'HEART_SMALL',
    'Yes': 'YES',
    'No': 'NO',
    'Happy': 'HAPPY',
    'Sad': 'SAD',
    'Confused': 'CONFUSED',
    'Angry': 'ANGRY',
    'Asleep': 'ASLEEP',
    'Surprised': 'SURPRISED',
    'Silly': 'SILLY',
    'Fabulous': 'FABULOUS',
    'Meh': 'MEH',
    'TShirt': 'TSHIRT',
    'Rollerskate': 'ROLLERSKATE',
    'Duck': 'DUCK',
    'House': 'HOUSE',
    'Tortoise': 'TORTOISE',
    'Butterfly': 'BUTTERFLY',
    'StickFigure': 'STICK_FIGURE',
    'Ghost': 'GHOST',
    'Sword': 'SWORD',
    'Giraffe': 'GIRAFFE',
    'Skull': 'SKULL',
    'Umbrella': 'UMBRELLA',
    'Snake': 'SNAKE',
    'Rabbit': 'RABBIT',
    'Cow': 'COW',
    'QuarterNote': 'QUARTER_NOTE',
    'EigthNote': 'EIGHTH_NOTE',
    'Pitchfork': 'PITCHFORK',
    'Tent': 'TENT',
    'Jagged': 'JAGGED',
    'Target': 'TARGET',
    'Triangle': 'TRIANGLE',
    'LeftTriangle': 'TRIANGLE_LEFT',
    'Chessboard': 'CHESSBOARD',
    'Diamond': 'DIAMOND',
    'SmallDiamond': 'DIAMOND_SMALL',
    'Square': 'SQUARE',
    'SmallSquare': 'SQUARE_SMALL',
    'Scissors': 'SCISSORS',
    'ArrowNorth': 'ARROW_N',
    'ArrowNorthEast': 'ARROW_NE',
    'ArrowEast': 'ARROW_E',
    'ArrowSouthEast': 'ARROW_SE',
    'ArrowSouth': 'ARROW_S',
    'ArrowSouthWest': 'ARROW_SW',
    'ArrowWest': 'ARROW_W',
    'ArrowNorthWest': 'ARROW_NW',
    'MusicNote': 'MUSIC_NOTE',
    'MusicNoteBeamed': 'MUSIC_NOTE_BEAMED',
    'MusicalScore': 'MUSICAL_SCORE',
    'Xmas': 'XMAS',
    'Pacman': 'PACMAN'
};

/**
 * Convertit le code MakeCode Python en MicroPython standard
 * 
 * MakeCode utilise: basic.show_icon(IconNames.Heart), basic.forever(on_forever)
 * MicroPython utilise: display.show(Image.HEART), while True: on_forever()
 * 
 * @param {string} code - Le code MakeCode Python à convertir
 * @returns {string} Le code MicroPython converti
 */
function convertMakeCodeToMicroPython(code) {
    // Normaliser les fins de ligne et l'indentation
    let converted = code.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    converted = normalizeCodeIndentation(converted);

    // Ajouter les imports
    converted = addMicrobitImports(converted);

    // Convertir les fonctions dans l'ordre
    converted = convertBasicFunctions(converted, ICON_MAP);
    converted = convertInputFunctions(converted);
    converted = convertPinFunctions(converted);
    converted = convertMusicAndRadioFunctions(converted);
    converted = convertAnalogPitch(converted);

    // Collecter et convertir les gestionnaires d'événements
    const { code: codeAfterHandlers, buttonHandlers, foreverFuncName } = collectEventHandlers(converted);
    converted = codeAfterHandlers;

    // Nettoyer les lignes vides multiples créées par la suppression des gestionnaires
    converted = converted.replace(/\n{3,}/g, '\n\n');

    // Intégrer les gestionnaires dans la boucle principale
    converted = integrateEventHandlers(converted, buttonHandlers, foreverFuncName);

    // S'assurer que le code se termine par un saut de ligne
    if (!converted.endsWith('\n')) {
        converted += '\n';
    }


    return converted;
}

/**
 * Valide la syntaxe Python et affiche les erreurs si nécessaire
 * @param {string} code - Le code Python à valider
 * @param {BrowserWindow|null} browserWindow - La fenêtre pour afficher les erreurs
 * @returns {Array} Tableau d'erreurs détectées
 */
function validatePythonSyntaxWithDisplay(code, browserWindow = null) {
    const errors = validatePythonSyntax(code);
    if (errors.length > 0 && browserWindow) {
        const t = translations.menu;
        const errorLines = errors.map(e =>
            (t.microbit.convertedCode.errorLine || 'Ligne {line}: {message}')
                .replace('{line}', e.line)
                .replace('{message}', e.message)
        ).join('\n');
        const errorMsg = (t.microbit.convertedCode.validationErrors || 'Erreurs détectées dans le code converti:\n\n{errors}')
            .replace('{errors}', errorLines);
        showNotification(browserWindow, errorMsg);
    }
    return errors;
}

/**
 * Valide la syntaxe Python de base (détection d'erreurs courantes)
 * @param {string} code - Le code Python à valider
 * @returns {Array<{line: number, message: string}>} Tableau d'erreurs détectées
 */
function validatePythonSyntax(code) {
    const errors = [];
    const lines = code.split('\n');

    // Vérifier les parenthèses, crochets et accolades équilibrés
    let parenCount = 0;
    let bracketCount = 0;
    let braceCount = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;

        // Compter les parenthèses, crochets et accolades
        for (const char of line) {
            if (char === '(') parenCount++;
            else if (char === ')') parenCount--;
            else if (char === '[') bracketCount++;
            else if (char === ']') bracketCount--;
            else if (char === '{') braceCount++;
            else if (char === '}') braceCount--;
        }

        // Vérifier les erreurs d'indentation (lignes qui commencent après un : sans indentation)
        if (i > 0) {
            const prevLine = lines[i - 1].trim();
            const currentLine = line.trim();

            // Si la ligne précédente se termine par : et la ligne actuelle n'est pas vide
            if (prevLine.endsWith(':') && currentLine && !currentLine.startsWith('#') && !currentLine.startsWith('def ') && !currentLine.startsWith('class ')) {
                // Vérifier que la ligne actuelle est indentée
                const indentMatch = line.match(/^(\s*)/);
                const indent = indentMatch ? indentMatch[1] : '';
                if (indent.length === 0 && currentLine.length > 0) {
                    errors.push({
                        line: lineNum,
                        message: t.microbit.validation.indentationError || 'Erreur d\'indentation: ligne attendue après ":"'
                    });
                }
            }
        }

        // Vérifier les guillemets non fermés
        const singleQuotes = (line.match(/'/g) || []).length;
        const doubleQuotes = (line.match(/"/g) || []).length;
        if (singleQuotes % 2 !== 0 && !line.includes("'")) {
            // Ignorer les cas où c'est dans une chaîne multi-lignes
        }
    }

    // Vérifier les parenthèses/crochets/accolades non fermés
    if (parenCount !== 0) {
        errors.push({
            line: lines.length,
            message: (t.microbit.validation.unbalancedParentheses || 'Parenthèses non équilibrées ({count})').replace('{count}', `${parenCount > 0 ? '+' : ''}${parenCount}`)
        });
    }
    if (bracketCount !== 0) {
        errors.push({
            line: lines.length,
            message: (t.microbit.validation.unbalancedBrackets || 'Crochets non équilibrés ({count})').replace('{count}', `${bracketCount > 0 ? '+' : ''}${bracketCount}`)
        });
    }
    if (braceCount !== 0) {
        errors.push({
            line: lines.length,
            message: (t.microbit.validation.unbalancedBraces || 'Accolades non équilibrées ({count})').replace('{count}', `${braceCount > 0 ? '+' : ''}${braceCount}`)
        });
    }

    // Vérifier les imports manquants pour les fonctions utilisées
    const hasMusic = code.includes('music.') && !code.includes('import music') && !code.includes('from microbit import');
    const hasRadio = code.includes('radio.') && !code.includes('import radio') && !code.includes('from microbit import');

    if (hasMusic) {
        errors.push({
            line: 1,
            message: t.microbit.validation.missingImportMusic || 'Import manquant: ajoutez "import music" ou "from microbit import *"'
        });
    }
    if (hasRadio) {
        errors.push({
            line: 1,
            message: t.microbit.validation.missingImportRadio || 'Import manquant: ajoutez "import radio" ou "from microbit import *"'
        });
    }

    return errors;
}

// Afficher le code MicroPython converti dans une fenêtre
/**
 * Affiche une fenêtre avec le code MicroPython converti
 * @param {string} code - Le code MicroPython à afficher
 */
function showConvertedCodeWindow(code) {
    const codeWindow = new BrowserWindow({
        width: 900,
        height: 700,
        title: t.microbit.convertedCode.title || 'Code MicroPython Converti',
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    // Masquer complètement la barre de menu
    codeWindow.setMenuBarVisibility(false);

    const title = t.microbit.convertedCode.title || 'Code MicroPython Converti';
    const description = t.microbit.convertedCode.description || 'Ce code a été automatiquement converti depuis MakeCode Python vers MicroPython standard';
    const copyButton = t.microbit.convertedCode.copyButton || 'Copier le code';
    const closeButton = t.microbit.convertedCode.closeButton || 'Fermer';
    const copySuccess = t.microbit.convertedCode.copySuccess || 'Code copié dans le presse-papiers !';

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
                logger.error('Erreur lors de la copie:', err);
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
        const errMsg = (err && err.message) ? err.message : (err && err.toString) ? err.toString() : 'Erreur inconnue';
        throw new Error('Erreur lors de la compilation: ' + errMsg);
    }
}

// Détecter les lecteurs micro:bit disponibles (comme listArduinoBoards)
/**
 * Liste les lecteurs micro:bit disponibles et met à jour le menu
 * @param {BrowserWindow|null} browserWindow - La fenêtre pour afficher les notifications
 */
function listMicrobitDrives(browserWindow) {
    const drives = [];

    if (process.platform === 'win32') {
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
    } else if (process.platform === 'linux') {
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
    } else if (process.platform === 'darwin') {
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

    // Mettre à jour la liste même si pas de changement détecté (pour forcer le refresh)
    previousMicrobitDrives = drives;

    // Toujours rafraîchir le menu pour s'assurer qu'il est à jour
    refreshMenu();
    updateBoardStatusIcons();

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

// Télécharger un fichier depuis une URL
/**
 * Télécharge un fichier depuis une URL vers un chemin local
 * @param {string} url - L'URL du fichier à télécharger
 * @param {string} destPath - Le chemin de destination local
 * @returns {Promise<void>}
 * @throws {Error} Si le téléchargement échoue
 */
async function downloadToFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const download = (currentUrl, redirectCount = 0) => {
            if (redirectCount > 5) {
                reject(new Error('Too many redirects'));
                return;
            }

            // Détecter le protocole (http ou https)
            const urlObj = new URL(currentUrl);
            const httpModule = urlObj.protocol === 'https:' ? require('https') : require('http');

        const file = fs.createWriteStream(destPath);
        file.on('error', err => {
                safeExecute(() => fs.unlinkSync(destPath));
            reject(err);
        });

            httpModule.get(currentUrl, res => {
                // Suivre les redirections (301, 302, 307, 308)
                if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
                    safeExecute(() => file.close());
                    safeExecute(() => fs.unlinkSync(destPath));
                    const location = res.headers.location;
                    if (location) {
                        // Gérer les redirections absolues et relatives
                        const redirectUrl = location.startsWith('http') ? location : new URL(location, currentUrl).toString();
                        download(redirectUrl, redirectCount + 1);
                    } else {
                        reject(new Error('HTTP ' + res.statusCode + ' - No location header'));
                    }
                    return;
                }

            if (res.statusCode !== 200) {
                    safeExecute(() => file.close());
                    safeExecute(() => fs.unlinkSync(destPath));
                reject(new Error('HTTP ' + res.statusCode));
                return;
            }

            res.pipe(file);
            file.on('finish', () => file.close(() => resolve()));
        }).on('error', err => {
                safeExecute(() => file.close());
                safeExecute(() => fs.unlinkSync(destPath));
            reject(err);
        });
        };

        download(url);
    });
}

/**
 * Rend un fichier exécutable (Linux/macOS uniquement)
 * @param {string} filePath - Le chemin du fichier à rendre exécutable
 */
function makeExecutable(filePath) {
    if (process.platform !== 'win32') {
        try {
            // Utiliser fs.chmodSync pour définir les permissions d'exécution (0o755)
            fs.chmodSync(filePath, 0o755);
        } catch (error) {
            logger.warn(`Failed to make ${filePath} executable:`, error.message);
            // Essayer avec exec comme fallback
            try {
                execSync(`chmod +x "${filePath}"`);
    } catch (e) {
                logger.error(`Both methods failed to make ${filePath} executable:`, e.message);
            }
        }
    }
}

/**
 * Crée le fichier de configuration Arduino CLI par défaut s'il n'existe pas
 * @param {string} configPath - Le chemin du fichier de configuration à créer
 */
function ensureArduinoCliConfig(configPath) {
    if (!fs.existsSync(configPath)) {
        try {
            // Créer le répertoire parent s'il n'existe pas (compatible multi-OS)
            const configDir = path.dirname(configPath);
            if (!fs.existsSync(configDir)) {
                fs.mkdirSync(configDir, { recursive: true });
            }
            
            const defaultConfig = `board_manager:
  additional_urls:
    - https://arduino.esp8266.com/stable/package_esp8266com_index.json
    - https://github.com/stm32duino/BoardManagerFiles/raw/main/package_stmicroelectronics_index.json
    - https://sandeepmistry.github.io/arduino-nRF5/package_nRF5_boards_index.json
daemon:
  port: "50051"
directories:
  data: ./data
  downloads: ./suppr
  user: ./sketchbook
logging:
  file: ""
  format: text
  level: info
`;
            // Écrire le fichier avec encodage UTF-8 (compatible multi-OS)
            fs.writeFileSync(configPath, defaultConfig, 'utf8');
            logger.info(`Created default Arduino CLI configuration file: ${configPath}`);
        } catch (error) {
            logger.error(`Failed to create Arduino CLI configuration file: ${error.message}`);
        }
    }
}

/**
 * Récupère la dernière version de l'application depuis GitHub (releases)
 * @returns {Promise<string|null>} Le numéro de version (ex: "1.2.5") ou null en cas d'erreur
 */
function getAppRepositorySlug() {
    try {
        const pkg = require('./package.json');
        const repo = pkg.repository;
        if (!repo) return null;
        if (typeof repo === 'string') {
            const m = repo.match(/github:([^/]+\/[^/]+?)(?:\s|$)/) || repo.match(/^([^/]+\/[^/]+)$/);
            return m ? m[1].replace(/\.git$/, '') : null;
        }
        if (repo.url) {
            const m = repo.url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
            return m ? m[1] : null;
        }
        return null;
    } catch (e) {
        return null;
    }
}

async function getLatestAppReleaseVersion() {
    const slug = getAppRepositorySlug();
    if (!slug) return null;
    return new Promise((resolve) => {
        const options = {
            hostname: 'api.github.com',
            path: `/repos/${slug}/releases/latest`,
            method: 'GET',
            headers: {
                'User-Agent': 'Tinkercad-QHL',
                'Accept': 'application/vnd.github.v3+json'
            }
        };
        https.get(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const release = JSON.parse(data);
                    const version = release.tag_name ? release.tag_name.replace(/^v/, '') : null;
                    resolve(version);
                } catch (error) {
                    logger.error('Failed to parse app release response:', error.message);
                    resolve(null);
                }
            });
        }).on('error', (error) => {
            logger.error('Failed to fetch latest app version:', error.message);
            resolve(null);
        });
    });
}

/**
 * Vérifie s'il existe une mise à jour et affiche une notification
 * @param {BrowserWindow|null} browserWindow
 */
async function checkForUpdates(browserWindow) {
    const t = translations.menu.help;
    if (!browserWindow) browserWindow = getMainWindow();
    if (browserWindow) showNotification(browserWindow, t.checkUpdateChecking);
    const currentVersion = require('./package.json').version;
    const latestVersion = await getLatestAppReleaseVersion();
    if (!browserWindow) return;
    if (!latestVersion) {
        showNotification(browserWindow, t.checkUpdateError);
        return;
    }
    const compare = compareVersions(currentVersion, latestVersion);
    if (compare >= 0) {
        showNotification(browserWindow, t.checkUpdateCurrent.replace('{version}', currentVersion));
    } else {
        showNotification(browserWindow, t.checkUpdateAvailable.replace('{version}', latestVersion));
    }
}

/**
 * Compare deux versions sémantiques (ex: "1.2.0" vs "1.2.5")
 * @returns {number} &lt; 0 si a &lt; b, 0 si égales, &gt; 0 si a &gt; b
 */
function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na !== nb) return na - nb;
    }
    return 0;
}

/**
 * Récupère la dernière version d'Arduino CLI depuis l'API GitHub
 * @returns {Promise<string|null>} Le numéro de version (ex: "1.4.1") ou null en cas d'erreur
 */
async function getLatestArduinoCliVersion() {
    return new Promise((resolve) => {
        const options = {
            hostname: 'api.github.com',
            path: '/repos/arduino/arduino-cli/releases/latest',
            method: 'GET',
            headers: {
                'User-Agent': 'Tinkercad-QHL',
                'Accept': 'application/vnd.github.v3+json'
            }
        };

        https.get(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                try {
                    const release = JSON.parse(data);
                    // Extraire le numéro de version du tag (ex: "v1.4.1" -> "1.4.1")
                    const version = release.tag_name ? release.tag_name.replace(/^v/, '') : null;
                    resolve(version);
                } catch (error) {
                    logger.error('Failed to parse GitHub API response:', error.message);
                    resolve(null);
                }
            });
        }).on('error', (error) => {
            logger.error('Failed to fetch latest Arduino CLI version:', error.message);
            resolve(null);
        });
    });
}

/**
 * Récupère l'URL de téléchargement du fichier HEX micro:bit v1 depuis l'API GitHub
 * @returns {Promise<string|null>} L'URL de téléchargement ou null en cas d'erreur
 */
async function getMicrobitV1HexUrl() {
    return new Promise((resolve) => {
        const options = {
            hostname: 'api.github.com',
            path: '/repos/bbcmicrobit/micropython/releases/latest',
            method: 'GET',
            headers: {
                'User-Agent': 'Tinkercad-QHL',
                'Accept': 'application/vnd.github.v3+json'
            }
        };

        https.get(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                try {
                    const release = JSON.parse(data);
                    // Chercher l'asset avec "firmware.hex" ou "MICROBIT_V1.hex"
                    const asset = release.assets?.find(a => 
                        a.name.includes('firmware.hex') || 
                        a.name.includes('MICROBIT_V1.hex') ||
                        a.name.endsWith('.hex')
                    );
                    resolve(asset ? asset.browser_download_url : null);
                } catch (error) {
                    logger.error('Failed to parse GitHub API response for micro:bit v1:', error.message);
                    resolve(null);
                }
            });
        }).on('error', (error) => {
            logger.error('Failed to fetch micro:bit v1 HEX URL:', error.message);
            resolve(null);
        });
    });
}

/**
 * Récupère l'URL de téléchargement du fichier HEX micro:bit v2 depuis l'API GitHub
 * @returns {Promise<string|null>} L'URL de téléchargement ou null en cas d'erreur
 */
async function getMicrobitV2HexUrl() {
    return new Promise((resolve) => {
        const options = {
            hostname: 'api.github.com',
            path: '/repos/microbit-foundation/micropython-microbit-v2/releases/latest',
            method: 'GET',
            headers: {
                'User-Agent': 'Tinkercad-QHL',
                'Accept': 'application/vnd.github.v3+json'
            }
        };

        https.get(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                try {
                    const release = JSON.parse(data);
                    // Chercher l'asset avec "MICROBIT.hex"
                    const asset = release.assets?.find(a => 
                        a.name.includes('MICROBIT.hex') ||
                        (a.name.endsWith('.hex') && !a.name.includes('V1'))
                    );
                    resolve(asset ? asset.browser_download_url : null);
                } catch (error) {
                    logger.error('Failed to parse GitHub API response for micro:bit v2:', error.message);
                    resolve(null);
                }
            });
        }).on('error', (error) => {
            logger.error('Failed to fetch micro:bit v2 HEX URL:', error.message);
            resolve(null);
        });
    });
}

/**
 * Construit l'URL de téléchargement d'Arduino CLI avec la version spécifiée
 * @param {string} version - Le numéro de version (ex: "1.4.1")
 * @returns {string|null} L'URL de téléchargement ou null si la plateforme n'est pas supportée
 */
function buildArduinoCliDownloadUrl(version) {
    const platform = process.platform;
    let filename;
    
    if (platform === 'win32') {
        filename = `arduino-cli_${version}_Windows_64bit.zip`;
    } else if (platform === 'darwin') {
        filename = `arduino-cli_${version}_macOS_64bit.tar.gz`;
    } else {
        // Linux
        filename = `arduino-cli_${version}_Linux_64bit.tar.gz`;
    }
    
    return `https://github.com/arduino/arduino-cli/releases/download/v${version}/${filename}`;
}

/**
 * Vérifie et télécharge Arduino CLI si nécessaire
 * @param {BrowserWindow|null} browserWindow - La fenêtre pour afficher les notifications
 * @param {boolean} autoDownload - Si true, télécharge automatiquement si absent (défaut: true)
 * @returns {Promise<boolean>} true si Arduino CLI est disponible, false sinon
 */
async function ensureArduinoCli(browserWindow, autoDownload = true) {
    logger.info('[DEBUG] ========================================');
    logger.info('[DEBUG] ensureArduinoCli called');
    logger.info(`[DEBUG] autoDownload: ${autoDownload}`);
    logger.info(`[DEBUG] browserWindow: ${browserWindow ? 'present' : 'null'}`);
    
    try {
        const arduinoCliPath = PATHS.arduinoCli;
        const arduinoDir = path.dirname(arduinoCliPath);
        const configPath = PATHS.arduinoConfig;
        
        logger.info(`[DEBUG] arduinoCliPath: ${arduinoCliPath}`);
        logger.info(`[DEBUG] arduinoDir: ${arduinoDir}`);
        logger.info(`[DEBUG] configPath: ${configPath}`);
        
        // Vérifier si Arduino CLI existe déjà
        logger.info('[DEBUG] Checking if Arduino CLI already exists...');
        if (fs.existsSync(arduinoCliPath)) {
            logger.info('[DEBUG] Arduino CLI already exists, skipping download');
            // Vérifier et créer le fichier de configuration s'il n'existe pas
            ensureArduinoCliConfig(configPath);
            
            // Vérifier les permissions sur Linux/macOS
            if (process.platform !== 'win32') {
                try {
                    const stats = fs.statSync(arduinoCliPath);
                    // Vérifier si le fichier est exécutable (mode & 0o111)
                    if ((stats.mode & 0o111) === 0) {
                        logger.info('Arduino CLI exists but is not executable, fixing permissions...');
                        makeExecutable(arduinoCliPath);
                    }
                } catch (error) {
                    logger.warn('Could not check Arduino CLI permissions:', error.message);
                }
            }
            return true;
        }
        
        // Si autoDownload est false, ne pas télécharger, juste retourner false
        if (!autoDownload) {
            return false;
        }
        
        // Créer le répertoire si nécessaire
        if (!fs.existsSync(arduinoDir)) {
            fs.mkdirSync(arduinoDir, { recursive: true });
        }
        
        // Récupérer la dernière version depuis l'API GitHub
        logger.info('[DEBUG] Fetching latest Arduino CLI version from GitHub...');
        if (browserWindow) {
            showNotification(browserWindow, 'Vérification de la dernière version d\'Arduino CLI...');
        }
        const latestVersion = await getLatestArduinoCliVersion();
        logger.info(`[DEBUG] Latest version: ${latestVersion}`);
        
        if (!latestVersion) {
            logger.error('Failed to get latest Arduino CLI version from GitHub');
            if (browserWindow) {
                showNotification(browserWindow, 'Erreur : impossible de récupérer la dernière version d\'Arduino CLI');
            }
            return false;
        }
        
        // Construire l'URL de téléchargement avec la version réelle
        const downloadUrl = buildArduinoCliDownloadUrl(latestVersion);
        const isArchive = true; // Toutes les plateformes utilisent des archives
        
        if (!downloadUrl) {
            logger.error('No download URL for Arduino CLI on this platform');
            if (browserWindow) {
                showNotification(browserWindow, 'Erreur : plateforme non supportée pour Arduino CLI');
            }
            return false;
        }
        
        logger.info(`Downloading Arduino CLI version ${latestVersion} from ${downloadUrl}`);
        
        try {
            if (browserWindow) {
                showNotification(browserWindow, 'Téléchargement d\'Arduino CLI en cours...');
            }
        
            if (isArchive) {
                // Pour les archives, on télécharge dans un fichier temporaire
                const isWindows = process.platform === 'win32';
                const archiveExt = isWindows ? '.zip' : '.tar.gz';
                const tempArchive = path.join(arduinoDir, `arduino-cli_temp${archiveExt}`);
                
                logger.info('[DEBUG] Starting archive extraction process');
                logger.info(`[DEBUG] Platform: ${process.platform}`);
                logger.info(`[DEBUG] Archive path: ${tempArchive}`);
                logger.info(`[DEBUG] Arduino directory: ${arduinoDir}`);
                logger.info(`[DEBUG] Arduino CLI expected path: ${arduinoCliPath}`);
                
                await downloadToFile(downloadUrl, tempArchive);
                
                logger.info('[DEBUG] Archive downloaded, checking if file exists...');
                if (!fs.existsSync(tempArchive)) {
                    logger.error(`[DEBUG] Archive file does not exist after download: ${tempArchive}`);
                    if (browserWindow) {
                        showNotification(browserWindow, 'Erreur : archive introuvable après téléchargement');
                    }
                    return false;
                }
                
                const archiveStats = fs.statSync(tempArchive);
                logger.info(`[DEBUG] Archive file exists, size: ${archiveStats.size} bytes`);
                
                // Extraire l'archive selon la plateforme
                try {
                    logger.info('[DEBUG] Starting extraction...');
                    await new Promise((resolve, reject) => {
                        if (isWindows) {
                            // Windows : utiliser PowerShell pour extraire le ZIP
                            const psScript = `Expand-Archive -Path "${tempArchive}" -DestinationPath "${arduinoDir}" -Force`;
                            const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${psScript}"`;
                            
                            logger.info(`[DEBUG] Windows detected, using PowerShell`);
                            logger.info(`[DEBUG] PowerShell script: ${psScript}`);
                            logger.info(`[DEBUG] Full command: ${command}`);
                            logger.info(`[DEBUG] About to execute: exec("${command}")`);
                            
                            const startTime = Date.now();
                            exec(command, (error, stdout, stderr) => {
                                const duration = Date.now() - startTime;
                                logger.info(`[DEBUG] PowerShell command completed in ${duration}ms`);
                                
                                if (stdout) {
                                    logger.info(`[DEBUG] PowerShell stdout: ${stdout}`);
                                }
                                if (stderr) {
                                    logger.warn(`[DEBUG] PowerShell stderr: ${stderr}`);
                                }
                                
                                if (error) {
                                    logger.error(`[DEBUG] PowerShell error occurred:`);
                                    logger.error(`[DEBUG] Error code: ${error.code}`);
                                    logger.error(`[DEBUG] Error signal: ${error.signal}`);
                                    logger.error(`[DEBUG] Error message: ${error.message}`);
                                    logger.error(`[DEBUG] Error stack: ${error.stack}`);
                                    
                                    // Afficher l'erreur dans une notification pour la version compilée
                                    if (browserWindow) {
                                        const errorMsg = error.message || error.code || 'Erreur inconnue';
                                        showNotification(browserWindow, `Erreur PowerShell: ${errorMsg}\n\nLogs détaillés dans:\n${logFile}`);
                                    }
                                    
                                    reject(error);
                                } else {
                                    logger.info('[DEBUG] PowerShell extraction successful');
                                    resolve();
                                }
                            });
                        } else {
                            // Linux/macOS : utiliser tar pour extraire le .tar.gz
                            const command = `tar -xzf "${tempArchive}" -C "${arduinoDir}"`;
                            
                            logger.info(`[DEBUG] Linux/macOS detected, using tar`);
                            logger.info(`[DEBUG] Tar command: ${command}`);
                            logger.info(`[DEBUG] About to execute: exec("${command}")`);
                            
                            const startTime = Date.now();
                            exec(command, (error, stdout, stderr) => {
                                const duration = Date.now() - startTime;
                                logger.info(`[DEBUG] Tar command completed in ${duration}ms`);
                                
                                if (stdout) {
                                    logger.info(`[DEBUG] Tar stdout: ${stdout}`);
                                }
                                if (stderr) {
                                    logger.warn(`[DEBUG] Tar stderr: ${stderr}`);
                                }
                                
                                if (error) {
                                    logger.error(`[DEBUG] Tar error occurred:`);
                                    logger.error(`[DEBUG] Error code: ${error.code}`);
                                    logger.error(`[DEBUG] Error signal: ${error.signal}`);
                                    logger.error(`[DEBUG] Error message: ${error.message}`);
                                    logger.error(`[DEBUG] Error stack: ${error.stack}`);
                                    reject(error);
                                } else {
                                    logger.info('[DEBUG] Tar extraction successful');
                                    resolve();
                                }
                            });
                        }
                    });
                    
                    logger.info('[DEBUG] Extraction promise resolved, checking results...');
                    
                    // Supprimer l'archive temporaire
                    logger.info('[DEBUG] Removing temporary archive...');
                    try {
                        fs.unlinkSync(tempArchive);
                        logger.info('[DEBUG] Temporary archive removed successfully');
                    } catch (unlinkError) {
                        logger.warn(`[DEBUG] Failed to remove temporary archive: ${unlinkError.message}`);
                    }
                    
                    // Le binaire devrait être dans arduinoDir maintenant
                    logger.info(`[DEBUG] Checking if Arduino CLI binary exists at: ${arduinoCliPath}`);
                    if (fs.existsSync(arduinoCliPath)) {
                        logger.info('[DEBUG] Arduino CLI binary found!');
                        makeExecutable(arduinoCliPath);
                        logger.info('[DEBUG] Made Arduino CLI executable');
                        
                        // Vérifier et créer le fichier de configuration
                        ensureArduinoCliConfig(configPath);
                        logger.info('[DEBUG] Arduino CLI config ensured');
                        
                        if (browserWindow) {
                            showNotification(browserWindow, 'Arduino CLI téléchargé et installé avec succès');
                        }
                        logger.info('[DEBUG] Installation completed successfully');
                        return true;
                    } else {
                        logger.error('[DEBUG] Arduino CLI binary NOT found after extraction');
                        logger.error(`[DEBUG] Expected path: ${arduinoCliPath}`);
                        logger.error(`[DEBUG] Arduino directory contents:`);
                        try {
                            const dirContents = fs.readdirSync(arduinoDir);
                            logger.error(`[DEBUG] Files in arduinoDir: ${JSON.stringify(dirContents)}`);
                        } catch (readError) {
                            logger.error(`[DEBUG] Failed to read arduinoDir: ${readError.message}`);
                        }
                        
                        if (browserWindow) {
                            showNotification(browserWindow, 'Erreur : binaire Arduino CLI introuvable après extraction');
                        }
                        return false;
                    }
                } catch (extractError) {
                    logger.error('[DEBUG] Exception caught during extraction:');
                    logger.error(`[DEBUG] Error type: ${extractError.constructor.name}`);
                    logger.error(`[DEBUG] Error message: ${extractError.message}`);
                    logger.error(`[DEBUG] Error code: ${extractError.code}`);
                    logger.error(`[DEBUG] Error stack: ${extractError.stack}`);
                    
                    safeExecute(() => fs.unlinkSync(tempArchive));
                    if (browserWindow) {
                        const errorMsg = extractError.message || 'Erreur inconnue';
                        showNotification(browserWindow, `Erreur extraction: ${errorMsg}\n\nLogs détaillés dans:\n${logFile}`);
                    }
                    return false;
                }
                } else {
                    // Téléchargement direct du binaire
                    logger.info('[DEBUG] Processing as direct binary download');
                    logger.info(`[DEBUG] Downloading directly to: ${arduinoCliPath}`);
                    await downloadToFile(downloadUrl, arduinoCliPath);
                    logger.info('[DEBUG] Binary download completed');
                    
                    if (fs.existsSync(arduinoCliPath)) {
                        logger.info('[DEBUG] Binary file exists after download');
                        makeExecutable(arduinoCliPath);
                        logger.info('[DEBUG] Made binary executable');
                        // Vérifier et créer le fichier de configuration
                        ensureArduinoCliConfig(configPath);
                        logger.info('[DEBUG] Config file ensured');
                        if (browserWindow) {
                            showNotification(browserWindow, 'Arduino CLI téléchargé et installé avec succès');
                        }
                        logger.info('[DEBUG] Direct binary installation completed successfully');
                        return true;
                    } else {
                        logger.error(`[DEBUG] Binary file does not exist after download: ${arduinoCliPath}`);
                        if (browserWindow) {
                            showNotification(browserWindow, 'Erreur : binaire Arduino CLI introuvable après téléchargement');
                        }
                        return false;
                    }
                }
        } catch (error) {
            logger.error('[DEBUG] Exception in download/installation block:');
            logger.error(`[DEBUG] Error type: ${error.constructor.name}`);
            logger.error(`[DEBUG] Error message: ${error.message}`);
            logger.error(`[DEBUG] Error code: ${error.code}`);
            logger.error(`[DEBUG] Error stack: ${error.stack}`);
            logger.error('Failed to download Arduino CLI:', error);
            if (browserWindow) {
                const errorMsg = error.message || 'Erreur inconnue';
                showNotification(browserWindow, `Erreur téléchargement: ${errorMsg}\n\nLogs détaillés dans:\n${logFile}`);
            }
            return false;
        }
    } catch (error) {
        // Gérer les erreurs de manière gracieuse (ex: permissions, chemins invalides)
        logger.error('[DEBUG] Exception in ensureArduinoCli outer catch:');
        logger.error(`[DEBUG] Error type: ${error.constructor.name}`);
        logger.error(`[DEBUG] Error message: ${error.message}`);
        logger.error(`[DEBUG] Error code: ${error.code}`);
        logger.error(`[DEBUG] Error stack: ${error.stack}`);
        logger.error('Error in ensureArduinoCli:', error);
        return false;
    }
}

/**
 * Vérifie les binaires requis (Arduino CLI et MicroPython) au démarrage
 * @param {BrowserWindow|null} browserWindow - La fenêtre pour afficher les popups
 */
async function checkRequiredBinaries(browserWindow) {
    const { dialog } = require('electron');
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
                showNotification(browserWindow, `Erreur : impossible de créer le répertoire de cache.\n${error.message}\n\nVérifiez les permissions d'écriture.`);
            }
                        return;
                    }

        const v1Path = PATHS.microbit.v1;
        const v2Path = PATHS.microbit.v2;
        const v1Cache = path.join(cacheDir, 'MICROBIT_V1.hex');
        const v2Cache = path.join(cacheDir, 'MICROBIT.hex');

        let v1Hex = null;
        let v2Hex = null;

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
                    await downloadToFile(url, v1Cache);
                    v1Hex = fs.readFileSync(v1Cache, 'utf8');
                    if (v1Hex.trim().startsWith(':')) {
                        logger.info(`Successfully downloaded MICROBIT_V1.hex from ${url}`);
                    } else {
                        logger.warn(`Downloaded file does not appear to be a valid HEX file`);
                        v1Hex = null;
                    }
                } else {
                    logger.warn('Could not get micro:bit v1 HEX URL from GitHub API');
                    // Ne pas afficher de notification ici, le message d'erreur final sera affiché
            }
        } catch (e) {
                logger.error(`Failed to download MICROBIT_V1.hex:`, e.message || e);
                // Ne pas afficher de notification ici, le message d'erreur final sera affiché
            }
        }

        if (!v2Hex) {
            try {
                // Récupérer l'URL depuis l'API GitHub
                const url = await getMicrobitV2HexUrl();
                if (url) {
                    logger.info(`Downloading MICROBIT.hex from ${url}`);
                    await downloadToFile(url, v2Cache);
                    v2Hex = fs.readFileSync(v2Cache, 'utf8');
                    if (v2Hex.trim().startsWith(':')) {
                        logger.info(`Successfully downloaded MICROBIT.hex from ${url}`);
        } else {
                        logger.warn(`Downloaded file does not appear to be a valid HEX file`);
                        v2Hex = null;
                    }
                } else {
                    logger.warn('Could not get micro:bit v2 HEX URL from GitHub API');
                    // Ne pas afficher de notification ici, le message d'erreur final sera affiché
                }
            } catch (e) {
                logger.error(`Failed to download MICROBIT.hex:`, e.message || e);
                // Ne pas afficher de notification ici, le message d'erreur final sera affiché
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
            showNotification(browserWindow, t.microbit.notifications.installError || 'Erreur: Impossible de télécharger les runtimes MicroPython.');
        }
    } catch (e) {
        logger.error('Error installing MicroPython runtimes:', e);
        showNotification(browserWindow, t.microbit.notifications.installError || 'Erreur lors de l\'installation des runtimes MicroPython.');
    }
}


async function listArduinoBoards(browserWindow) {
    // Vérifier si Arduino CLI est disponible (sans téléchargement automatique)
    const arduinoCliAvailable = await ensureArduinoCli(browserWindow, false);
    if (!arduinoCliAvailable) {
        // Si Arduino CLI n'est pas disponible, mettre à jour le menu avec une liste vide
        previousBoards = [];
        refreshMenu();
            return;
        }

    execCommand(buildArduinoCliCommand(`board list`), {
        browserWindow,
        // Ne pas afficher d'erreur automatiquement - on gère manuellement
        showError: null,
        onSuccess: (stdout) => {
        // Parse the output to extract Port and Board Name
        const lines = stdout.split('\n');
        const boards = lines
            .slice(1) // Skip header line
            .filter(line => line.trim()) // Remove empty lines
            .map(line => {
                const parts = line.split(/\s+/);
                const port = parts[0];
                let boardName = parts[5];
                if (parts[6] !== undefined) {
                    boardName += ' ' + parts[6];
                }
                return { port, boardName };
            });

        // Check if the board list has changed
            const hasChanges = !areListsEqual(boards, previousBoards);

        previousBoards = boards;
        refreshMenu();
        updateBoardStatusIcons();

        if (hasChanges) {
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
    if (process.platform === 'win32') {
        app.setAppUserModelId(app.name);
    }
    createWindow();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });

    // Initial language setup
    switchLanguage(app.getLocale());

    // Vérifier les binaires requis au démarrage
    const mainWindow = getMainWindow();
    checkRequiredBinaries(mainWindow);

    // Initialiser l'état des icônes au démarrage
    updateBoardStatusIcons();

    // Start background board detection service
    // Ne pas télécharger automatiquement au démarrage, juste vérifier si disponible
    listArduinoBoards(mainWindow).catch(error => {
    });
    boardDetectionInterval = setInterval(() => {
        listArduinoBoards(mainWindow).catch(error => {
            // Ignorer les erreurs silencieusement lors de la détection périodique
        });
    }, DETECTION_INTERVAL);

    // Start background micro:bit drive detection service
    listMicrobitDrives(mainWindow);
    microbitDetectionInterval = setInterval(() => {
        listMicrobitDrives(mainWindow);
    }, DETECTION_INTERVAL);

    // Keep Arduino menu and let board detection service update it
    const mainMenu = Menu.getApplicationMenu();
    if (mainMenu) {
        listArduinoBoards(mainWindow).catch(error => {
        });
        listMicrobitDrives(mainWindow);
    }
});

app.on('window-all-closed', function () {
    // Clear the board detection intervals
    if (boardDetectionInterval) {
        clearInterval(boardDetectionInterval);
    }
    if (microbitDetectionInterval) {
        clearInterval(microbitDetectionInterval);
    }

    if (process.platform !== 'darwin') {
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
    BrowserWindow.getAllWindows().forEach(win => {
        win.webContents.send('language-changed', locale);
    });
    refreshMenu();
}

/**
 * Affiche une notification dans la fenêtre du navigateur
 * @param {BrowserWindow|null} browserWindow - La fenêtre où afficher la notification
 * @param {string} message - Le message à afficher
 */
function showNotification(browserWindow, message) {
    if (!browserWindow || !message) {
        return;
    }
        const escapedMessage = message.replace(/[\\"']/g, '\\$&').replace(/\n/g, '\\n');
    const delay = CONSTANTS.NOTIFICATION_DELAY;
    const duration = CONSTANTS.NOTIFICATION_DURATION;
        browserWindow.webContents.executeJavaScript(`
            (() => {
                try {
                    // Supprimer les notifications précédentes pour éviter la superposition
                    const existingNotifications = document.querySelectorAll('[data-tinkercad-notification]');
                    existingNotifications.forEach(notif => {
                        notif.style.opacity = '0';
                        setTimeout(() => notif.remove(), ${delay});
                    });
                    
                    const notification = document.createElement('div');
                    notification.setAttribute('data-tinkercad-notification', 'true');
                    notification.style.position = 'fixed';
                    notification.style.left = '50%';
                    notification.style.top = '50%';
                    notification.style.transform = 'translate(-50%, -50%)';
                    notification.style.backgroundColor = '#333';
                    notification.style.color = 'white';
                    notification.style.padding = '10px 20px';
                    notification.style.borderRadius = '5px';
                    notification.style.zIndex = '9999';
                    notification.style.opacity = '0';
                    notification.style.transition = 'opacity 0.3s ease-in-out';
                    notification.style.textAlign = 'center';
                    notification.style.whiteSpace = 'pre-wrap';
                    notification.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
                    notification.style.fontSize = '14px';
                    notification.textContent = "${escapedMessage}";
                    notification.style.cursor = 'pointer';
                    notification.addEventListener('click', () => {
                        notification.style.opacity = '0';
                    setTimeout(() => notification.remove(), ${delay});
                    });
                    
                    document.body.appendChild(notification);
                    
                    // Trigger reflow
                    notification.offsetHeight;
                    
                    // Show notification
                    notification.style.opacity = '1';
                    
                // Remove after ${duration}ms
                    setTimeout(() => {
                        notification.style.opacity = '0';
                    setTimeout(() => notification.remove(), ${delay});
                }, ${duration});
                } catch (error) {
                    console.error('Error showing notification:', error);
                }
            })();
        `);
    }
/**
 * Crée le menu Fichier de l'application
 * @param {Object} t - Objet de traductions
 * @param {string} locale - Code de langue actuel
 * @returns {Object} Configuration du menu Fichier
 */
function createFileMenu(t, locale) {
    return {
            label: t.file.label,
            submenu: [
                {
                    label: t.copyCode.label,
                    accelerator: 'CommandOrControl+Alt+C',
                    click: (menuItem, browserWindow) => {
                        if (browserWindow) {
                        executeScriptInWebview(browserWindow, CODE_EXTRACTION_SCRIPT).then(text => {
                            if (text != CONSTANTS.EMPTY_CODE) {
                                    clipboard.writeText(text);
                                    showNotification(browserWindow, t.copyCode.notifications.success);
                                } else {
                                showNotification(browserWindow, t.copyCode.notifications.empty || 'Aucun code trouvé');
                                }
                            }).catch(error => {
                            logger.error('Error copying code:', error);
                                showNotification(browserWindow, t.copyCode.notifications.error);
                            });
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: t.file.language,
                    submenu: [
                        {
                            label: 'English',
                            type: 'radio',
                            checked: locale === 'en',
                            click: () => switchLanguage('en')
                        },
                        {
                            label: 'Français',
                            type: 'radio',
                            checked: locale === 'fr',
                            click: () => switchLanguage('fr')
                        }
                    ]
                },
                { type: 'separator' },
                { role: 'quit', label: t.file.quit }
            ]
    };
}

/**
 * Crée le menu Arduino de l'application
 * @param {Object} t - Objet de traductions
 * @returns {Object} Configuration du menu Arduino
 */
function createArduinoMenu(t) {
    return {
            label: 'Arduino',
            submenu: [
                {
                    label: t.listPorts.label,
                    id: 'ports-menu',
                    submenu: previousBoards.map(board => ({
                        label: `${board.port} - ${board.boardName}`,
                        type: 'radio',
                        checked: selectedPort === board.port,
                        click: () => {
                            selectedPort = board.port;
                        const mainWindow = getMainWindow();
                            if (mainWindow) {
                                showNotification(mainWindow, t.listPorts.notifications.portSelected.replace('{port}', board.port) + ', ' + board.boardName);
                            }
                            selectedBoard = board.boardName;
                        }
                    }))
                },
                {
                    label: t.uploadCode.label,
                    click: (menuItem, browserWindow) => {
                        if (!selectedPort) {
                            showNotification(browserWindow, t.uploadCode.notifications.noPort);
                            return;
                        }
                        // Vérifier que le port sélectionné existe toujours dans la liste des cartes détectées
                        const portExists = previousBoards.some(board => board.port === selectedPort);
                        if (!portExists) {
                            showNotification(browserWindow, t.uploadCode.notifications.falsePort);
                            return;
                        }
                    extractCodeFromEditor(browserWindow).then(code => {
                        if (code === CONSTANTS.EMPTY_CODE) {
                                showNotification(browserWindow, t.copyCode.notifications.empty);
                                return;
                            }
                        compileAndUploadArduino(code, selectedPort, browserWindow).catch(error => {
                            logger.error('Error in Arduino upload process:', error);
                            const errorMsg = error && error.message ? error.message : 'Erreur inconnue lors de la compilation/téléversement';
                            showNotification(browserWindow, t.uploadCode.notifications.error + '\n' + errorMsg);
                            });
                        }).catch(error => {
                        logger.error('Error extracting code:', error);
                            showNotification(browserWindow, t.copyCode.notifications.error);
                        });
                    }
                },
                { type: 'separator' },
                {
                    label: t.installLibrary.label,
                    click: () => {
                        const libraryDialog = new BrowserWindow({
                            width: 400,
                            height: 200,
                            frame: false,
                            resizable: false,
                            webPreferences: {
                                nodeIntegration: true,
                                contextIsolation: true,
                            preload: PATHS.preload
                            }
                        });
                        libraryDialog.loadFile('library-dialog.html');
                    }
                },
                { type: 'separator' },
                {
                    label: t.file.installArduino.label,
                click: async (menuItem, browserWindow) => {
                    try {
                        // Vérifier et télécharger Arduino CLI si nécessaire
                        const arduinoCliAvailable = await ensureArduinoCli(browserWindow);
                        if (!arduinoCliAvailable) {
                            if (browserWindow) {
                                showNotification(browserWindow, 'Erreur : Arduino CLI n\'a pas pu être installé. Vérifiez votre connexion internet et les permissions d\'écriture.');
                            }
                                return;
                            }
                        
                        // Installer le core Arduino AVR
                        await execCommand(buildArduinoCliCommand(`core install arduino:avr`), {
                            browserWindow,
                            showProgress: 'Installation du compilateur Arduino en cours...',
                            showError: null, // On gère l'erreur manuellement avec plus de détails
                            showSuccess: t.file.installArduino.notifications.success,
                            onError: (error) => {
                                logger.error(`Error installing Arduino compiler: ${error}`);
                                const errorMsg = error && error.message ? error.message : String(error);
                                if (browserWindow) {
                                    showNotification(browserWindow, t.file.installArduino.notifications.error + '\n' + errorMsg);
                                }
                            }
                        });
                    } catch (error) {
                        logger.error(`Error in installArduino menu: ${error}`);
                        if (browserWindow) {
                            const errorMsg = error && error.message ? error.message : 'Erreur inconnue';
                            showNotification(browserWindow, t.file.installArduino.notifications.error + '\n' + errorMsg);
                        }
                    }
                    }
                }
            ]
    };
}

/**
 * Crée le menu micro:bit de l'application
 * @param {Object} t - Objet de traductions
 * @returns {Object} Configuration du menu micro:bit
 */
function createMicrobitMenu(t) {
    return {
            label: t.microbit.label,
            submenu: [
                {
                label: t.microbit.listBoards || t.listPorts.label || 'Lister les cartes disponibles',
                id: 'microbit-drives-menu',
                submenu: previousMicrobitDrives.length > 0
                    ? previousMicrobitDrives.map(drive => ({
                        label: `${drive.drive} - ${drive.volName}`,
                        type: 'radio',
                        checked: selectedMicrobitDrive === drive.drive,
                        click: () => {
                            selectedMicrobitDrive = drive.drive;
                            const mainWindow = getMainWindow();
                            if (mainWindow) {
                                showNotification(mainWindow, (t.microbit.notifications.found || 'Carte micro:bit trouvée').replace('{drive}', drive.drive));
                            }
                        }
                    }))
                    : [{
                        label: t.microbit.notifications.notFound || 'Aucune carte détectée',
                        enabled: false
                    }]
            },
            {
                label: t.microbit.upload || 'Téléverser le programme',
                click: async (menuItem, browserWindow) => {
                        if (!selectedMicrobitDrive) {
                        showNotification(browserWindow, t.microbit.notifications.noDrive || 'Aucune carte micro:bit sélectionnée');
                            return;
                        }

                    // Récupérer le code depuis la div de l'éditeur
                    extractCodeFromEditor(browserWindow, { useAdvancedSelectors: true }).then(code => {
                        if (code === CONSTANTS.EMPTY_CODE) {
                                showNotification(browserWindow, t.copyCode.notifications.empty);
                                return;
                            }


                        // Normaliser et nettoyer le code
                        let cleanedCode = cleanPythonCode(code);

                        // Afficher le message de compilation
                        showNotification(browserWindow, t.compileCode.notifications.progress || 'Compilation en cours...');

                        // Convertir le code MakeCode en MicroPython si nécessaire AVANT compilation
                        let microPythonCode = cleanedCode;
                        if (isMakeCodePython(cleanedCode)) {
                            microPythonCode = convertMakeCodeToMicroPython(cleanedCode);
                        }

                        // Compiler et copier sur la carte
                        const firmwareName = CONSTANTS.PROGRAM_HEX_FILENAME;
                        const finalPath = path.join(selectedMicrobitDrive, firmwareName);

                        compilePythonToHex(microPythonCode).then(hexContent => {
                            logger.info('Writing HEX file to micro:bit, content length:', hexContent.length);

                            // Afficher le message de téléversement après la compilation réussie
                            showNotification(browserWindow, t.microbit.notifications.uploadProgress || 'Téléversement en cours...');

                            fs.writeFile(finalPath, hexContent, 'utf8', (err) => {
                                    if (err) {
                                    logger.error('Error writing HEX file to micro:bit:', err && err.stack ? err.stack : err);
                                    showNotification(browserWindow, t.microbit.notifications.uploadError || 'Erreur lors de l\'écriture du fichier HEX');
                                        return;
                                    }

                                logger.info('HEX file written successfully to', finalPath);

                                // Afficher une notification de succès
                                showNotification(browserWindow, t.microbit.notifications.uploadSuccess || 'Fichier HEX copié sur la carte micro:bit.');
                            });
                        }).catch(err => {
                            logger.error('Error compiling Python to HEX:', err && err.stack ? err.stack : err);
                            const errorMsg = (err && err.message) ? err.message : (err && err.toString) ? err.toString() : 'Erreur inconnue';
                            showNotification(browserWindow, (t.microbit.notifications.uploadError || 'Erreur de compilation') + '\n' + errorMsg);
                        });
                    }).catch(error => {
                        logger.error('Error extracting code from editor:', error);
                        showNotification(browserWindow, t.copyCode.notifications.error);
                    });
                }
            },
            { type: 'separator' },
            {
                label: t.microbit.showConverted || 'Afficher le code converti',
                click: async (menuItem, browserWindow) => {
                    try {
                        // Récupérer le code depuis la div de l'éditeur (même méthode que pour Arduino)
                        const code = await executeScriptInWebview(browserWindow, CODE_EXTRACTION_SCRIPT);

                        if (!code || code === CONSTANTS.EMPTY_CODE || !code.trim()) {
                            showNotification(browserWindow, t.microbit.convertedCode.noCodeFound || 'Aucun code trouvé dans l\'éditeur');
                            return;
                        }

                        // Nettoyer le code
                        let cleanedCode = code.trim();
                        cleanedCode = cleanedCode.split('\n')
                            .map(line => line.replace(/\t/g, '    ').replace(/[ \t]+$/g, ''))
                            .join('\n');
                        cleanedCode = cleanedCode.replace(/\n{3,}/g, '\n\n').trim();

                        // Convertir le code MakeCode en MicroPython si nécessaire
                        let microPythonCode = cleanedCode;
                        if (isMakeCodePython(cleanedCode)) {
                            microPythonCode = convertMakeCodeToMicroPython(cleanedCode);

                            // Valider la syntaxe et afficher les erreurs
                            validatePythonSyntaxWithDisplay(microPythonCode, browserWindow);
                        } else if (!microPythonCode.includes('from microbit import')) {
                            microPythonCode = 'from microbit import *\\n\\n' + microPythonCode;
                        }

                        // Afficher la fenêtre avec le code converti
                        showConvertedCodeWindow(microPythonCode);
                    } catch (error) {
                        logger.error('Error showing converted code:', error);
                        const errorMsg = (t.microbit.convertedCode.errorRetrieving || 'Erreur lors de la récupération du code: {error}')
                            .replace('{error}', error.message || error);
                        showNotification(browserWindow, errorMsg);
                    }
                }
            },
            { type: 'separator' },
            {
                label: t.microbit.install || 'Installer MicroPython hors-ligne',
                click: (menuItem, browserWindow) => {
                    installMicroPythonRuntimes(browserWindow);
                }
            }
        ]
    };
}

/**
 * Crée le menu Affichage de l'application
 * @param {Object} t - Objet de traductions
 * @returns {Object} Configuration du menu Affichage
 */
function createViewMenu(t) {
    return {
            label: t.view.label,
            submenu: [
                { role: 'reload', label: t.view.reload },
                { role: 'forceReload', label: t.view.forceReload },
                { type: 'separator' },
                { role: 'resetZoom', label: t.view.resetZoom },
                { role: 'zoomIn', label: t.view.zoomIn },
                { role: 'zoomOut', label: t.view.zoomOut },
                { type: 'separator' },
                { role: 'togglefullscreen', label: t.view.toggleFullscreen },
                { role: 'toggleDevTools', label: t.view.toggleDevTools }
            ]
    };
}

/**
 * Crée le menu Aide de l'application
 * @param {Object} t - Objet de traductions
 * @returns {Object} Configuration du menu Aide
 */
function createHelpMenu(t) {
    return {
            label: t.help.label,
            submenu: [
                {
                    label: t.help.about,
                    click: async () => {
                        const { dialog } = require('electron');
                        const packageInfo = require('./package.json');
                        await dialog.showMessageBox({
                            type: 'info',
                            title: t.help.about,
                        message: 'Tinkercad QHL',
                            detail: `Version: ${packageInfo.version}\nAuteur: ${packageInfo.author}\nDate: ${packageInfo.date}\nLicense: ${packageInfo.license}`
                        });
                    }
                },
                {
                    label: t.help.checkUpdate,
                    click: () => checkForUpdates(getMainWindow())
                },
                {
                    label: t.help.learnMore,
                    click: async () => {
                        const { shell } = require('electron');
                        await shell.openExternal('https://www.tinkercad.com/learn/circuits');
                    }
            },
            { type: 'separator' },
            {
                label: t.help.makeDonation,
                click: async () => {
                    const { shell } = require('electron');
                    await shell.openExternal('https://paypal.me/sebcanet');
                }
            },
            {
                label: t.help.requestInvoice,
                click: async () => {
                    const { shell } = require('electron');
                    const email = 'scanet@libreduc.cc';
                    const subject = encodeURIComponent('demande de facture');
                    const body = encodeURIComponent('Bonjour Sébastien,\n\nje suis enseignant de ... au collège/lycée ..., à ... .\n\nAfin de faire un \'don\' par voie officielle, merci de me faire parvenir un devis pour une facture d\'un montant de ...€ pour que je puisse le soumettre au CA/à mon agent comptable.\n\nMerci beaucoup de soutenir les logiciles libres !');
                    await shell.openExternal(`mailto:${email}?subject=${subject}&body=${body}`);
                }
            }
        ]
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
    const t = translations.menu;
    const locale = currentLocale;
    const template = [
        createFileMenu(t, locale),
        createArduinoMenu(t),
        createMicrobitMenu(t),
        createViewMenu(t),
        createHelpMenu(t)
    ];
    const newMenu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(newMenu);
}
