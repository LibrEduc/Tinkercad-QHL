/**
 * @file arduino.js
 * @description Arduino CLI logic: command building, execution (exec/execFile), archive download
 * and extraction, YAML config, AVR core installation, sketch compile and upload.
 * Used by index.js (Arduino menu, upload).
 * @module lib/arduino
 * @author Sébastien Canet
 * @license CC0-1.0
 */

import path from 'node:path';
import fs from 'fs';
import { exec, execSync, execFile } from 'child_process';
import { PATHS, directory, isDev, getPortableDataDir, ensurePortableDataDir } from './paths.js';
import { isWindows, isMac } from './platform.js';
import { logger, logFile } from './logger.js';
import { showNotification } from './notifications.js';
import { getLatestArduinoCliVersion } from './github.js';
import { downloadToFile } from './download.js';
import { safeUnlink } from './utils.js';

/**
 * Builds the full command line for arduino-cli (executable + --config-file if present).
 * @param {string} arduinoCommand - Subcommand and arguments (e.g. "compile --fqbn arduino:avr:uno sketch")
 * @returns {string} Full command with quoted paths
 */
function buildArduinoCliCommand(arduinoCommand) {
    const configFile = PATHS.arduinoConfig;
    if (fs.existsSync(configFile)) {
        return `"${PATHS.arduinoCli}" --config-file "${configFile}" ${arduinoCommand}`;
    }
    return `"${PATHS.arduinoCli}" ${arduinoCommand}`;
}

/**
 * Parses a command whose executable is in quotes; returns { executable, args } or null.
 * @param {string} command - String like "path/to/exe" arg1 arg2
 * @returns {{ executable: string, args: string[] }|null}
 */
function parseQuotedCommand(command) {
    if (!command.startsWith('"') || !command.includes('"', 1)) return null;
    const endQuote = command.indexOf('"', 1);
    const executable = command.substring(1, endQuote);
    const rest = command.substring(endQuote + 1).trim();
    const args = [];
    let currentArg = '';
    let inQuotes = false;
    for (let i = 0; i < rest.length; i++) {
        const char = rest[i];
        if (char === '"') inQuotes = !inQuotes;
        else if (char === ' ' && !inQuotes) {
            if (currentArg) { args.push(currentArg); currentArg = ''; }
        } else currentArg += char;
    }
    if (currentArg) args.push(currentArg);
    return { executable, args };
}

/**
 * Executes a command (string or executable + args). If the command starts with a quoted path,
 * uses execFile to avoid escaping issues; otherwise exec with cwd.
 * @param {string} command - Full command line
 * @param {Object} [options] - browserWindow, cwd, showProgress, showSuccess, showError, onError, onSuccess
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function execCommand(command, options = {}) {
    const {
        onSuccess = () => {},
        onError = (error) => logger.error(`Command failed: ${error}`),
        showProgress = null,
        showSuccess = null,
        showError = null,
        browserWindow = null,
        cwd = null
    } = options;

    if (showProgress && browserWindow) showNotification(browserWindow, showProgress);
    const execOptions = { cwd: cwd || directory };
    const parsed = parseQuotedCommand(command);

    if (parsed) {
        let { executable, args } = parsed;
        executable = path.normalize(executable);
        if (!path.isAbsolute(executable)) {
            executable = path.resolve(directory, executable);
        }
        if (!fs.existsSync(executable)) {
            const error = new Error(`Executable not found: ${executable}`);
            onError(error);
            if (showError && browserWindow) showNotification(browserWindow, showError);
            return Promise.reject(error);
        }
        const executableDir = path.dirname(executable);
        const execFileOptions = {
            ...execOptions,
            cwd: cwd || executableDir,
            env: { ...process.env, PATH: `${executableDir}${path.delimiter}${process.env.PATH}` }
        };
        return new Promise((resolve, reject) => {
            execFile(executable, args, execFileOptions, (error, stdout, stderr) => {
                if (error) {
                    onError(error);
                    if (showError && browserWindow) showNotification(browserWindow, showError);
                    reject(error);
                } else {
                    onSuccess(stdout, stderr);
                    if (showSuccess && browserWindow) showNotification(browserWindow, showSuccess);
                    resolve({ stdout, stderr });
                }
            });
        });
    }

    return new Promise((resolve, reject) => {
        exec(command, execOptions, (error, stdout, stderr) => {
            if (error) {
                onError(error);
                if (showError && browserWindow) showNotification(browserWindow, showError);
                reject(error);
            } else {
                onSuccess(stdout, stderr);
                if (showSuccess && browserWindow) showNotification(browserWindow, showSuccess);
                resolve({ stdout, stderr });
            }
        });
    });
}

/**
 * Makes a file executable (chmod +x) on Linux/macOS; no-op on Windows.
 * @param {string} filePath - Path to the executable
 */
