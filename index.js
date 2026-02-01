const { app, BrowserWindow, Menu, clipboard, ipcMain } = require('electron');
const path = require('node:path');
const https = require('https');
const fs = require('fs');
const { MicropythonFsHex, microbitBoardId } = require('@microbit/microbit-fs');

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
let currentLocale = systemLocale;
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
        title: 'Tinkercad QHL',
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
    
    // S'assurer que le titre reste "Tinkercad QHL" même après le chargement de la page
    mainWindow.on('page-title-updated', (event) => {
        event.preventDefault();
        mainWindow.setTitle('Tinkercad QHL');
    });

    // Handle new window creation
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        require('electron').shell.openExternal(url);
        return { action: 'deny' };
    });
}

let selectedPort = null;
let boardDetectionInterval;
let selectedMicrobitDrive = null;
let microbitDetectionInterval;

let previousBoards = [];
let previousMicrobitDrives = [];

// Méthode PythonEditor : utiliser microbit-fs pour créer le HEX
// PythonEditor charge les runtimes MicroPython et écrit le code dans main.py
async function ensureMicroPythonHexes() {
    const directoryAppAsar = isDev() ? __dirname : path.join(__dirname, '../../');
    const v1Path = path.join(directoryAppAsar, './microbit/MICROBIT_V1.hex');
    const v2Path = path.join(directoryAppAsar, './microbit/MICROBIT.hex');
    const cacheDir = path.join(directoryAppAsar, 'microbit-cache');
    const v1Cache = path.join(cacheDir, 'MICROBIT_V1.hex');
    const v2Cache = path.join(cacheDir, 'MICROBIT.hex');
    
    let v1Hex = null;
    let v2Hex = null;
    
    // Vérifier d'abord dans les ressources packagées
    if (fs.existsSync(v1Path)) {
        v1Hex = fs.readFileSync(v1Path, 'utf8');
        if (v1Hex.trim().startsWith(':')) {
            // Copier dans le cache pour usage futur
            if (!fs.existsSync(cacheDir)) {
                fs.mkdirSync(cacheDir, { recursive: true });
            }
            try { fs.writeFileSync(v1Cache, v1Hex, 'utf8'); } catch (e) {}
        } else {
            v1Hex = null;
        }
    }
    if (fs.existsSync(v2Path)) {
        v2Hex = fs.readFileSync(v2Path, 'utf8');
        if (v2Hex.trim().startsWith(':')) {
            // Copier dans le cache pour usage futur
            if (!fs.existsSync(cacheDir)) {
                fs.mkdirSync(cacheDir, { recursive: true });
            }
            try { fs.writeFileSync(v2Cache, v2Hex, 'utf8'); } catch (e) {}
        } else {
            v2Hex = null;
        }
    }
    
    // Vérifier dans le cache
    if (!v1Hex && fs.existsSync(v1Cache)) {
        v1Hex = fs.readFileSync(v1Cache, 'utf8');
        if (!v1Hex.trim().startsWith(':')) v1Hex = null;
    }
    if (!v2Hex && fs.existsSync(v2Cache)) {
        v2Hex = fs.readFileSync(v2Cache, 'utf8');
        if (!v2Hex.trim().startsWith(':')) v2Hex = null;
    }
    
    if (!v1Hex || !v2Hex) {
        throw new Error(t.microbit.notifications.installErrorMissing || 'Fichiers HEX MicroPython introuvables. Utilisez "Micro:bit > Installer les runtimes" pour les télécharger.');
    }
    
    return { v1Hex, v2Hex };
}

