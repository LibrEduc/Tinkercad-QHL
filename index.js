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
            id: 'ports-menu',
            click: async (menuItem, browserWindow) => {
                const { exec } = require('child_process');
                const arduinoCliPath = path.join(__dirname, './arduino/arduino-cli.exe');
                exec(`"${arduinoCliPath}" board list`, (error, stdout, stderr) => {
                    if (error) {
                        console.error(`Error listing boards: ${error}`);
                        showNotification(browserWindow, t.listPorts.notifications.error);
                        return;
                    }
                    
                    // Parse the output to extract Port and Board Name
                    const lines = stdout.split('\n');
                    const boardInfo = lines
                        .slice(1) // Skip header line
                        .filter(line => line.trim()) // Remove empty lines
                        .map(line => {
                            const parts = line.split(/\s+/);
                            let boardInfo = parts[0] + ' ' + parts[5];
                            if (parts[6] !== undefined) {
                                boardInfo += ' ' + parts[6];
                            }
                            return boardInfo; // Return the port information
                        })
                        .join('\n');

                    // Write the filtered information to com.txt and show notification
                    if (boardInfo) {
                        fs.writeFileSync('com.txt', boardInfo);
                        showNotification(browserWindow, boardInfo);
                    } else {
                        showNotification(browserWindow, t.listPorts.notifications.noPorts);
                    }
                });
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
                        await shell.openExternal('https://www.tinkercad.com/learn/circuits');
                    }
                }
            ]
        }
    ];

    // Build and set the new menu
    const newMenu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(newMenu);
}

function showNotification(browserWindow, message) {
    if (browserWindow) {
        const escapedMessage = message.replace(/[\\"']/g, '\\$&').replace(/\n/g, '\\n');
        browserWindow.webContents.executeJavaScript(`
            (() => {
                try {
                    const notification = document.createElement('div');
                    notification.style.position = 'fixed';
                    notification.style.left = '50%';
                    notification.style.top = '50%';
                    notification.style.transform = 'translate(-50%, -50%)';
                    notification.style.backgroundColor = '#333';
                    notification.style.color = 'white';
                    notification.style.padding = '10px 20px';
                    notification.style.borderRadius = '5px';
                    notification.style.zIndex = '9999';
                    notification.style.opacity = '0';
                    notification.style.transition = 'opacity 0.3s ease-in-out';
                    notification.style.textAlign = 'center';
                    notification.style.whiteSpace = 'pre-wrap';
                    notification.textContent = "${escapedMessage}";

                    document.body.appendChild(notification);

                    // Trigger reflow
                    notification.offsetHeight;

                    // Show notification
                    notification.style.opacity = '1';

                    // Remove after 3 seconds
                    setTimeout(() => {
                        notification.style.opacity = '0';
                        setTimeout(() => notification.remove(), 300);
                    }, 3000);
                } catch (error) {
                    console.error('Error showing notification:', error);
                }
            })();
        `);
    }
}