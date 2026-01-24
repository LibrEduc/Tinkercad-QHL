const { app, BrowserWindow, Menu, clipboard, ipcMain } = require('electron');
const path = require('node:path');

//create a function which returns true or false to recognize a development environment
function isDev() {
  return !app.getAppPath().includes('app.asar');
}
const directory = isDev() ? __dirname : app.getAppPath();//This requires an environment variable, which we will get to in a moment.//require files joining that directory variable with the location within your package of files
const directoryAppAsar = isDev() ? directory : directory + '/../../';
const arduinoCliPath = path.join(directoryAppAsar, './arduino/arduino-cli.exe');

// IPC handlers for library dialog
ipcMain.on('close-library-dialog', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.close();
});

// Handle translation requests
ipcMain.handle('get-translation', (event, key) => {
    const keys = key.split('.');
    let value = translations;
    for (const k of keys) {
        if (!value || typeof value !== 'object') {
            console.warn(`Translation key not found: ${key}`);
            return key;
        }
        value = value[k];
    }
    return value || key;
});

ipcMain.on('install-library', (event, libraryName) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const mainWindow = BrowserWindow.getAllWindows().find(w => w !== win);

    if (!libraryName) {
        if (mainWindow) showNotification(mainWindow, t.installLibrary.notifications.empty);
        return;
    }

    if (mainWindow) showNotification(mainWindow, t.installLibrary.notifications.progress);

    const { exec } = require('child_process');    
    exec(`"${arduinoCliPath}" lib install ${libraryName}`, (error) => {
        if (error) {
            console.error(`Error installing library: ${error}`);
            if (mainWindow) showNotification(mainWindow, t.installLibrary.notifications.error);
        } else {
            if (mainWindow) showNotification(mainWindow, t.installLibrary.notifications.success);
        }
        if (win) win.close();
    });
});
const fs = require('fs');

