const { app, BrowserWindow, Menu, ipcMain, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

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
              (() => {
                const editorElement = document.querySelector('.CodeMirror-code');
                if (!editorElement) return '';
                
                // Clone the element to avoid modifying the original DOM
                const clonedElement = editorElement.cloneNode(true);
                
                // Remove all gutter wrapper elements from the clone
                const gutterWrappers = clonedElement.querySelectorAll('.CodeMirror-gutter-wrapper');
                gutterWrappers.forEach(wrapper => wrapper.remove());
                
                // Get the clean text content
                return clonedElement.textContent;
              })()
            `).then(text => {
              if (text) {
                clipboard.writeText(text);
                const notificationWindow = new BrowserWindow({
                  width: 300,
                  height: 80,
                  frame: false,
                  transparent: true,
                  alwaysOnTop: true,
                  skipTaskbar: true,
                  webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true
                  }
                });

                // Position the notification window in the center of the main window
                const mainBounds = browserWindow.getBounds();
                const notificationBounds = notificationWindow.getBounds();
                notificationWindow.setPosition(
                  mainBounds.x + Math.floor((mainBounds.width - notificationBounds.width) / 2),
                  mainBounds.y + Math.floor((mainBounds.height - notificationBounds.height) / 2)
                );

                const logoPath = path.join(__dirname, 'Arduino_IDE_logo.png');
                const logoBase64 = fs.readFileSync(logoPath).toString('base64');
                const logoDataUrl = `data:image/png;base64,${logoBase64}`;
                console.log('Logo loaded as data URL');
                notificationWindow.loadURL(`data:text/html,
                  <html>
                    <body style="
                      margin: 0;
                      padding: 15px;
                      background: rgba(0, 0, 0, 0.7);
                      color: white;
                      font-family: Arial, sans-serif;
                      border-radius: 5px;
                      user-select: none;
                      -webkit-app-region: drag;
                    ">
                      <div style="display: flex; align-items: center;">
                        <img src="${logoDataUrl}" style="width: 24px; height: 24px; margin-right: 10px;" onerror="console.error('Failed to load image');this.style.display='none';">
                        <div>
                          <div style="font-weight: bold;">Tinkercad Desktop</div>
                          <div style="font-size: 12px;">Code copied to clipboard</div>
                        </div>
                      </div>
                    </body>
                  </html>
                `);

                // Close the notification after 3 seconds
                setTimeout(() => {
                  notificationWindow.close();
                }, 3000);
              }
            });
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
  if (process.platform === 'win32') {
    app.setAppUserModelId(app.name);
  }
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