function makeExecutable(filePath) {
    if (!isWindows) {
        try {
            fs.chmodSync(filePath, 0o755);
        } catch (error) {
            logger.warn(`Failed to make ${filePath} executable:`, error.message);
            try {
                execSync(`chmod +x "${filePath}"`);
            } catch (e) {
                logger.error(`Both methods failed to make ${filePath} executable:`, e.message);
            }
        }
    }
}

/**
 * Creates the default arduino-cli.yaml file if it does not exist (board_manager, directories, etc.).
 * @param {string} configPath - Path to arduino-cli.yaml
 */
function ensureArduinoCliConfig(configPath) {
    if (fs.existsSync(configPath)) return;
    try {
        const configDir = path.dirname(configPath);
        if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
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
        fs.writeFileSync(configPath, defaultConfig, 'utf8');
        logger.info(`Created default Arduino CLI configuration file: ${configPath}`);
    } catch (error) {
        logger.error(`Failed to create Arduino CLI configuration file: ${error.message}`);
    }
}

/**
 * Returns the Arduino CLI archive download URL for the current platform.
 * @param {string} version - Version (e.g. "0.35.0")
 * @returns {string} GitHub releases URL
 */
function buildArduinoCliDownloadUrl(version) {
    let filename;
    if (isWindows) filename = `arduino-cli_${version}_Windows_64bit.zip`;
    else if (isMac) filename = `arduino-cli_${version}_macOS_64bit.tar.gz`;
    else filename = `arduino-cli_${version}_Linux_64bit.tar.gz`;
    return `https://github.com/arduino/arduino-cli/releases/download/v${version}/${filename}`;
}

/**
 * Extracts the Arduino CLI archive (PowerShell Expand-Archive on Windows, tar on Unix).
 * @param {string} tempArchive - Archive path
 * @param {string} destDir - Destination directory
 * @param {Electron.BrowserWindow|null} browserWindow - For displaying errors
 * @param {Object} [t] - Translations (file.installArduino.notifications, errors)
 * @returns {Promise<void>}
 */
function extractArduinoArchive(tempArchive, destDir, browserWindow, t) {
    return new Promise((resolve, reject) => {
        if (isWindows) {
            const psScript = `Expand-Archive -Path "${tempArchive}" -DestinationPath "${destDir}" -Force`;
            const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${psScript}"`;
            logger.debug('Extracting Arduino CLI (PowerShell)', { tempArchive, destDir });
            exec(command, (error, stdout, stderr) => {
                if (stderr) logger.debug('PowerShell stderr:', stderr);
                if (error) {
                    if (browserWindow) {
                        const errorMsg = error.message || error.code || t.errors?.unknownError || 'Erreur inconnue';
                        showNotification(browserWindow, `${t.file.installArduino.notifications.errorPowerShell}: ${errorMsg}\n\n${logFile}`);
                    }
                    reject(error);
                } else resolve();
            });
        } else {
            const command = `tar -xzf "${tempArchive}" -C "${destDir}"`;
            logger.debug('Extracting Arduino CLI (tar)', { tempArchive, destDir });
            exec(command, (error, stdout, stderr) => {
                if (stderr) logger.debug('Tar stderr:', stderr);
                if (error) reject(error);
                else resolve();
            });
        }
    });
}

/**
 * Downloads the Arduino CLI archive, extracts it, makes the binary executable, creates config and installs AVR core.
 * @param {string} downloadUrl - Archive URL
 * @param {string} arduinoDir - Target directory (containing arduino-cli)
 * @param {string} arduinoCliPath - Final path of the executable
 * @param {string} configPath - Path to arduino-cli.yaml
 * @param {Electron.BrowserWindow|null} browserWindow - For notifications
 * @param {Object} [t] - Translations
 * @returns {Promise<boolean>} true on success
 */
