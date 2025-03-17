const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    closeWindow: () => ipcRenderer.send('close-library-dialog'),
    installLibrary: (libraryName) => ipcRenderer.send('install-library', libraryName)
});