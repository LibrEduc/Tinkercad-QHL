const { app, BrowserWindow, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

// Load translations
function loadTranslations(locale) {
    const translationPath = path.join(__dirname, 'locales', `${locale}.json`);
    try {
        return JSON.parse(fs.readFileSync(translationPath, 'utf8'));
    } catch (error) {
        console.error(`Failed to load translations for ${locale}:`, error);
        return null;
    }
}

// Get system locale and handle language code extraction
const rawLocale = app.getLocale();
const systemLocale = rawLocale ? rawLocale.split('-')[0] : 'en';
let translations = loadTranslations(systemLocale);

// Only fallback to English if the translation file doesn't exist or is invalid
if (!translations) {
    console.log(`No translations found for ${systemLocale}, falling back to English`);
    translations = loadTranslations('en');
}

// Create custom menu template
const t = translations.menu;
const template = [
    {
        label: t.file.label,
        submenu: [
            {
                label: t.file.language,
                submenu: [
                    {
                        label: 'English',
                        type: 'radio',
                        checked: systemLocale === 'en',
                        click: () => switchLanguage('en')
                    },
                    {
                        label: 'Français',
                        type: 'radio',
                        checked: systemLocale === 'fr',
                        click: () => switchLanguage('fr')
                    }
                ]
            },
            { type: 'separator' },
            { role: 'quit', label: t.file.quit }
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
        icon: path.join(__dirname, 'autodesk-tinkercad.png'),
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
}

let selectedPort = null;

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

    // Initial language setup
    switchLanguage(app.getLocale());
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

function switchLanguage(locale) {
    // Load new translations
    const newTranslations = loadTranslations(locale) || loadTranslations('en');
    const t = newTranslations.menu;

    // Update menu template with new translations
    const template = [
        {
            label: t.file.label,
            submenu: [
                {
                    label: t.file.language,
                    submenu: [
                        {
                            label: 'English',
                            type: 'radio',
                            checked: locale === 'en',
                            click: () => switchLanguage('en')
                        },
                        {
                            label: 'Français',
                            type: 'radio',
                            checked: locale === 'fr',
                            click: () => switchLanguage('fr')
                        }
                    ]
                },
                { type: 'separator' },
                { role: 'quit', label: t.file.quit }
            ]
        },
        {
            label: t.copyCode.label,
            click: (menuItem, browserWindow) => {
                if (browserWindow) {
                    browserWindow.webContents.executeJavaScript(`
                  (() => {
                    const editorElement = document.querySelector('.CodeMirror-code');
                    if (!editorElement) 
                        return 'empty';
                    
                    // Clone the element to avoid modifying the original DOM
                    const clonedElement = editorElement.cloneNode(true);
                    
                    // Remove all gutter wrapper elements from the clone
                    const gutterWrappers = clonedElement.querySelectorAll('.CodeMirror-gutter-wrapper');
                    gutterWrappers.forEach(wrapper => wrapper.remove());
                    
                    // Get all pre elements (each represents a line of code)
                    const preElements = clonedElement.querySelectorAll('pre');
                    
                    // Extract text from each pre element and join with newlines
                    const codeText = Array.from(preElements)
                      .map(pre => pre.textContent)
                      .join('\\r\\n');
                    
                    // Get the clean text content
                    if (codeText != '' && codeText != 'undefined') {
                        return codeText;
                    } else {
                        return 'empty';
                    }
                    return codeText;
                  })()
                `).then(text => {
                                if (text != 'empty') {
                                    clipboard.writeText(text);
                                    showNotification(browserWindow, t.copyCode.notifications.success);
                                } else {
                                    showNotification(browserWindow, t.copyCode.notifications.empty);
                                }
                            }).catch(error => {
                                console.error('Error copying code:', error);
                                showNotification(browserWindow, t.copyCode.notifications.error);
                            });
                        }
                    }
        },
        {
            label: t.listPorts.label,
            submenu: [],
            id: 'ports-menu'
        },
        {
            label: t.uploadCode.label,
            click: async (menuItem, browserWindow) => {
                if (selectedPort) {
                    const { exec } = require('child_process');
                    const arduinoCliPath = path.join(__dirname, './arduino/arduino-cli.exe');
                    // Execute the Arduino CLI command
                    exec(`"${arduinoCliPath}" upload -p ${selectedPort}`, (error, stdout, stderr) => {
                        if (error) {
                            console.error(`Error uploading code: ${error}`);
                            showNotification(browserWindow, t.uploadCode.notifications.error);
                            return;
                        }
                        console.log(`Code uploaded successfully: ${stdout}`);
                        showNotification(browserWindow, t.uploadCode.notifications.success);
                    });
                } else {
                    showNotification(browserWindow, t.uploadCode.notifications.noPort);
                }
            }
        },
        {
            label: t.view.label,
            submenu: [
                { role: 'reload', label: t.view.reload },
                { role: 'forceReload', label: t.view.forceReload },
                { type: 'separator' },
                { role: 'resetZoom', label: t.view.resetZoom },
                { role: 'zoomIn', label: t.view.zoomIn },
                { role: 'zoomOut', label: t.view.zoomOut },
                { type: 'separator' },
                { role: 'togglefullscreen', label: t.view.toggleFullscreen },
                { type: 'separator' },
                { role: 'toggleDevTools', label: t.view.toggleDevTools }
            ]
        },
        {
            label: t.help.label,
            submenu: [
                {
                    label: t.help.learnMore,
                    click: async () => {
                        const { shell } = require('electron');
                        await shell.openExternal('https://www.tinkercad.com/learn')
                    }
                }
            ]
        }
    ];

    // Build and set the new menu
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}


function showNotification(browserWindow, notificationText) {
    const notificationWindow = new BrowserWindow({
        width: 500,
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
    <meta http-equiv="content-type" content="text/html; charset=utf-8" />
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
            <div style="font-size: 12px;">${notificationText}</div>
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