// Load translations
function loadTranslations(locale) {
    const translationPath = path.join(directory, './locales', `${locale}.json`);
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
let selectedBoard = "";

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
        icon: path.join(directory, 'autodesk-tinkercad.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    // Close all windows when main window is closed
    mainWindow.on('closed', () => {
        BrowserWindow.getAllWindows().forEach(win => {
            if (win !== mainWindow) win.close();
        });
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
let boardDetectionInterval;

let previousBoards = [];

function listArduinoBoards(browserWindow) {
    const { exec } = require('child_process');
    exec(`"${arduinoCliPath}" board list`, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error listing boards: ${error}`);
            if (browserWindow) {
                showNotification(browserWindow, arduinoCliPath + ' - ' + t.listPorts.notifications.error);
            }
            return;
        }

        // Parse the output to extract Port and Board Name
        const lines = stdout.split('\n');
        const boards = lines
            .slice(1) // Skip header line
            .filter(line => line.trim()) // Remove empty lines
            .map(line => {
                const parts = line.split(/\s+/);
                const port = parts[0];
                let boardName = parts[5];
                if (parts[6] !== undefined) {
                    boardName += ' ' + parts[6];
                }
                return { port, boardName };
            });

        // Check if the board list has changed
        const hasChanges = boards.length !== previousBoards.length ||
            JSON.stringify(boards) !== JSON.stringify(previousBoards);

        // Update the ports menu with available boards
        const currentMenu = Menu.getApplicationMenu();
        const template = currentMenu.items.map(item => {
            if (item.id === 'ports-menu') {
                return {
                    ...item,
                    submenu: boards.map(board => ({
                        label: `${board.port} - ${board.boardName}`,
                        type: 'radio',
                        checked: selectedPort === board.port,
                        click: () => {
                            selectedPort = board.port;
                            if (browserWindow) {
                                showNotification(browserWindow, t.listPorts.notifications.portSelected.replace('{port}', board.port) + ', ' + board.boardName);
                            }
                            selectedBoard = board.boardName;
                        }
                    }))
                };
            }
            return item;
        })

        const newMenu = Menu.buildFromTemplate(template);
        Menu.setApplicationMenu(newMenu);

        if (hasChanges) {
            if (boards.length === 0 && browserWindow) {
                showNotification(browserWindow, t.listPorts.notifications.noPorts);
            }
            previousBoards = boards;
        }
    });
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

    // Initial language setup
    switchLanguage(app.getLocale());

    // Start background board detection service
    const mainWindow = BrowserWindow.getAllWindows()[0];
    listArduinoBoards(mainWindow);
    boardDetectionInterval = setInterval(() => {
        listArduinoBoards(mainWindow);
    }, 1000); // Check every 2 seconds

    // Keep Arduino menu and let board detection service update it
    const mainMenu = Menu.getApplicationMenu();
    if (mainMenu) {
        listArduinoBoards(mainWindow);
    }
});

app.on('window-all-closed', function () {
    // Clear the board detection interval
    if (boardDetectionInterval) {
        clearInterval(boardDetectionInterval);
    }

    if (process.platform !== 'darwin') {
        app.quit();
    }
});

function switchLanguage(locale) {
    // Load new translations
    const newTranslations = loadTranslations(locale) || loadTranslations('en');
    translations = newTranslations; // Update global translations
    const t = newTranslations.menu;

    // Notify all windows about the language change
    BrowserWindow.getAllWindows().forEach(win => {
        win.webContents.send('language-changed', locale);
    });

    // Update menu template with new translations
    const template = [
        {
            label: t.file.label,
            submenu: [
                {
                    label: t.copyCode.label,
                    accelerator: 'CommandOrControl+Alt+C',
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
                            
                            // Extract text from each pre element and normalize the content
                            const codeText = Array.from(preElements)
                              .map(pre => pre.textContent.normalize())
                              .join('\\r\\n')
                              .replace(/[\u2018\u2019\u201C\u201D]/g, '"') // Replace smart quotes
                              .replace(/[\u2013\u2014]/g, '-') // Replace em/en dashes
                              .replace(/[\u200B]/g, ''); // Replace zerowidth spaces
                            
                            return codeText && codeText !== 'undefined' ? codeText : 'empty';
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
                { type: 'separator' },
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
            label: t.listPorts.label,
            id: 'ports-menu',
            submenu: []
        },
        {
            label: 'Arduino',
            submenu: [
                {
                    label: t.uploadCode.label,
                    click: (menuItem, browserWindow) => {
                        if (!selectedPort) {
                            showNotification(browserWindow, t.uploadCode.notifications.noPort);
                            return;
                        }
                        if (selectedBoard != "Arduino Uno") {
                            showNotification(browserWindow, t.uploadCode.notifications.falsePort);
                            return;
                        }

                        // Get the code from the editor
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
                            
                            // Extract text from each pre element and normalize the content
                            const codeText = Array.from(preElements)
                              .map(pre => pre.textContent.normalize())
                              .join('\\r\\n')
                              .replace(/[\u2018\u2019\u201C\u201D]/g, '"') // Replace smart quotes
                              .replace(/[\u2013\u2014]/g, '-') // Replace em/en dashes
                              .replace(/[\u200B]/g, ''); // Replace zerowidth spaces
                            
                            return codeText && codeText !== 'undefined' ? codeText : 'empty';
                          })()
                            `).then(code => {
                            if (code === 'empty') {
                                showNotification(browserWindow, t.copyCode.notifications.empty);
                                return;
                            }

                            // Write the code to div.ino
                            const sketchPath = path.join(directory, '/sketch/sketch.ino');
                            fs.writeFile(sketchPath, code, (err) => {
                                if (err) {
                                    console.error('Error writing sketch file:', err);
                                    showNotification(browserWindow, t.uploadCode.notifications.file);
                                    return;
                                }

                                showNotification(browserWindow, t.compileCode.notifications.progress);
                                // Upload the code to the Arduino
                                const { exec } = require('child_process');
                                exec(`"${arduinoCliPath}" compile --fqbn arduino:avr:uno sketch`, (error, stdout, stderr) => {
                                    if (error) {
                                        console.error(`Error compiling code: ${error}`);
                                        showNotification(browserWindow, t.compileCode.notifications.error);
                                        return;
                                    }
                                    showNotification(browserWindow, t.uploadCode.notifications.progress);
                                    exec(`"${arduinoCliPath}" upload -p ${selectedPort} --fqbn arduino:avr:uno sketch`, (error, stdout, stderr) => {
                                        if (error) {
                                            console.error(`Error uploading code: ${error}`);
                                            showNotification(browserWindow, t.uploadCode.notifications.error);
                                            return;
                                        }
                                        showNotification(browserWindow, t.uploadCode.notifications.success);
                                    });
                                });
                            });
                        }).catch(error => {
                            console.error('Error copying code:', error);
                            showNotification(browserWindow, t.copyCode.notifications.error);
                        });
                    }
                },
                { type: 'separator' },
                {
                    label: t.installLibrary.label,
                    click: () => {
                        const libraryDialog = new BrowserWindow({
                            width: 400,
                            height: 200,
                            frame: false,
                            resizable: false,
                            webPreferences: {
                                nodeIntegration: true,
                                contextIsolation: true,
                                preload: path.join(directory, 'preload.js')
                            }
                        });
                        libraryDialog.loadFile('library-dialog.html');
                    }
                },
                { type: 'separator' },
                {
                    label: t.file.installArduino.label,
                    click: (menuItem, browserWindow) => {
                        const { exec } = require('child_process');
                        exec(`"${arduinoCliPath}" core install arduino:avr`, (error, stdout, stderr) => {
                            if (error) {
                                console.error(`Error installing Arduino compiler: ${error}`);
                                showNotification(browserWindow, t.file.installArduino.notifications.error);
                                return;
                            }
                            showNotification(browserWindow, t.file.installArduino.notifications.success);
                        });
                    }
                }
            ]
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
                    label: t.help.about,
                    click: async () => {
                        const { dialog } = require('electron');
                        const packageInfo = require('./package.json');
                        await dialog.showMessageBox({
                            type: 'info',
                            title: t.help.about,
                            message: 'Tinkercad Desktop',
                            detail: `Version: ${packageInfo.version}\nAuteur: ${packageInfo.author}\nDate: ${packageInfo.date}\nLicense: ${packageInfo.license}`
                        });
                    }
                },
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
                    notification.style.cursor = 'pointer';
                    notification.addEventListener('click', () => {
                        notification.style.opacity = '0';
                        setTimeout(() => notification.remove(), 300);
                    });
                    
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