// Convertir le code MakeCode Python en MicroPython standard
// MakeCode utilise: basic.show_icon(IconNames.Heart), basic.forever(on_forever)
// MicroPython utilise: display.show(Image.HEART), while True: on_forever()
function convertMakeCodeToMicroPython(code) {
    let converted = code.trim();
    
    // Normaliser les fins de ligne
    converted = converted.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    // Normaliser l'indentation (remplacer les tabs par 4 espaces)
    const lines = converted.split('\n');
    const normalizedLines = lines.map(line => {
        // Remplacer les tabs par 4 espaces
        let normalized = line.replace(/\t/g, '    ');
        return normalized;
    });
    converted = normalizedLines.join('\n');
    
    // Ajouter l'import si absent
    if (!converted.includes('from microbit import')) {
        converted = 'from microbit import *\n\n' + converted;
    }
    
    // Ajouter les imports supplémentaires si nécessaires
    const needsStruct = converted.includes('radio.send_value') || converted.includes('radio.receive_value');
    const needsMusic = converted.includes('music.') && !converted.includes('import music');
    const needsRadio = converted.includes('radio.') && !converted.includes('import radio');
    
    if (needsStruct && !converted.includes('import struct')) {
        converted = converted.replace(/^(from microbit import \*)/m, '$1\nimport struct');
    }
    if (needsMusic && !converted.includes('import music')) {
        converted = converted.replace(/^(from microbit import \*)/m, '$1\nimport music');
    }
    if (needsRadio && !converted.includes('import radio')) {
        converted = converted.replace(/^(from microbit import \*)/m, '$1\nimport radio');
    }
    
    // Mapping des icônes MakeCode vers MicroPython
    const iconMap = {
        'Heart': 'HEART',
        'SmallHeart': 'HEART_SMALL',
        'Yes': 'YES',
        'No': 'NO',
        'Happy': 'HAPPY',
        'Sad': 'SAD',
        'Confused': 'CONFUSED',
        'Angry': 'ANGRY',
        'Asleep': 'ASLEEP',
        'Surprised': 'SURPRISED',
        'Silly': 'SILLY',
        'Fabulous': 'FABULOUS',
        'Meh': 'MEH',
        'TShirt': 'TSHIRT',
        'Rollerskate': 'ROLLERSKATE',
        'Duck': 'DUCK',
        'House': 'HOUSE',
        'Tortoise': 'TORTOISE',
        'Butterfly': 'BUTTERFLY',
        'StickFigure': 'STICK_FIGURE',
        'Ghost': 'GHOST',
        'Sword': 'SWORD',
        'Giraffe': 'GIRAFFE',
        'Skull': 'SKULL',
        'Umbrella': 'UMBRELLA',
        'Snake': 'SNAKE',
        'Rabbit': 'RABBIT',
        'Cow': 'COW',
        'QuarterNote': 'QUARTER_NOTE',
        'EigthNote': 'EIGHTH_NOTE',
        'Pitchfork': 'PITCHFORK',
        'Tent': 'TENT',
        'Jagged': 'JAGGED',
        'Target': 'TARGET',
        'Triangle': 'TRIANGLE',
        'LeftTriangle': 'TRIANGLE_LEFT',
        'Chessboard': 'CHESSBOARD',
        'Diamond': 'DIAMOND',
        'SmallDiamond': 'DIAMOND_SMALL',
        'Square': 'SQUARE',
        'SmallSquare': 'SQUARE_SMALL',
        'Scissors': 'SCISSORS',
        'ArrowNorth': 'ARROW_N',
        'ArrowNorthEast': 'ARROW_NE',
        'ArrowEast': 'ARROW_E',
        'ArrowSouthEast': 'ARROW_SE',
        'ArrowSouth': 'ARROW_S',
        'ArrowSouthWest': 'ARROW_SW',
        'ArrowWest': 'ARROW_W',
        'ArrowNorthWest': 'ARROW_NW',
        'MusicNote': 'MUSIC_NOTE',
        'MusicNoteBeamed': 'MUSIC_NOTE_BEAMED',
        'MusicalScore': 'MUSICAL_SCORE',
        'Xmas': 'XMAS',
        'Pacman': 'PACMAN'
    };
    
    // Convertir basic.show_icon(IconNames.XXX) en display.show(Image.XXX)
    converted = converted.replace(/basic\.show_icon\s*\(\s*IconNames\.(\w+)\s*\)/g, (match, iconName) => {
        const microPythonIcon = iconMap[iconName] || iconName.toUpperCase();
        return `display.show(Image.${microPythonIcon})`;
    });
    
    // Convertir basic.clear_screen() en display.clear()
    converted = converted.replace(/basic\.clear_screen\s*\(\s*\)/g, 'display.clear()');
    
    // Convertir basic.forever(on_forever) - on va le gérer APRÈS l'intégration des gestionnaires
    // Pour l'instant, on collecte juste le nom de la fonction
    let foreverFuncName = null;
    const foreverMatch = converted.match(/basic\.forever\s*\(\s*(\w+)\s*\)/);
    if (foreverMatch) {
        foreverFuncName = foreverMatch[1];
        // Retirer la ligne basic.forever pour l'instant
        converted = converted.replace(/basic\.forever\s*\(\s*(\w+)\s*\)/g, '');
    }
    
    // Convertir input.on_button_pressed(Button.A, on_button_pressed_a) 
    // MakeCode utilise des gestionnaires d'événements, MicroPython utilise des vérifications dans une boucle
    // On va collecter les gestionnaires et les intégrer dans la boucle principale
    const buttonHandlers = [];
    converted = converted.replace(/input\.on_button_pressed\s*\(\s*Button\.([AB])\s*,\s*(\w+)\s*\)/g, (match, button, funcName) => {
        const buttonName = button.toLowerCase() === 'a' ? 'button_a' : 'button_b';
        buttonHandlers.push({ button: buttonName, func: funcName });
        // Retirer la ligne input.on_button_pressed (remplacer par ligne vide qui sera nettoyée)
        return '';
    });
    
    // Convertir pins.analog_pitch(pin, freq)
    // MakeCode: pins.analog_pitch(12, 500) génère un signal PWM à 500Hz sur pin12
    // IMPORTANT: music.pitch(freq, duration) ne prend PAS de paramètre pin - il joue toujours sur le haut-parleur intégré
    // Pour utiliser un pin spécifique comme dans MakeCode, on doit utiliser:
    // pin.set_analog_period_microseconds() + pin.write_analog()
    // Traiter ligne par ligne pour préserver l'indentation
    const hasAnalogPitch = /pins\.analog_pitch/.test(converted);
    if (hasAnalogPitch) {
        const codeLines = converted.split('\n');
        const analogPitchLines = [];
        
        for (let i = 0; i < codeLines.length; i++) {
            const line = codeLines[i];
            const indentMatch = line.match(/^(\s*)/);
            const indent = indentMatch ? indentMatch[1] : '';
            
            // Remplacer pins.analog_pitch(pin, freq) - accepter nombres ET variables
            const analogPitchMatch = line.match(/pins\.analog_pitch\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)/);
            if (analogPitchMatch) {
                const pin = analogPitchMatch[1];
                const freq = analogPitchMatch[2];
                // Calculer la période en microsecondes: période = 1/fréquence
                // Utiliser write_analog avec 512 (50% duty cycle) pour générer le signal
                // Si pin est un nombre, utiliser pinX, sinon c'est une variable et on doit l'utiliser telle quelle
                // Note: Si pin est une variable, l'utilisateur doit s'assurer qu'elle contient le numéro de pin
                const isPinNumber = /^\d+$/.test(pin);
                const pinExpr = isPinNumber ? `pin${pin}` : pin; // Si c'est une variable, l'utiliser directement
                const periodExpr = `int(1000000 / ${freq})`;
                analogPitchLines.push(`${indent}${pinExpr}.set_analog_period_microseconds(${periodExpr})`);
                analogPitchLines.push(`${indent}${pinExpr}.write_analog(512)`);
            } else {
                analogPitchLines.push(line);
            }
        }
        
        converted = analogPitchLines.join('\n');
    }
    
    // Convertir basic.show_string("text") en display.scroll("text")
    converted = converted.replace(/basic\.show_string\s*\(\s*([^)]+)\s*\)/g, 'display.scroll($1)');
    
    // Convertir basic.show_number(num) en display.scroll(str(num))
    converted = converted.replace(/basic\.show_number\s*\(\s*([^)]+)\s*\)/g, 'display.scroll(str($1))');
    
    // Convertir d'autres fonctions basic.* en display.* si nécessaire
    converted = converted.replace(/basic\.show\s*\(/g, 'display.show(');
    converted = converted.replace(/basic\.clear\s*\(/g, 'display.clear(');
    converted = converted.replace(/basic\.pause\s*\(/g, 'sleep(');
    
    // Convertir input.on_gesture(Gesture.Shake, handler) en gestionnaire d'événement
    const gestureHandlers = [];
    converted = converted.replace(/input\.on_gesture\s*\(\s*Gesture\.(\w+)\s*,\s*(\w+)\s*\)/g, (match, gesture, funcName) => {
        gestureHandlers.push({ gesture: gesture.toLowerCase(), func: funcName });
        return '';
    });
    
    // Convertir input.button_is_pressed(Button.A) en button_a.is_pressed()
    converted = converted.replace(/input\.button_is_pressed\s*\(\s*Button\.([AB])\s*\)/g, (match, button) => {
        const buttonName = button.toLowerCase() === 'a' ? 'button_a' : 'button_b';
        return `${buttonName}.is_pressed()`;
    });
    
    // Convertir input.acceleration(Dimension.X) en accelerometer.get_x()
    converted = converted.replace(/input\.acceleration\s*\(\s*Dimension\.([XYZ])\s*\)/g, (match, dim) => {
        return `accelerometer.get_${dim.toLowerCase()}()`;
    });
    
    // Convertir input.compass_heading() en compass.heading()
    converted = converted.replace(/input\.compass_heading\s*\(\s*\)/g, 'compass.heading()');
    
    // Convertir input.calibrate_compass() en compass.calibrate()
    converted = converted.replace(/input\.calibrate_compass\s*\(\s*\)/g, 'compass.calibrate()');
    
    // Convertir input.temperature() en temperature()
    converted = converted.replace(/input\.temperature\s*\(\s*\)/g, 'temperature()');
    
    // Convertir pins.digital_write_pin(DigitalPin.P0, 1) en pin0.write_digital(1)
    converted = converted.replace(/pins\.digital_write_pin\s*\(\s*DigitalPin\.P(\d+)\s*,\s*([^)]+)\s*\)/g, (match, pin, value) => {
        return `pin${pin}.write_digital(${value})`;
    });
    
    // Convertir pins.digital_read_pin(DigitalPin.P0) en pin0.read_digital()
    converted = converted.replace(/pins\.digital_read_pin\s*\(\s*DigitalPin\.P(\d+)\s*\)/g, (match, pin) => {
        return `pin${pin}.read_digital()`;
    });
    
    // Convertir pins.analog_write_pin(AnalogPin.P0, 512) en pin0.write_analog(512)
    converted = converted.replace(/pins\.analog_write_pin\s*\(\s*AnalogPin\.P(\d+)\s*,\s*([^)]+)\s*\)/g, (match, pin, value) => {
        return `pin${pin}.write_analog(${value})`;
    });
    
    // Convertir pins.analog_read_pin(AnalogPin.P0) en pin0.read_analog()
    converted = converted.replace(/pins\.analog_read_pin\s*\(\s*AnalogPin\.P(\d+)\s*\)/g, (match, pin) => {
        return `pin${pin}.read_analog()`;
    });
    
    // Convertir music.play_tone(freq, duration) en music.pitch(freq, duration)
    converted = converted.replace(/music\.play_tone\s*\(\s*([^,]+)\s*,\s*([^)]+)\s*\)/g, 'music.pitch($1, $2)');
    
    // Convertir music.stop_all_sounds() en music.stop()
    converted = converted.replace(/music\.stop_all_sounds\s*\(\s*\)/g, 'music.stop()');
    
    // Convertir radio.send_string("text") en radio.send("text")
    converted = converted.replace(/radio\.send_string\s*\(\s*([^)]+)\s*\)/g, 'radio.send($1)');
    
    // Convertir radio.receive_string() en radio.receive()
    converted = converted.replace(/radio\.receive_string\s*\(\s*\)/g, 'radio.receive()');
    
    // Convertir radio.set_group(1) en radio.config(group=1)
    converted = converted.replace(/radio\.set_group\s*\(\s*([^)]+)\s*\)/g, 'radio.config(group=$1)');
    
    // Convertir input.on_logo_event(TouchButtonEvent.Pressed, handler) en gestionnaire
    const logoTouchHandlers = [];
    converted = converted.replace(/input\.on_logo_event\s*\(\s*TouchButtonEvent\.(\w+)\s*,\s*(\w+)\s*\)/g, (match, event, funcName) => {
        logoTouchHandlers.push({ func: funcName });
        return '';
    });
    
    // Nettoyer les lignes vides multiples créées par la suppression des gestionnaires
    converted = converted.replace(/\n{3,}/g, '\n\n');
    
    // Ajouter les gestionnaires de gestes et logo aux gestionnaires de boutons
    if (gestureHandlers.length > 0 || logoTouchHandlers.length > 0) {
        gestureHandlers.forEach(h => buttonHandlers.push({ button: 'accelerometer', gesture: h.gesture, func: h.func }));
        logoTouchHandlers.forEach(h => buttonHandlers.push({ button: 'pin_logo', func: h.func }));
    }
    
    // Intégrer les gestionnaires de boutons dans la boucle principale
    if (buttonHandlers.length > 0) {
        const lines = converted.split('\n');
        const newLines = [];
        let foundMainLoop = false;
        let mainLoopIndex = -1;
        
        // Chercher la boucle while True
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('while True:') && !foundMainLoop) {
                foundMainLoop = true;
                mainLoopIndex = i;
                break;
            }
        }
        
        // Reconstruire le code
        for (let i = 0; i < lines.length; i++) {
            newLines.push(lines[i]);
            
            // Si on est à la ligne while True, ajouter les vérifications de boutons
            if (i === mainLoopIndex && foundMainLoop) {
                // Trouver l'indentation de la ligne suivante (ou utiliser 4 espaces par défaut)
                let nextLine = lines[i + 1] || '';
                const indentMatch = nextLine.match(/^(\s*)/);
                const indent = indentMatch && indentMatch[1] ? indentMatch[1] : '    ';
                
                // Ajouter les vérifications de boutons, gestes et logo avant l'appel à on_forever
                buttonHandlers.forEach(handler => {
                    if (handler.gesture) {
                        // Gestionnaire de geste
                        newLines.push(`${indent}if accelerometer.was_gesture("${handler.gesture}"):`);
                        newLines.push(`${indent}    ${handler.func}()`);
                    } else if (handler.button === 'pin_logo') {
                        // Gestionnaire logo touch
                        newLines.push(`${indent}if pin_logo.is_touched():`);
                        newLines.push(`${indent}    ${handler.func}()`);
                    } else {
                        // Gestionnaire de bouton
                        newLines.push(`${indent}if ${handler.button}.was_pressed():`);
                        newLines.push(`${indent}    ${handler.func}()`);
                    }
                });
                
                // Si on a une fonction forever, l'appeler après les gestionnaires
                if (foreverFuncName && converted.includes(`def ${foreverFuncName}`)) {
                    newLines.push(`${indent}${foreverFuncName}()`);
                }
            }
        }
        
        // Si pas de boucle while True trouvée, créer une boucle principale à la fin
        if (!foundMainLoop) {
            newLines.push('');
            newLines.push('while True:');
            buttonHandlers.forEach(handler => {
                if (handler.gesture) {
                    // Gestionnaire de geste
                    newLines.push(`    if accelerometer.was_gesture("${handler.gesture}"):`);
                    newLines.push(`        ${handler.func}()`);
                } else if (handler.button === 'pin_logo') {
                    // Gestionnaire logo touch
                    newLines.push(`    if pin_logo.is_touched():`);
                    newLines.push(`        ${handler.func}()`);
                } else {
                    // Gestionnaire de bouton
                    newLines.push(`    if ${handler.button}.was_pressed():`);
                    newLines.push(`        ${handler.func}()`);
                }
            });
            // Chercher on_forever et l'appeler dans la boucle (utiliser foreverFuncName si disponible)
            const foreverToCall = foreverFuncName || 'on_forever';
            if (converted.includes(`def ${foreverToCall}`)) {
                newLines.push(`    ${foreverToCall}()`);
            }
            newLines.push('    sleep(10)');
        }
        
        converted = newLines.join('\n');
    } else if (foreverFuncName && !converted.includes('while True:')) {
        // Si pas de gestionnaires mais qu'il y a basic.forever, créer la boucle
        const foreverLines = converted.split('\n');
        const foreverNewLines = [];
        let foundForeverDef = false;
        
        for (let i = 0; i < foreverLines.length; i++) {
            foreverNewLines.push(foreverLines[i]);
            // Si on trouve la définition de la fonction forever, ajouter la boucle après
            if (foreverLines[i].includes(`def ${foreverFuncName}`) && !foundForeverDef) {
                foundForeverDef = true;
                // Trouver la fin de la fonction (ligne non indentée suivante ou fin du fichier)
                let j = i + 1;
                while (j < foreverLines.length && (foreverLines[j].trim() === '' || foreverLines[j].match(/^\s+/))) {
                    j++;
                }
                // Insérer la boucle après la fonction
                foreverNewLines.push('');
                foreverNewLines.push('while True:');
                foreverNewLines.push(`    ${foreverFuncName}()`);
                foreverNewLines.push('    sleep(10)');
            }
        }
        
        converted = foreverNewLines.join('\n');
    }
    
    // S'assurer que le code se termine par un saut de ligne
    if (!converted.endsWith('\n')) {
        converted += '\n';
    }
    
    console.log('Code converti de MakeCode vers MicroPython:');
    console.log(converted);
    
    return converted;
}

