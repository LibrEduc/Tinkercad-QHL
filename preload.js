const { contextBridge, ipcRenderer } = require('electron');

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
        // Demander les chemins des icônes au processus principal via IPC
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