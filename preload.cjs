/**
 * @file preload.cjs
 * @description Electron preload script (CommonJS): Electron ne charge pas le preload comme module ES.
 * Expose window.api (contextBridge) pour IPC avec le processus principal.
 * @module preload
 * @author Sébastien Canet
 * @license CC0-1.0
 */

const { contextBridge, ipcRenderer } = require('electron');

/** API exposed to the renderer (window.api) for IPC with the main process */
contextBridge.exposeInMainWorld('api', {
    closeWindow: () => ipcRenderer.send('close-library-dialog'),
    installLibrary: (libraryName) => ipcRenderer.send('install-library', libraryName),
    onInstallLibraryDone: (callback) => {
        const handler = (event, result) => callback(result);
        ipcRenderer.on('install-library-done', handler);
        return () => ipcRenderer.removeListener('install-library-done', handler);
    },
    getTranslation: async (key) => {
        try {
            return await ipcRenderer.invoke('get-translation', key);
        } catch (error) {
            console.error('Translation error:', error);
            return key;
        }
    },
    onLanguageChange: (callback) => {
        ipcRenderer.on('language-changed', callback);
        return () => ipcRenderer.removeListener('language-changed', callback);
    },
    onBoardStatusUpdate: (callback) => {
        ipcRenderer.on('update-board-status', callback);
        return () => ipcRenderer.removeListener('update-board-status', callback);
    },
    getIconPaths: async () => {
        try {
            return await ipcRenderer.invoke('get-icon-paths');
        } catch (error) {
            console.error('Error getting icon paths:', error);
            return { arduino: null, microbit: null };
        }
    },
    uploadArduino: () => {
        ipcRenderer.send('upload-arduino');
    },
    uploadMicrobit: () => {
        ipcRenderer.send('upload-microbit');
    }
});