async function downloadAndExtractArduinoCli(downloadUrl, arduinoDir, arduinoCliPath, configPath, browserWindow, t) {
    const archiveExt = isWindows ? '.zip' : '.tar.gz';
    const tempArchive = path.join(arduinoDir, `arduino-cli_temp${archiveExt}`);
    const downloadingLabel = t.file?.installArduino?.notifications?.downloading || 'Downloading...';
    await downloadToFile(downloadUrl, tempArchive, {
        onProgress: ({ percent, received, total }) => {
            if (!browserWindow) return;
            const msg = total != null
                ? `${downloadingLabel} ${Math.round(percent)}%`
                : `${downloadingLabel} (${(received / 1024 / 1024).toFixed(1)} Mo)`;
            showNotification(browserWindow, msg);
        }
    });
    if (!fs.existsSync(tempArchive)) {
        if (browserWindow) showNotification(browserWindow, t.file.installArduino.notifications.errorArchive);
        return false;
    }
    if (browserWindow) showNotification(browserWindow, t.file?.installArduino?.notifications?.extracting || 'Extraction...');
    try {
        await extractArduinoArchive(tempArchive, arduinoDir, browserWindow, t);
    } catch (extractError) {
        logger.debug('Extraction failed:', extractError?.message);
        safeUnlink(tempArchive);
        if (browserWindow) {
            const errorMsg = extractError.message || t.errors?.unknownError || 'Erreur inconnue';
            showNotification(browserWindow, `${t.file.installArduino.notifications.errorExtract}: ${errorMsg}\n\n${logFile}`);
        }
        return false;
    }
    safeUnlink(tempArchive);
    if (!fs.existsSync(arduinoCliPath)) {
        if (browserWindow) showNotification(browserWindow, t.file.installArduino.notifications.errorBinaryNotFound);
        return false;
    }
    makeExecutable(arduinoCliPath);
    ensureArduinoCliConfig(configPath);
    if (browserWindow) showNotification(browserWindow, t.file?.installArduino?.notifications?.installingCoreAvr || 'Installation arduino:avr...');
    try {
        await ensureArduinoAvrCore(browserWindow, t);
    } catch (e) {
        logger.warn('ensureArduinoAvrCore after install:', e.message);
    }
    if (browserWindow) showNotification(browserWindow, t.file.installArduino.notifications.success);
    return true;
}

/**
 * Ensures Arduino CLI is present; if missing and autoDownload, downloads and installs (including AVR core).
 * @param {Electron.BrowserWindow|null} browserWindow - For notifications
 * @param {boolean} [autoDownload=true] - If true, triggers download when binary is missing
 * @param {Object} [t] - Translations (file.installArduino, errors)
 * @returns {Promise<boolean>} true if arduino-cli is available
 */
async function ensureArduinoCli(browserWindow, autoDownload = true, t) {
    if (!t) t = {};
    logger.debug('ensureArduinoCli called', { autoDownload, hasWindow: !!browserWindow });
    try {
        const arduinoCliPath = PATHS.arduinoCli;
        const arduinoDir = path.dirname(arduinoCliPath);
        const configPath = PATHS.arduinoConfig;
        if (fs.existsSync(arduinoCliPath)) {
            ensureArduinoCliConfig(configPath);
            if (!isWindows) {
                try {
                    const stats = fs.statSync(arduinoCliPath);
                    if ((stats.mode & 0o111) === 0) makeExecutable(arduinoCliPath);
                } catch (error) {
                    logger.warn('Could not check Arduino CLI permissions:', error.message);
                }
            }
            return true;
        }
        if (!autoDownload) return false;
        if (!fs.existsSync(arduinoDir)) fs.mkdirSync(arduinoDir, { recursive: true });
        if (browserWindow) showNotification(browserWindow, t.file?.installArduino?.notifications?.checking);
        const latestVersion = await getLatestArduinoCliVersion();
        if (!latestVersion) {
            if (browserWindow) showNotification(browserWindow, t.file?.installArduino?.notifications?.errorVersion);
            return false;
        }
        const downloadUrl = buildArduinoCliDownloadUrl(latestVersion);
        if (!downloadUrl) {
            if (browserWindow) showNotification(browserWindow, t.file?.installArduino?.notifications?.errorPlatform);
            return false;
        }
        logger.info(`Downloading Arduino CLI version ${latestVersion} from ${downloadUrl}`);
        try {
            if (browserWindow) showNotification(browserWindow, t.file?.installArduino?.notifications?.downloading);
            const isArchive = true;
            if (isArchive) {
                return await downloadAndExtractArduinoCli(downloadUrl, arduinoDir, arduinoCliPath, configPath, browserWindow, t);
            }
            await downloadToFile(downloadUrl, arduinoCliPath);
            if (fs.existsSync(arduinoCliPath)) {
                makeExecutable(arduinoCliPath);
                ensureArduinoCliConfig(configPath);
                if (browserWindow) showNotification(browserWindow, t.file?.installArduino?.notifications?.success);
                return true;
            }
            if (browserWindow) showNotification(browserWindow, t.file?.installArduino?.notifications?.errorBinaryNotFound);
            return false;
        } catch (error) {
            logger.error('Failed to download Arduino CLI:', error);
            if (browserWindow) {
                const errorMsg = error.message || t.errors?.unknownError || 'Erreur inconnue';
                showNotification(browserWindow, `${t.file?.installArduino?.notifications?.errorDownload}: ${errorMsg}\n\n${logFile}`);
            }
            return false;
        }
    } catch (error) {
        logger.error('Error in ensureArduinoCli:', error);
        return false;
    }
}

