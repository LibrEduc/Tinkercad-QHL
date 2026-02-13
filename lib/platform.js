/**
 * Helpers plateforme (Windows / Linux / macOS)
 */
const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

module.exports = {
    isWindows,
    isMac,
    isLinux
};
