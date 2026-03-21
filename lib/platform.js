/**
 * @file platform.js
 * @description Platform detection (Windows, macOS, Linux). Used for paths
 * (arduino-cli.exe vs arduino-cli), system commands and archive names.
 * @module lib/platform
 * @author Sébastien Canet
 * @license CC0-1.0
 */

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

export {
    isWindows,
    isMac,
    isLinux
};
