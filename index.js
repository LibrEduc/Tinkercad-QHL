const { app, BrowserWindow, Menu, ipcMain, clipboard } = require('electron');
const path = require('path');

// Create custom menu template
const template = [
  {
    label: 'File',
    submenu: [
      {
        label: 'Copy code',
        click: (menuItem, browserWindow) => {
          if (browserWindow) {
            browserWindow.webContents.executeJavaScript(`
              let codeElement = document.querySelector('.CodeMirror-code');
              let text = '';
              if (codeElement) {
                text = codeElement.textContent;
              }
                console.log(text);
            `)/*.then(text => {
              if (text) {
                clipboard.writeText(text);
              }
            });*/
          }
        }
      },
      { type: 'separator' },
      { role: 'quit' }
    ]
  },
  {
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { type: 'separator' },
      { role: 'toggleDevTools' }
    ]
  },
  {
    role: 'help',
    submenu: [
      {
        label: 'Learn More',
        click: async () => {
          const { shell } = require('electron');
          await shell.openExternal('https://www.tinkercad.com/learn')
        }
      }
    ]
  }
];

// Build menu from template
const menu = Menu.buildFromTemplate(template);

// Set the custom menu
Menu.setApplicationMenu(menu);

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  // Load Tinkercad website directly
  mainWindow.loadURL('https://www.tinkercad.com/dashboard/designs/circuits');

  // Handle new window creation
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  // Open DevTools in development
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
