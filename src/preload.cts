/**
 * @file preload.cts
 * @description Script **preload** Electron compilé en **CommonJS** (`preload.cjs`) : le chargement preload
 * ne suit pas le même résolution ESM que le reste du projet.
 * Expose `window.api` via `contextBridge` pour un accès sécurisé à `ipcRenderer` depuis la page Tinkercad.
 * @remarks Pour ajouter un canal : déclarer ici, enregistrer le handler dans `index.ts`, documenter le contrat (payload, événements).
 * @module preload
 * @author scanet\@libreduc.cc (Sébastien Canet)
 * @license GPL-3.0
 */

const { contextBridge, ipcRenderer } = require('electron');

/** API disponible dans le renderer (`window.api`) : pont typé vers le processus principal. */
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