// Valider la syntaxe Python de base (détection d'erreurs courantes)
function validatePythonSyntax(code) {
    const errors = [];
    const lines = code.split('\n');
    
    // Vérifier les parenthèses, crochets et accolades équilibrés
    let parenCount = 0;
    let bracketCount = 0;
    let braceCount = 0;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;
        
        // Compter les parenthèses, crochets et accolades
        for (const char of line) {
            if (char === '(') parenCount++;
            else if (char === ')') parenCount--;
            else if (char === '[') bracketCount++;
            else if (char === ']') bracketCount--;
            else if (char === '{') braceCount++;
            else if (char === '}') braceCount--;
        }
        
        // Vérifier les erreurs d'indentation (lignes qui commencent après un : sans indentation)
        if (i > 0) {
            const prevLine = lines[i - 1].trim();
            const currentLine = line.trim();
            
            // Si la ligne précédente se termine par : et la ligne actuelle n'est pas vide
            if (prevLine.endsWith(':') && currentLine && !currentLine.startsWith('#') && !currentLine.startsWith('def ') && !currentLine.startsWith('class ')) {
                // Vérifier que la ligne actuelle est indentée
                const indentMatch = line.match(/^(\s*)/);
                const indent = indentMatch ? indentMatch[1] : '';
                if (indent.length === 0 && currentLine.length > 0) {
                    errors.push({
                        line: lineNum,
                        message: t.microbit.validation.indentationError || 'Erreur d\'indentation: ligne attendue après ":"'
                    });
                }
            }
        }
        
        // Vérifier les guillemets non fermés
        const singleQuotes = (line.match(/'/g) || []).length;
        const doubleQuotes = (line.match(/"/g) || []).length;
        if (singleQuotes % 2 !== 0 && !line.includes("'")) {
            // Ignorer les cas où c'est dans une chaîne multi-lignes
        }
    }
    
    // Vérifier les parenthèses/crochets/accolades non fermés
    if (parenCount !== 0) {
        errors.push({
            line: lines.length,
            message: (t.microbit.validation.unbalancedParentheses || 'Parenthèses non équilibrées ({count})').replace('{count}', `${parenCount > 0 ? '+' : ''}${parenCount}`)
        });
    }
    if (bracketCount !== 0) {
        errors.push({
            line: lines.length,
            message: (t.microbit.validation.unbalancedBrackets || 'Crochets non équilibrés ({count})').replace('{count}', `${bracketCount > 0 ? '+' : ''}${bracketCount}`)
        });
    }
    if (braceCount !== 0) {
        errors.push({
            line: lines.length,
            message: (t.microbit.validation.unbalancedBraces || 'Accolades non équilibrées ({count})').replace('{count}', `${braceCount > 0 ? '+' : ''}${braceCount}`)
        });
    }
    
    // Vérifier les imports manquants pour les fonctions utilisées
    const hasMusic = code.includes('music.') && !code.includes('import music') && !code.includes('from microbit import');
    const hasRadio = code.includes('radio.') && !code.includes('import radio') && !code.includes('from microbit import');
    
    if (hasMusic) {
        errors.push({
            line: 1,
            message: t.microbit.validation.missingImportMusic || 'Import manquant: ajoutez "import music" ou "from microbit import *"'
        });
    }
    if (hasRadio) {
        errors.push({
            line: 1,
            message: t.microbit.validation.missingImportRadio || 'Import manquant: ajoutez "import radio" ou "from microbit import *"'
        });
    }
    
    return errors;
}

// Afficher le code MicroPython converti dans une fenêtre
function showConvertedCodeWindow(code, originalCode = null) {
    const codeWindow = new BrowserWindow({
        width: 900,
        height: 700,
        title: t.microbit.convertedCode.title || 'Code MicroPython Converti',
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });
    
    // Masquer complètement la barre de menu
    codeWindow.setMenuBarVisibility(false);
    
    const title = t.microbit.convertedCode.title || 'Code MicroPython Converti';
    const description = t.microbit.convertedCode.description || 'Ce code a été automatiquement converti depuis MakeCode Python vers MicroPython standard';
    const copyButton = t.microbit.convertedCode.copyButton || 'Copier le code';
    const closeButton = t.microbit.convertedCode.closeButton || 'Fermer';
    const copySuccess = t.microbit.convertedCode.copySuccess || 'Code copié dans le presse-papiers !';
    
    const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>${title}</title>
    <style>
        body {
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            margin: 0;
            padding: 20px;
            background: #1e1e1e;
            color: #d4d4d4;
        }
        .header {
            background: #252526;
            padding: 15px;
            margin: -20px -20px 20px -20px;
            border-bottom: 1px solid #3e3e42;
        }
        h1 {
            margin: 0 0 10px 0;
            font-size: 18px;
            color: #ffffff;
        }
        .info {
            font-size: 12px;
            color: #858585;
            margin-bottom: 10px;
        }
        .code-container {
            background: #1e1e1e;
            border: 1px solid #3e3e42;
            border-radius: 4px;
            overflow: auto;
            max-height: calc(100vh - 200px);
        }
        .code-wrapper {
            position: relative;
        }
        .line-numbers {
            position: absolute;
            left: 0;
            top: 0;
            background: #252526;
            color: #858585;
            padding: 10px 15px;
            border-right: 1px solid #3e3e42;
            font-size: 14px;
            line-height: 1.6;
            user-select: none;
            min-width: 50px;
            text-align: right;
        }
        .code-content {
            margin-left: 70px;
            padding: 10px 15px;
            font-size: 14px;
            line-height: 1.6;
            white-space: pre;
            overflow-x: auto;
        }
        .code-line {
            min-height: 22.4px;
        }
        .actions {
            margin-top: 15px;
            display: flex;
            gap: 10px;
        }
        button {
            background: #0e639c;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        }
        button:hover {
            background: #1177bb;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>${title}</h1>
        <div class="info">${description}</div>
    </div>
    <div class="code-container">
        <div class="code-wrapper">
            <div class="line-numbers" id="lineNumbers"></div>
            <div class="code-content" id="codeContent"></div>
        </div>
    </div>
    <div class="actions">
        <button onclick="copyCode()">${copyButton}</button>
        <button onclick="closeWindow()">${closeButton}</button>
    </div>
    <script>
        const code = ${JSON.stringify(code)};
        const lines = code.split('\\n');
        
        // Générer les numéros de ligne
        let lineNumbersHtml = '';
        let codeContentHtml = '';
        lines.forEach((line, index) => {
            lineNumbersHtml += '<div class="code-line">' + (index + 1) + '</div>';
            codeContentHtml += '<div class="code-line">' + escapeHtml(line) + '</div>';
        });
        
        document.getElementById('lineNumbers').innerHTML = lineNumbersHtml;
        document.getElementById('codeContent').innerHTML = codeContentHtml;
        
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        function copyCode() {
            navigator.clipboard.writeText(code).then(() => {
                alert('${copySuccess}');
            }).catch(err => {
                console.error('Erreur lors de la copie:', err);
            });
        }
        
        function closeWindow() {
            window.close();
        }
    </script>
</body>
</html>`;
    
    codeWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

// Compiler le code Python en HEX (méthode PythonEditor)
async function compilePythonToHex(code) {
    console.log('Compiling Python to HEX using microbit-fs (PythonEditor method)...');
    
    try {
        // Convertir le code MakeCode en MicroPython standard si nécessaire
        let microPythonCode = code;
        if (code.includes('basic.') || code.includes('IconNames.') || code.includes('basic.forever')) {
            console.log('Détection de code MakeCode, conversion en MicroPython...');
            microPythonCode = convertMakeCodeToMicroPython(code);
        } else if (!microPythonCode.includes('from microbit import')) {
            // Ajouter l'import si absent même pour du code MicroPython standard
            microPythonCode = 'from microbit import *\n\n' + microPythonCode;
        }
        
        // Charger les runtimes MicroPython V1 et V2
        const { v1Hex, v2Hex } = await ensureMicroPythonHexes();
        
        // Créer le système de fichiers MicroPython avec les deux runtimes
        const fsHex = new MicropythonFsHex([
            { hex: v1Hex, boardId: microbitBoardId.V1 },
            { hex: v2Hex, boardId: microbitBoardId.V2 }
        ]);
        
        // Écrire le code Python dans main.py (comme PythonEditor)
        fsHex.write('main.py', microPythonCode);
        
        // Générer le HEX universel (compatible V1 et V2)
        const hexContent = fsHex.getUniversalHex();
        
        console.log('Compilation successful, HEX length:', hexContent.length);
        return hexContent;
    } catch (err) {
        console.error('Error compiling Python to HEX:', err && err.stack ? err.stack : err);
        const errMsg = (err && err.message) ? err.message : (err && err.toString) ? err.toString() : 'Erreur inconnue';
        throw new Error('Erreur lors de la compilation: ' + errMsg);
    }
}

// Détecter les lecteurs micro:bit disponibles (comme listArduinoBoards)
function listMicrobitDrives(browserWindow) {
    const drives = [];
    
    if (process.platform === 'win32') {
        // Windows : lister tous les lecteurs et vérifier la présence de DETAILS.TXT
        const { exec } = require('child_process');
        exec('wmic logicaldisk get Name', (error, stdout) => {
            if (error) {
                console.error(`Error listing drives: ${error}`);
                updateMicrobitDrivesList(drives, browserWindow);
                return;
            }
            
            console.log('WMIC output:', JSON.stringify(stdout));
            
            // Parser les lettres de lecteurs (C:, D:, E:, etc.)
            // wmic retourne des lignes avec \r\r\n, utiliser un regex global pour extraire toutes les lettres
            const driveLetterMatches = stdout.matchAll(/([A-Z]):/gi);
            const driveLetters = [];
            for (const match of driveLetterMatches) {
                const driveLetter = match[1].toUpperCase() + ':';
                if (!driveLetters.includes(driveLetter)) {
                    driveLetters.push(driveLetter);
                }
            }
            
            console.log('Found drive letters:', driveLetters);
            
            console.log('Found drive letters:', driveLetters);
            
            // Vérifier chaque lecteur pour la présence de DETAILS.TXT de micro:bit
            let checkedCount = 0;
            for (const driveLetter of driveLetters) {
                try {
                    const detailsPath = path.join(driveLetter, 'DETAILS.TXT');
                    console.log(`Checking ${driveLetter} for DETAILS.TXT: ${detailsPath}`);
                    
                    if (fs.existsSync(detailsPath)) {
                        console.log(`DETAILS.TXT found on ${driveLetter}`);
                        const content = fs.readFileSync(detailsPath, 'utf8');
                        console.log(`DETAILS.TXT content preview: ${content.substring(0, 200)}`);
                        
                        // Vérifier que c'est bien un fichier DETAILS.TXT de micro:bit
                        // DAPLink peut être "DAPLink Firmware" ou juste "DAPLink"
                        const isMicrobit = content.includes('DAPLink') || 
                                          content.includes('Interface Version') || 
                                          content.includes('HIC ID') || 
                                          content.includes('Unique ID:') ||
                                          content.includes('Version:');
                        
                        if (isMicrobit) {
                            console.log(`Micro:bit confirmed on ${driveLetter}`);
                            
                            // Essayer de récupérer le nom du volume
                            let volName = 'MICROBIT';
                            try {
                                const { execSync } = require('child_process');
                                const volOutput = execSync(`wmic logicaldisk where "Name='${driveLetter}'" get VolumeName`, { encoding: 'utf8' });
                                const volLines = volOutput.split('\n').map(l => l.trim()).filter(Boolean);
                                for (const volLine of volLines) {
                                    if (volLine && volLine !== 'VolumeName' && volLine.length > 0) {
                                        volName = volLine;
                                        break;
                                    }
                                }
                            } catch (e) {
                                console.log(`Could not get volume name for ${driveLetter}:`, e.message);
                            }
                            
                            drives.push({
                                drive: driveLetter,
                                volName: volName
                            });
                            console.log(`Added micro:bit: ${driveLetter} (${volName})`);
                        } else {
                            console.log(`DETAILS.TXT found but not a micro:bit on ${driveLetter}`);
                        }
                    }
                } catch (e) {
                    console.log(`Error checking ${driveLetter}:`, e.message);
                    // Ignorer les erreurs (lecteur peut être inaccessible)
                }
                checkedCount++;
            }
            
            console.log(`Checked ${checkedCount} drives, found ${drives.length} micro:bit(s)`);
            updateMicrobitDrivesList(drives, browserWindow);
        });
    } else if (process.platform === 'linux') {
        // Linux : chercher dans /media et /mnt
        const { exec } = require('child_process');
        exec('lsblk -n -o MOUNTPOINT', (error, stdout) => {
            if (error) {
                console.error(`Error listing mount points: ${error}`);
                updateMicrobitDrivesList(drives, browserWindow);
                return;
            }
            
            const mountPoints = stdout.split('\n').map(l => l.trim()).filter(Boolean);
            for (const mountPoint of mountPoints) {
                if (mountPoint.startsWith('/media/') || mountPoint.startsWith('/mnt/')) {
                    try {
                        const detailsPath = path.join(mountPoint, 'DETAILS.TXT');
                        if (fs.existsSync(detailsPath)) {
                            const content = fs.readFileSync(detailsPath, 'utf8');
                            if (content.includes('Interface Version') || content.includes('HIC ID') || content.includes('DAPLink') || content.includes('Version:') || content.includes('Unique ID:')) {
                                drives.push({
                                    drive: mountPoint,
                                    volName: path.basename(mountPoint) || 'MICROBIT'
                                });
                            }
                        }
                    } catch (e) {
                        // Ignorer les erreurs
                    }
                }
            }
            
            updateMicrobitDrivesList(drives, browserWindow);
        });
    } else if (process.platform === 'darwin') {
        // macOS : chercher dans /Volumes
        try {
            const volumesDir = '/Volumes';
            if (fs.existsSync(volumesDir)) {
                const volumes = fs.readdirSync(volumesDir);
                for (const volume of volumes) {
                    const volumePath = path.join(volumesDir, volume);
                    try {
                        const detailsPath = path.join(volumePath, 'DETAILS.TXT');
                        if (fs.existsSync(detailsPath)) {
                            const content = fs.readFileSync(detailsPath, 'utf8');
                            if (content.includes('Interface Version') || content.includes('HIC ID') || content.includes('DAPLink') || content.includes('Version:') || content.includes('Unique ID:')) {
                                drives.push({
                                    drive: volumePath,
                                    volName: volume || 'MICROBIT'
                                });
                            }
                        }
                    } catch (e) {
                        // Ignorer les erreurs
                    }
                }
            }
        } catch (e) {
            console.error('Error listing macOS volumes:', e);
        }
        
        updateMicrobitDrivesList(drives, browserWindow);
    }
}

// Mettre à jour la liste des lecteurs micro:bit détectés
function updateMicrobitDrivesList(drives, browserWindow) {
    console.log('updateMicrobitDrivesList called with', drives.length, 'drives:', drives);
    console.log('Drives details:', JSON.stringify(drives, null, 2));
    
    // Toujours mettre à jour, même si pas de changement, pour s'assurer que le menu est à jour
    const hasChanges = drives.length !== previousMicrobitDrives.length ||
        JSON.stringify(drives) !== JSON.stringify(previousMicrobitDrives);
    
    console.log('Has changes:', hasChanges, 'Previous:', previousMicrobitDrives.length, 'Current:', drives.length);
    
    // Mettre à jour la liste même si pas de changement détecté (pour forcer le refresh)
    previousMicrobitDrives = drives;
    
    // Toujours rafraîchir le menu pour s'assurer qu'il est à jour
    refreshMenu();
    
    if (hasChanges && browserWindow) {
        if (drives.length === 0) {
            // Pas de notification si aucune carte trouvée (pour éviter le spam)
            console.log('No micro:bit drives found');
        } else if (drives.length === 1) {
            // Auto-sélectionner si une seule carte
            selectedMicrobitDrive = drives[0].drive;
            console.log('Auto-selected micro:bit:', selectedMicrobitDrive);
        } else {
            console.log('Multiple micro:bit drives found, user must select');
        }
    }
}

// Télécharger un fichier depuis une URL
async function downloadToFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        file.on('error', err => {
            try { fs.unlinkSync(destPath); } catch (e) {}
            reject(err);
        });
        https.get(url, res => {
            if (res.statusCode !== 200) {
                try { file.close(); } catch (e) {}
                try { fs.unlinkSync(destPath); } catch (e) {}
                reject(new Error('HTTP ' + res.statusCode));
                return;
            }
            res.pipe(file);
            file.on('finish', () => file.close(() => resolve()));
        }).on('error', err => {
            try { file.close(); } catch (e) {}
            try { fs.unlinkSync(destPath); } catch (e) {}
            reject(err);
        });
    });
}

// Installer les runtimes MicroPython (comme installArduino)
async function installMicroPythonRuntimes(browserWindow) {
    try {
        showNotification(browserWindow, t.microbit.notifications.installProgress || 'Installation des runtimes MicroPython...');
        
        const directoryAppAsar = isDev() ? __dirname : path.join(__dirname, '../../');
        const cacheDir = path.join(directoryAppAsar, 'microbit-cache');
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }
        
        const v1Path = path.join(directoryAppAsar, './microbit/MICROBIT_V1.hex');
        const v2Path = path.join(directoryAppAsar, './microbit/MICROBIT.hex');
        const v1Cache = path.join(cacheDir, 'MICROBIT_V1.hex');
        const v2Cache = path.join(cacheDir, 'MICROBIT.hex');
        
        let v1Hex = null;
        let v2Hex = null;
        
        // Vérifier d'abord dans les ressources packagées
        if (fs.existsSync(v1Path)) {
            v1Hex = fs.readFileSync(v1Path, 'utf8');
            if (v1Hex.trim().startsWith(':')) {
                try { fs.writeFileSync(v1Cache, v1Hex, 'utf8'); } catch (e) {}
            }
        }
        if (fs.existsSync(v2Path)) {
            v2Hex = fs.readFileSync(v2Path, 'utf8');
            if (v2Hex.trim().startsWith(':')) {
                try { fs.writeFileSync(v2Cache, v2Hex, 'utf8'); } catch (e) {}
            }
        }
        
        // Vérifier dans le cache
        if (!v1Hex && fs.existsSync(v1Cache)) {
            v1Hex = fs.readFileSync(v1Cache, 'utf8');
            if (!v1Hex.trim().startsWith(':')) v1Hex = null;
        }
        if (!v2Hex && fs.existsSync(v2Cache)) {
            v2Hex = fs.readFileSync(v2Cache, 'utf8');
            if (!v2Hex.trim().startsWith(':')) v2Hex = null;
        }
        
        // Télécharger si nécessaire
        if (!v1Hex) {
            const candidateUrls = [
                'https://raw.githubusercontent.com/bbcmicrobit/micropython/master/build/firmware.hex',
                'https://raw.githubusercontent.com/bbcmicrobit/micropython/refs/heads/master/build/firmware.hex'
            ];
            for (const url of candidateUrls) {
                try {
                    await downloadToFile(url, v1Cache);
                    v1Hex = fs.readFileSync(v1Cache, 'utf8');
                    if (v1Hex.trim().startsWith(':')) break;
                } catch (e) {
                    console.error(`Failed to download MICROBIT_V1.hex from ${url}:`, e);
                }
            }
        }
        
        if (!v2Hex) {
            const candidateUrls = [
                'https://raw.githubusercontent.com/microbit-foundation/micropython-microbit-v2/main/src/MICROBIT.hex',
                'https://raw.githubusercontent.com/microbit-foundation/micropython-microbit-v2/refs/heads/main/src/MICROBIT.hex'
            ];
            for (const url of candidateUrls) {
                try {
                    await downloadToFile(url, v2Cache);
                    v2Hex = fs.readFileSync(v2Cache, 'utf8');
                    if (v2Hex.trim().startsWith(':')) break;
                } catch (e) {
                    console.error(`Failed to download MICROBIT.hex from ${url}:`, e);
                }
            }
        }
        
        if (v1Hex && v2Hex) {
            showNotification(browserWindow, t.microbit.notifications.installSuccess || 'Runtimes MicroPython installés avec succès.');
        } else if (v1Hex || v2Hex) {
            const v1Status = v1Hex ? (t.microbit.notifications.v1Ok || 'V1: OK') : (t.microbit.notifications.v1Missing || 'V1: Manquant');
            const v2Status = v2Hex ? (t.microbit.notifications.v2Ok || 'V2: OK') : (t.microbit.notifications.v2Missing || 'V2: Manquant');
            const partialMsg = (t.microbit.notifications.installPartial || 'Installation partielle') + '\n' + 
                (t.microbit.notifications.installPartialDetails || 'V1: {v1Status}, V2: {v2Status}')
                    .replace('{v1Status}', v1Status)
                    .replace('{v2Status}', v2Status);
            showNotification(browserWindow, partialMsg);
        } else {
            showNotification(browserWindow, t.microbit.notifications.installError || 'Erreur: Impossible de télécharger les runtimes MicroPython.');
        }
    } catch (e) {
        console.error('Error installing MicroPython runtimes:', e);
        showNotification(browserWindow, t.microbit.notifications.installError || 'Erreur lors de l\'installation des runtimes MicroPython.');
    }
}

// Vérifier le résultat du flash (comme pour Arduino)
function checkMicrobitFlashResult(drive, browserWindow, writtenAt = 0) {
    const failPath = path.join(drive, 'FAIL.TXT');
    const detailsPath = path.join(drive, 'DETAILS.TXT');
    const programHexPath = path.join(drive, 'PROGRAM.HEX');
    const maxAttempts = 10;
    const delay = 1500;
    let attempts = 0;
    
    const check = () => {
        try {
            console.log(`[Vérification ${attempts + 1}/${maxAttempts}] PROGRAM.HEX existe: ${fs.existsSync(programHexPath)}, FAIL.TXT existe: ${fs.existsSync(failPath)}`);
            
            // 1. Vérifier FAIL.TXT pour les erreurs
            if (fs.existsSync(failPath)) {
                const st = fs.statSync(failPath);
                // Si FAIL.TXT a été créé/modifié après l'écriture du HEX, c'est une erreur
                if (!writtenAt || st.mtimeMs > writtenAt) {
                    const content = fs.readFileSync(failPath, 'utf8').trim();
                    if (content) {
                        const errorMsg = content.length > 500 ? content.slice(0, 500) + '...' : content;
                        console.error('✗ Erreur détectée dans FAIL.TXT:', errorMsg);
                        showNotification(browserWindow, (t.microbit.notifications.uploadError || 'Erreur de téléversement') + '\n' + errorMsg);
                        return;
                    }
                }
            }
            
            // 2. Vérifier que PROGRAM.HEX a disparu (la micro:bit le supprime après un flash réussi)
            // C'est le signe le plus fiable d'un téléversement réussi
            if (!fs.existsSync(programHexPath)) {
                console.log('✓ PROGRAM.HEX supprimé par la micro:bit - téléversement réussi !');
                showNotification(browserWindow, t.microbit.notifications.uploadSuccessDetailed || t.microbit.notifications.uploadSuccess || 'Téléversement réussi !\nLe programme a été flashé sur la micro:bit.');
                return;
            }
            
            // 3. Vérifier DETAILS.TXT pour des indices de succès
            if (fs.existsSync(detailsPath)) {
                const st = fs.statSync(detailsPath);
                if (!writtenAt || st.mtimeMs > writtenAt) {
                    const content = fs.readFileSync(detailsPath, 'utf8');
                    const lower = content.toLowerCase();
                    if (lower.includes('ok') || lower.includes('flashed') || lower.includes('programmed')) {
                        // Si DETAILS.TXT indique un succès mais PROGRAM.HEX existe encore, attendre un peu
                        if (attempts < 3) {
                            attempts++;
                            setTimeout(check, delay);
                            return;
                        }
                        showNotification(browserWindow, t.microbit.notifications.uploadSuccess || 'Téléversement réussi !');
                        return;
                    }
                }
            }
        } catch (e) {
            console.error('Error checking microbit flash result:', e);
        }
        
        attempts++;
        if (attempts < maxAttempts) {
            console.log(`Vérification du téléversement (tentative ${attempts}/${maxAttempts})...`);
            setTimeout(check, delay);
        } else {
            // Dernière tentative - vérifier une dernière fois
            try {
                if (fs.existsSync(failPath)) {
                    const content = fs.readFileSync(failPath, 'utf8').trim();
                    if (content) {
                        const errorMsg = content.length > 500 ? content.slice(0, 500) + '...' : content;
                        showNotification(browserWindow, (t.microbit.notifications.uploadError || 'Erreur de téléversement') + '\n' + errorMsg);
                        return;
                    }
                }
                
                // Si PROGRAM.HEX existe toujours après toutes les tentatives
                if (fs.existsSync(programHexPath)) {
                    console.warn('PROGRAM.HEX existe toujours après', maxAttempts, 'tentatives');
                    showNotification(browserWindow, (t.microbit.notifications.uploadError || 'Erreur de téléversement') + '\n' + (t.microbit.notifications.uploadErrorFileNotProcessed || 'Le fichier n\'a pas été traité par la carte.\nVérifiez que la carte est bien connectée et réessayez.'));
                } else {
                    // Le fichier a disparu - succès !
                    showNotification(browserWindow, t.microbit.notifications.uploadSuccess || 'Téléversement réussi !');
                }
            } catch (e) {
                console.error('Error reading files on final attempt:', e);
                showNotification(browserWindow, t.microbit.notifications.uploadErrorUnknown || t.microbit.notifications.uploadError || 'Erreur de téléversement - résultat inconnu');
            }
        }
    };
    
    // Commencer la vérification après 1 seconde
    setTimeout(check, 1000);
}

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

        previousBoards = boards;
        refreshMenu();

        if (hasChanges) {
            if (boards.length === 0 && browserWindow) {
                showNotification(browserWindow, t.listPorts.notifications.noPorts);
            }
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
    }, 2000); // Check every second
    
    // Start background micro:bit drive detection service
    listMicrobitDrives(mainWindow);
    microbitDetectionInterval = setInterval(() => {
        listMicrobitDrives(mainWindow);
    }, 2000); // Check every 2 seconds

    // Keep Arduino menu and let board detection service update it
    const mainMenu = Menu.getApplicationMenu();
    if (mainMenu) {
        listArduinoBoards(mainWindow);
        listMicrobitDrives(mainWindow);
    }
});

app.on('window-all-closed', function () {
    // Clear the board detection intervals
    if (boardDetectionInterval) {
        clearInterval(boardDetectionInterval);
    }
    if (microbitDetectionInterval) {
        clearInterval(microbitDetectionInterval);
    }

    if (process.platform !== 'darwin') {
        app.quit();
    }
});

function switchLanguage(locale) {
    const newTranslations = loadTranslations(locale) || loadTranslations('en');
    translations = newTranslations;
    currentLocale = locale;
    BrowserWindow.getAllWindows().forEach(win => {
        win.webContents.send('language-changed', locale);
    });
    refreshMenu();
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
function refreshMenu() {
    const t = translations.menu;
    const locale = currentLocale;
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
                            const clonedElement = editorElement.cloneNode(true);
                            const gutterWrappers = clonedElement.querySelectorAll('.CodeMirror-gutter-wrapper');
                            gutterWrappers.forEach(wrapper => wrapper.remove());
                            const preElements = clonedElement.querySelectorAll('pre');
                            const codeText = Array.from(preElements)
                              .map(pre => pre.textContent.normalize())
                              .join('\\r\\n')
                              .replace(/[\u2018\u2019\u201C\u201D]/g, '"')
                              .replace(/[\u2013\u2014]/g, '-')
                              .replace(/[\u200B]/g, '');
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
            label: 'Arduino',
            submenu: [
                {
                    label: t.listPorts.label,
                    id: 'ports-menu',
                    submenu: previousBoards.map(board => ({
                        label: `${board.port} - ${board.boardName}`,
                        type: 'radio',
                        checked: selectedPort === board.port,
                        click: () => {
                            selectedPort = board.port;
                            const mainWindow = BrowserWindow.getAllWindows()[0];
                            if (mainWindow) {
                                showNotification(mainWindow, t.listPorts.notifications.portSelected.replace('{port}', board.port) + ', ' + board.boardName);
                            }
                            selectedBoard = board.boardName;
                        }
                    }))
                },
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
                        browserWindow.webContents.executeJavaScript(`
                          (() => {
                            const editorElement = document.querySelector('.CodeMirror-code');
                            if (!editorElement) 
                                return 'empty';
                            const clonedElement = editorElement.cloneNode(true);
                            const gutterWrappers = clonedElement.querySelectorAll('.CodeMirror-gutter-wrapper');
                            gutterWrappers.forEach(wrapper => wrapper.remove());
                            const preElements = clonedElement.querySelectorAll('pre');
                            const codeText = Array.from(preElements)
                              .map(pre => pre.textContent.normalize())
                              .join('\\r\\n')
                              .replace(/[\u2018\u2019\u201C\u201D]/g, '"')
                              .replace(/[\u2013\u2014]/g, '-')
                              .replace(/[\u200B]/g, '');
                            return codeText && codeText !== 'undefined' ? codeText : 'empty';
                          })()
                            `).then(code => {
                            if (code === 'empty') {
                                showNotification(browserWindow, t.copyCode.notifications.empty);
                                return;
                            }
                            const sketchPath = path.join(directory, '/sketch/sketch.ino');
                            fs.writeFile(sketchPath, code, (err) => {
                                if (err) {
                                    console.error('Error writing sketch file:', err);
                                    showNotification(browserWindow, t.uploadCode.notifications.file);
                                    return;
                                }
                                showNotification(browserWindow, t.compileCode.notifications.progress);
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
            label: t.microbit.label,
            submenu: [
                {
                    label: t.microbit.listBoards || t.listPorts.label || 'Lister les cartes disponibles',
                    id: 'microbit-drives-menu',
                    submenu: previousMicrobitDrives.length > 0 
                        ? previousMicrobitDrives.map(drive => ({
                            label: `${drive.drive} - ${drive.volName}`,
                            type: 'radio',
                            checked: selectedMicrobitDrive === drive.drive,
                            click: () => {
                                selectedMicrobitDrive = drive.drive;
                                const mainWindow = BrowserWindow.getAllWindows()[0];
                                if (mainWindow) {
                                    showNotification(mainWindow, (t.microbit.notifications.found || 'Carte micro:bit trouvée').replace('{drive}', drive.drive));
                                }
                            }
                        }))
                        : [{
                            label: t.microbit.notifications.notFound || 'Aucune carte détectée',
                            enabled: false
                        }]
                },
                {
                    label: t.microbit.upload || 'Téléverser le programme',
                    click: async (menuItem, browserWindow) => {
                        if (!selectedMicrobitDrive) {
                            showNotification(browserWindow, t.microbit.notifications.noDrive || 'Aucune carte micro:bit sélectionnée');
                            return;
                        }
                        
                        // Récupérer le code depuis la div de l'éditeur
                        browserWindow.webContents.executeJavaScript(`
                          (() => {
                            // Try multiple selectors for CodeMirror editor
                            let editorElement = document.querySelector('.CodeMirror-code');
                            if (!editorElement) {
                                editorElement = document.querySelector('.cm-editor .cm-content');
                            }
                            if (!editorElement) {
                                // Try to find any code editor
                                editorElement = document.querySelector('[class*="CodeMirror"]');
                            }
                            if (!editorElement) {
                                return 'empty';
                            }
                            
                            const clonedElement = editorElement.cloneNode(true);
                            const gutterWrappers = clonedElement.querySelectorAll('.CodeMirror-gutter-wrapper, .cm-gutter');
                            gutterWrappers.forEach(wrapper => wrapper.remove());
                            
                            // Try to get code from pre elements or line elements
                            let preElements = clonedElement.querySelectorAll('pre, .cm-line');
                            if (preElements.length === 0) {
                                // Fallback: get text directly
                                const text = clonedElement.textContent || clonedElement.innerText;
                                if (text && text.trim()) {
                                    return text;
                                }
                                return 'empty';
                            }
                            
                            const codeText = Array.from(preElements)
                              .map(pre => {
                                  let text = pre.textContent || pre.innerText || '';
                                  return text.normalize('NFKC');
                              })
                              .join('\\n')
                              .replace(/[\u2018\u2019\u201C\u201D]/g, '"')
                              .replace(/[\u2013\u2014]/g, '-')
                              .replace(/[\u200B-\u200D\uFEFF]/g, '') // Remove zero-width spaces
                              .replace(/[\u00A0]/g, ' '); // Replace non-breaking spaces
                            return codeText && codeText !== 'undefined' ? codeText : 'empty';
                          })()
                        `).then(code => {
                            if (code === 'empty') {
                                showNotification(browserWindow, t.copyCode.notifications.empty);
                                return;
                            }
                            
                            console.log('Code récupéré depuis l\'éditeur, length:', code.length);
                            
                            // Normaliser et nettoyer le code
                            let cleanedCode = code.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                            cleanedCode = cleanedCode.split('\n')
                                .map(line => line.replace(/\t/g, '    ').replace(/[ \t]+$/g, ''))
                                .join('\n');
                            cleanedCode = cleanedCode.replace(/\n{3,}/g, '\n\n').trim();
                            if (!cleanedCode.endsWith('\n')) {
                                cleanedCode += '\n';
                            }
                            
                            showNotification(browserWindow, t.microbit.notifications.uploadProgress || 'Compilation en cours...');
                            
                            // Convertir le code MakeCode en MicroPython si nécessaire AVANT compilation
                            let microPythonCode = cleanedCode;
                            if (cleanedCode.includes('basic.') || cleanedCode.includes('IconNames.') || cleanedCode.includes('basic.forever') || cleanedCode.includes('input.on_') || cleanedCode.includes('pins.analog_pitch')) {
                                console.log('Détection de code MakeCode, conversion en MicroPython...');
                                microPythonCode = convertMakeCodeToMicroPython(cleanedCode);
                                
                                // Afficher le code converti dans la console pour débogage
                                console.log('=== CODE CONVERTI (lignes numérotées) ===');
                                const lines = microPythonCode.split('\n');
                                lines.forEach((line, idx) => {
                                    console.log(`${(idx + 1).toString().padStart(3, ' ')}: ${line}`);
                                });
                                console.log('==========================================');
                            }
                            
                            // Compiler et copier sur la carte
                            const firmwareName = 'PROGRAM.HEX';
                            const finalPath = path.join(selectedMicrobitDrive, firmwareName);
                            
                            compilePythonToHex(microPythonCode).then(hexContent => {
                                console.log('Writing HEX file to micro:bit, content length:', hexContent.length);
                                
                                fs.writeFile(finalPath, hexContent, 'utf8', (err) => {
                                    if (err) {
                                        console.error('Error writing HEX file to micro:bit:', err && err.stack ? err.stack : err);
                                        showNotification(browserWindow, t.microbit.notifications.uploadError || 'Erreur lors de l\'écriture du fichier HEX');
                                        return;
                                    }
                                    
                                    console.log('HEX file written successfully to', finalPath);
                                    
                                    // Afficher une notification de progression
                                    showNotification(browserWindow, t.microbit.notifications.uploadProgressHexWritten || 'Fichier HEX écrit sur la carte.\nVérification du téléversement en cours...');
                                    
                                    // Vérifier le résultat du flash
                                    // Méthode : La micro:bit supprime automatiquement PROGRAM.HEX après un flash réussi
                                    // On surveille la disparition de PROGRAM.HEX (succès) ou l'apparition de FAIL.TXT (erreur)
                                    try {
                                        const st = fs.statSync(finalPath);
                                        const writtenAt = st.mtimeMs || Date.now();
                                        console.log('Fichier HEX écrit, démarrage de la vérification dans 1 seconde...');
                                        // Commencer la vérification après 1 seconde pour laisser le temps à la micro:bit de réagir
                                        setTimeout(() => {
                                            console.log('Démarrage de la vérification du téléversement...');
                                            checkMicrobitFlashResult(selectedMicrobitDrive, browserWindow, writtenAt);
                                        }, 1000);
                                    } catch (e) {
                                        console.error('Error statting PROGRAM.HEX after write:', e);
                                        // Commencer la vérification quand même après 1 seconde
                                        setTimeout(() => {
                                            console.log('Démarrage de la vérification du téléversement (sans timestamp)...');
                                            checkMicrobitFlashResult(selectedMicrobitDrive, browserWindow);
                                        }, 1000);
                                    }
                                });
                            }).catch(err => {
                                console.error('Error compiling Python to HEX:', err && err.stack ? err.stack : err);
                                const errorMsg = (err && err.message) ? err.message : (err && err.toString) ? err.toString() : 'Erreur inconnue';
                                showNotification(browserWindow, (t.microbit.notifications.uploadError || 'Erreur de compilation') + '\n' + errorMsg);
                            });
                        }).catch(error => {
                            console.error('Error extracting code from editor:', error);
                            showNotification(browserWindow, t.copyCode.notifications.error);
                        });
                    }
                },
                { type: 'separator' },
                {
                    label: t.microbit.showConverted || 'Afficher le code converti',
                    click: async (menuItem, browserWindow) => {
                        try {
                            // Récupérer le code depuis la div de l'éditeur (même méthode que pour Arduino)
                            const code = await browserWindow.webContents.executeJavaScript(`
                                (() => {
                                    const editorElement = document.querySelector('.CodeMirror-code');
                                    if (!editorElement) 
                                        return 'empty';
                                    const clonedElement = editorElement.cloneNode(true);
                                    const gutterWrappers = clonedElement.querySelectorAll('.CodeMirror-gutter-wrapper');
                                    gutterWrappers.forEach(wrapper => wrapper.remove());
                                    const preElements = clonedElement.querySelectorAll('pre');
                                    const codeText = Array.from(preElements)
                                      .map(pre => pre.textContent.normalize())
                                      .join('\\r\\n')
                                      .replace(/[\u2018\u2019\u201C\u201D]/g, '"')
                                      .replace(/[\u2013\u2014]/g, '-')
                                      .replace(/[\u200B]/g, '');
                                    return codeText && codeText !== 'undefined' ? codeText : 'empty';
                                })();
                            `);
                            
                            if (!code || code === 'empty' || !code.trim()) {
                                showNotification(browserWindow, t.microbit.convertedCode.noCodeFound || 'Aucun code trouvé dans l\'éditeur');
                                return;
                            }
                            
                            // Nettoyer le code
                            let cleanedCode = code.trim();
                            cleanedCode = cleanedCode.split('\n')
                                .map(line => line.replace(/\t/g, '    ').replace(/[ \t]+$/g, ''))
                                .join('\n');
                            cleanedCode = cleanedCode.replace(/\n{3,}/g, '\n\n').trim();
                            
                            // Convertir le code MakeCode en MicroPython si nécessaire
                            let microPythonCode = cleanedCode;
                            const originalCode = cleanedCode;
                            if (cleanedCode.includes('basic.') || cleanedCode.includes('IconNames.') || cleanedCode.includes('basic.forever') || cleanedCode.includes('input.on_') || cleanedCode.includes('pins.analog_pitch')) {
                                microPythonCode = convertMakeCodeToMicroPython(cleanedCode);
                                
                                // Valider la syntaxe
                                const errors = validatePythonSyntax(microPythonCode);
                                if (errors.length > 0) {
                                    const errorLines = errors.map(e => 
                                        (t.microbit.convertedCode.errorLine || 'Ligne {line}: {message}')
                                            .replace('{line}', e.line)
                                            .replace('{message}', e.message)
                                    ).join('\\n');
                                    const errorMsg = (t.microbit.convertedCode.validationErrors || 'Erreurs détectées dans le code converti:\\n\\n{errors}')
                                        .replace('{errors}', errorLines);
                                    showNotification(browserWindow, errorMsg);
                                }
                            } else if (!microPythonCode.includes('from microbit import')) {
                                microPythonCode = 'from microbit import *\\n\\n' + microPythonCode;
                            }
                            
                            // Afficher la fenêtre avec le code converti
                            showConvertedCodeWindow(microPythonCode, originalCode);
                        } catch (error) {
                            console.error('Error showing converted code:', error);
                            const errorMsg = (t.microbit.convertedCode.errorRetrieving || 'Erreur lors de la récupération du code: {error}')
                                .replace('{error}', error.message || error);
                            showNotification(browserWindow, errorMsg);
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: t.microbit.install || 'Installer MicroPython hors-ligne',
                    click: (menuItem, browserWindow) => {
                        installMicroPythonRuntimes(browserWindow);
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
                            message: 'Tinkercad QHL',
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
    const newMenu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(newMenu);
}
