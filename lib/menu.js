/**
 * Construction du menu application (Fichier, Arduino, micro:bit, Affichage, Aide)
 * Utilise un objet contexte fourni par index.js pour éviter les dépendances circulaires.
 */

/**
 * Construit le template du menu application.
 * @param {Object} ctx - Contexte: t, locale, getMainWindow, showNotification, path, directory, BrowserWindow, Menu, clipboard, logger, dialog, shell, state getters/setters, previousBoards, previousMicrobitDrives, runArduinoUploadFlow, runMicrobitUploadFlow, switchLanguage, buildArduinoCliCommand, execCommand, ensureArduinoCli, translations, executeScriptInWebview, CODE_EXTRACTION_SCRIPT, CONSTANTS, cleanPythonCode, isMakeCodePython, convertMakeCodeToMicroPython, validatePythonSyntaxWithDisplay, showConvertedCodeWindow, installMicroPythonRuntimes, checkForUpdates, packageInfo
 * @returns {Object[]} Template pour Menu.buildFromTemplate()
 */
function buildApplicationMenu(ctx) {
    const {
        t,
        locale,
        getMainWindow,
        showNotification,
        path: pathModule,
        directory,
        iconPath,
        BrowserWindow,
        Menu: MenuApi,
        clipboard,
        logger,
        dialog: dialogApi,
        shell: shellApi,
        previousBoards,
        previousMicrobitDrives,
        runArduinoUploadFlow,
        runMicrobitUploadFlow,
        switchLanguage,
        buildArduinoCliCommand,
        execCommand,
        ensureArduinoCli,
        translations,
        executeScriptInWebview,
        CODE_EXTRACTION_SCRIPT,
        CONSTANTS,
        cleanPythonCode,
        isMakeCodePython,
        convertMakeCodeToMicroPython,
        validatePythonSyntaxWithDisplay,
        showConvertedCodeWindow,
        installMicroPythonRuntimes,
        checkForUpdates,
        packageInfo
    } = ctx;

    const getPort = () => (typeof ctx.getSelectedPort === 'function' ? ctx.getSelectedPort() : ctx.selectedPort);
    const setPort = (v) => (typeof ctx.setSelectedPort === 'function' ? ctx.setSelectedPort(v) : (ctx.selectedPort = v));
    const getBoard = () => (typeof ctx.getSelectedBoard === 'function' ? ctx.getSelectedBoard() : ctx.selectedBoard);
    const setBoard = (v) => (typeof ctx.setSelectedBoard === 'function' ? ctx.setSelectedBoard(v) : (ctx.selectedBoard = v));
    const getMicrobitDrive = () => (typeof ctx.getSelectedMicrobitDrive === 'function' ? ctx.getSelectedMicrobitDrive() : ctx.selectedMicrobitDrive);
    const setMicrobitDrive = (v) => (typeof ctx.setSelectedMicrobitDrive === 'function' ? ctx.setSelectedMicrobitDrive(v) : (ctx.selectedMicrobitDrive = v));

    function createFileMenu() {
        return {
            label: t.file.label,
            submenu: [
                {
                    label: t.copyCode.label,
                    accelerator: 'CommandOrControl+Alt+C',
                    click: (menuItem, browserWindow) => {
                        if (browserWindow) {
                            executeScriptInWebview(browserWindow, CODE_EXTRACTION_SCRIPT).then(text => {
                                if (text !== CONSTANTS.EMPTY_CODE) {
                                    clipboard.writeText(text);
                                    showNotification(browserWindow, t.copyCode.notifications.success);
                                } else {
                                    showNotification(browserWindow, t.copyCode.notifications.empty || 'Aucun code trouvé');
                                }
                            }).catch(error => {
                                logger.error('Error copying code:', error);
                                showNotification(browserWindow, t.copyCode.notifications.error);
                            });
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: t.file.language,
                    submenu: [
                        { label: 'English', type: 'radio', checked: locale === 'en', click: () => switchLanguage('en') },
                        { label: 'Français', type: 'radio', checked: locale === 'fr', click: () => switchLanguage('fr') }
                    ]
                },
                { type: 'separator' },
                { role: 'quit', label: t.file.quit }
            ]
        };
    }

    function createArduinoMenu() {
        return {
            label: t.arduino || 'Arduino',
            submenu: [
                {
                    label: t.listPorts.label,
                    id: 'ports-menu',
                    submenu: previousBoards.map(board => ({
                        label: `${board.port} - ${board.boardName}`,
                        type: 'radio',
                        checked: getPort() === board.port,
                        click: () => {
                            setPort(board.port);
                            setBoard(board.boardName);
                            const mainWindow = getMainWindow();
                            if (mainWindow) {
                                showNotification(mainWindow, t.listPorts.notifications.portSelected.replace('{port}', board.port) + ', ' + board.boardName);
                            }
                        }
                    }))
                },
                {
                    label: t.uploadCode.label,
                    click: (menuItem, browserWindow) => runArduinoUploadFlow(browserWindow)
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
                                preload: pathModule.resolve(directory, 'preload.js')
                            }
                        });
                        libraryDialog.loadFile('library-dialog.html');
                    }
                },
                { type: 'separator' },
                {
                    label: t.file.installArduino.label,
                    click: async (menuItem, browserWindow) => {
                        try {
                            const arduinoCliAvailable = await ensureArduinoCli(browserWindow, true, translations.menu);
                            if (!arduinoCliAvailable) {
                                if (browserWindow) showNotification(browserWindow, t.file.installArduino.notifications.error);
                                return;
                            }
                            await execCommand(buildArduinoCliCommand('core install arduino:avr'), {
                                browserWindow,
                                showProgress: t.file.installArduino.notifications.installingCore,
                                showError: null,
                                showSuccess: t.file.installArduino.notifications.success,
                                onError: (error) => {
                                    logger.error(`Error installing Arduino compiler: ${error}`);
                                    const errorMsg = error && error.message ? error.message : String(error);
                                    if (browserWindow) showNotification(browserWindow, t.file.installArduino.notifications.error + '\n' + errorMsg);
                                }
                            });
                        } catch (error) {
                            logger.error(`Error in installArduino menu: ${error}`);
                            if (browserWindow) {
                                const errorMsg = error && error.message ? error.message : (translations.menu?.errors?.unknownError || 'Erreur inconnue');
                                showNotification(browserWindow, t.file.installArduino.notifications.error + '\n' + errorMsg);
                            }
                        }
                    }
                }
            ]
        };
    }

    function createMicrobitMenu() {
        return {
            label: t.microbit.label,
            submenu: [
                {
                    label: t.microbit.listBoards || t.listPorts.label || 'Lister les cartes disponibles',
                    id: 'microbit-drives-menu',
                    submenu: previousMicrobitDrives.length > 0
                        ? previousMicrobitDrives.map(drive => ({
                            label: `${drive.drive} - ${drive.volName}`,
                            type: 'radio',
                            checked: getMicrobitDrive() === drive.drive,
                            click: () => {
                                setMicrobitDrive(drive.drive);
                                const mainWindow = getMainWindow();
                                if (mainWindow) {
                                    showNotification(mainWindow, (t.microbit.notifications.found || 'Carte micro:bit trouvée').replace('{drive}', drive.drive));
                                }
                            }
                        }))
                        : [{ label: t.microbit.notifications.notFound || 'Aucune carte détectée', enabled: false }]
                },
                {
                    label: t.microbit.upload || 'Téléverser le programme',
                    click: (menuItem, browserWindow) => runMicrobitUploadFlow(browserWindow)
                },
                { type: 'separator' },
                {
                    label: t.microbit.showConverted || 'Afficher le code converti',
                    click: async (menuItem, browserWindow) => {
                        try {
                            const code = await executeScriptInWebview(browserWindow, CODE_EXTRACTION_SCRIPT);
                            if (!code || code === CONSTANTS.EMPTY_CODE || !code.trim()) {
                                showNotification(browserWindow, t?.microbit?.convertedCode?.noCodeFound || 'Aucun code trouvé dans l\'éditeur');
                                return;
                            }
                            const cleanedCode = cleanPythonCode(code);
                            let microPythonCode = cleanedCode;
                            if (isMakeCodePython(cleanedCode)) {
                                microPythonCode = convertMakeCodeToMicroPython(cleanedCode);
                                validatePythonSyntaxWithDisplay(microPythonCode, browserWindow, {
                                    ...(t?.microbit?.validation || translations?.menu?.microbit?.validation || {}),
                                    errorLine: t?.microbit?.convertedCode?.errorLine ?? translations?.menu?.microbit?.convertedCode?.errorLine,
                                    validationErrors: t?.microbit?.convertedCode?.validationErrors ?? translations?.menu?.microbit?.convertedCode?.validationErrors
                                }, showNotification);
                            } else if (!microPythonCode.includes('from microbit import')) {
                                microPythonCode = 'from microbit import *\n\n' + microPythonCode;
                            }
                            showConvertedCodeWindow(microPythonCode);
                        } catch (error) {
                            logger.error('Error showing converted code:', error);
                            const msgTemplate = t?.microbit?.convertedCode?.errorRetrieving || 'Erreur lors de la récupération du code: {error}';
                            const errorMsg = msgTemplate.replace('{error}', error.message || error);
                            showNotification(browserWindow, errorMsg);
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: t.microbit.install || 'Installer MicroPython hors-ligne',
                    click: (menuItem, browserWindow) => installMicroPythonRuntimes(browserWindow)
                }
            ]
        };
    }

    function createViewMenu() {
        return {
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
        };
    }

    function createHelpMenu() {
        return {
            label: t.help.label,
            submenu: [
                {
                    label: t.help.about,
                    click: async () => {
                        await dialogApi.showMessageBox({
                            type: 'info',
                            title: t.help.about,
                            message: 'Tinkercad QHL',
                            detail: `Version: ${packageInfo.version}\nAuteur: ${packageInfo.author}\nDate: ${packageInfo.date}\nLicense: ${packageInfo.license}`
                        });
                    }
                },
                {
                    label: t.help.checkUpdate,
                    click: () => checkForUpdates(getMainWindow(), getMainWindow, translations.menu.help, packageInfo.version)
                },
                {
                    label: t.help.learnMore,
                    click: async () => { await shellApi.openExternal('https://www.tinkercad.com/learn/circuits'); }
                },
                { type: 'separator' },
                {
                    label: t.help.whoAreYou,
                    click: () => {
                        const windowTitle = t.help.whoAreYou || 'Qui êtes vous ?';
                        const formWindow = new BrowserWindow({
                            width: 540,
                            height: 815,
                            title: windowTitle,
                            autoHideMenuBar: true,
                            icon: iconPath,
                            webPreferences: {
                                nodeIntegration: false,
                                contextIsolation: true,
                                sandbox: true
                            }
                        });
                        formWindow.setMenuBarVisibility(false);
                        formWindow.webContents.on('page-title-updated', () => {
                            formWindow.setTitle(windowTitle);
                        });
                        formWindow.webContents.on('did-finish-load', () => {
                            formWindow.setTitle(windowTitle);
                        });
                        formWindow.loadURL('https://gitforms.vercel.app/');
                    }
                },
                { type: 'separator' },
                {
                    label: t.help.makeDonation,
                    click: async () => { await shellApi.openExternal('https://paypal.me/sebcanet'); }
                },
                {
                    label: t.help.requestInvoice,
                    click: async () => {
                        const email = 'scanet@libreduc.cc';
                        const subject = encodeURIComponent('demande de facture');
                        const body = encodeURIComponent('Bonjour Sébastien,\n\nje suis enseignant de ... au collège/lycée ..., à ... .\n\nAfin de faire un \'don\' par voie officielle, merci de me faire parvenir un devis pour une facture d\'un montant de ...€ pour que je puisse le soumettre au CA/à mon agent comptable.\n\nMerci beaucoup de soutenir les logiciles libres !');
                        await shellApi.openExternal(`mailto:${email}?subject=${subject}&body=${body}`);
                    }
                }
            ]
        };
    }

    return [
        createFileMenu(),
        createArduinoMenu(),
        createMicrobitMenu(),
        createViewMenu(),
        createHelpMenu()
    ];
}

module.exports = {
    buildApplicationMenu
};