/**
 * Installs arduino:avr core if needed (arduino-cli core install arduino:avr), cwd = config directory.
 * @param {Electron.BrowserWindow|null} browserWindow - For progress notification
 * @param {Object} [t] - Translations (file.installArduino.notifications.installingCoreAvr)
 */
async function ensureArduinoAvrCore(browserWindow, t) {
    const configDir = path.dirname(PATHS.arduinoConfig);
    const progressMsg = t?.file?.installArduino?.notifications?.installingCoreAvr || 'Installation arduino:avr...';
    try {
        await execCommand(buildArduinoCliCommand(`core install arduino:avr`), {
            browserWindow,
            showProgress: progressMsg,
            showError: null,
            cwd: configDir
        });
    } catch (e) {
        logger.warn('ensureArduinoAvrCore:', e.message);
    }
}

/**
 * Writes code to the sketch (data/arduino/sketch/sketch.ino), compiles then uploads to the given port.
 * Uses the arduino-cli config directory as cwd so the AVR core is found.
 * @param {string} code - Sketch source code
 * @param {string} port - Serial port (e.g. COM3, /dev/ttyACM0)
 * @param {Electron.BrowserWindow|null} browserWindow - For notifications
 * @param {Object} [t] - Translations (compileCode, uploadCode, errors)
 * @returns {Promise<void>}
 */
async function compileAndUploadArduino(code, port, browserWindow, t) {
    if (!t) t = {};
    const arduinoCliAvailable = await ensureArduinoCli(browserWindow, true, t);
    if (!arduinoCliAvailable) {
        throw new Error(t.errors?.arduinoCliUnavailable || 'Arduino CLI n\'est pas disponible');
    }
    await ensureArduinoAvrCore(browserWindow, t);

    // In prod, resolve sketch path at runtime (data/arduino/sketch/sketch.ino)
    const sketchPath = isDev() ? PATHS.sketch : path.join(getPortableDataDir(), 'arduino', 'sketch', 'sketch.ino');
    ensurePortableDataDir();
    const sketchDir = path.dirname(sketchPath);
    if (!fs.existsSync(sketchDir)) fs.mkdirSync(sketchDir, { recursive: true });
    fs.writeFileSync(sketchPath, code, 'utf8');
    if (!fs.existsSync(sketchPath)) {
        const err = new Error('Could not create sketch.ino file');
        logger.error(`compileAndUploadArduino: sketch not created: ${sketchPath}`);
        throw err;
    }
    logger.info(`Sketch written: ${sketchPath}, compile cwd: ${path.dirname(sketchDir)}`);

    // Always use the config directory (arduino/) as cwd so YAML relative paths
    // (data: ./data, user: ./sketchbook) resolve the same as during core install — otherwise "Platform arduino:avr not found".
    const configDir = path.dirname(PATHS.arduinoConfig);
    const sketchDirQuoted = `"${sketchDir.replace(/"/g, '""')}"`;
    await execCommand(buildArduinoCliCommand(`compile --fqbn arduino:avr:uno ${sketchDirQuoted}`), {
        browserWindow,
        showProgress: t.compileCode?.notifications?.progress,
        showSuccess: t.compileCode?.notifications?.success,
        showError: t.compileCode?.notifications?.error,
        onError: (error) => logger.error(`Error compiling code: ${error}`),
        cwd: configDir
    });
    await execCommand(buildArduinoCliCommand(`upload -p ${port} --fqbn arduino:avr:uno ${sketchDirQuoted}`), {
        browserWindow,
        showProgress: t.uploadCode?.notifications?.progress,
        showSuccess: t.uploadCode?.notifications?.success,
        showError: t.uploadCode?.notifications?.error,
        onError: (error) => logger.error(`Error uploading code: ${error}`),
        cwd: configDir
    });
}

export {
    buildArduinoCliCommand,
    parseQuotedCommand,
    execCommand,
    makeExecutable,
    ensureArduinoCliConfig,
    buildArduinoCliDownloadUrl,
    extractArduinoArchive,
    downloadAndExtractArduinoCli,
    ensureArduinoCli,
    compileAndUploadArduino
};
