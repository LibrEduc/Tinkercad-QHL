const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    closeWindow: () => ipcRenderer.send('close-library-dialog'),
    installLibrary: (libraryName) => ipcRenderer.send('install-library', libraryName),
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
    }
});