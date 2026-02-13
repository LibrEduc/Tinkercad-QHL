/**
 * Conversion MakeCode Python → MicroPython standard
 * (basic.*, input.*, pins.*, music.*, radio.*, gestionnaires d'événements)
 */
const { REGEX_MAKECODE, PWM_DUTY_CYCLE, MAKECODE_PATTERNS } = require('./constants');

function normalizeCodeIndentation(code) {
    const lines = code.split('\n');
    return lines.map(line => line.replace(/\t/g, '    ')).join('\n');
}

function addMicrobitImports(code) {
    let converted = code;
    if (!converted.includes('from microbit import')) {
        converted = 'from microbit import *\n\n' + converted;
    }
    const needsStruct = converted.includes('radio.send_value') || converted.includes('radio.receive_value');
    const needsMusic = converted.includes('music.') && !converted.includes('import music');
    const needsRadio = converted.includes('radio.') && !converted.includes('import radio');
    if (needsStruct && !converted.includes('import struct')) {
        converted = converted.replace(REGEX_MAKECODE.importMicrobit, '$1\nimport struct');
    }
    if (needsMusic && !converted.includes('import music')) {
        converted = converted.replace(REGEX_MAKECODE.importMicrobit, '$1\nimport music');
    }
    if (needsRadio && !converted.includes('import radio')) {
        converted = converted.replace(REGEX_MAKECODE.importMicrobit, '$1\nimport radio');
    }
    return converted;
}

function convertBasicFunctions(code, iconMap) {
    let converted = code;
    converted = converted.replace(REGEX_MAKECODE.showIcon, (match, iconName) => {
        const microPythonIcon = iconMap[iconName] || iconName.toUpperCase();
        return `display.show(Image.${microPythonIcon})`;
    });
    converted = converted.replace(REGEX_MAKECODE.clearScreen, 'display.clear()');
    converted = converted.replace(REGEX_MAKECODE.showString, 'display.scroll($1)');
    converted = converted.replace(REGEX_MAKECODE.showNumber, 'display.scroll(str($1))');
    converted = converted.replace(REGEX_MAKECODE.show, 'display.show(');
    converted = converted.replace(REGEX_MAKECODE.clear, 'display.clear(');
    converted = converted.replace(REGEX_MAKECODE.pause, 'sleep(');
    return converted;
}

function convertInputFunctions(code) {
    let converted = code;
    converted = converted.replace(REGEX_MAKECODE.buttonIsPressed, (match, button) => {
        const buttonName = button.toLowerCase() === 'a' ? 'button_a' : 'button_b';
        return `${buttonName}.is_pressed()`;
    });
    converted = converted.replace(REGEX_MAKECODE.acceleration, (match, dim) => {
        return `accelerometer.get_${dim.toLowerCase()}()`;
    });
    converted = converted.replace(REGEX_MAKECODE.compassHeading, 'compass.heading()');
    converted = converted.replace(REGEX_MAKECODE.calibrateCompass, 'compass.calibrate()');
    converted = converted.replace(REGEX_MAKECODE.temperature, 'temperature()');
    return converted;
}

function convertPinFunctions(code) {
    let converted = code;
    converted = converted.replace(REGEX_MAKECODE.digitalWritePin, (match, pin, value) => {
        return `pin${pin}.write_digital(${value})`;
    });
    converted = converted.replace(REGEX_MAKECODE.digitalReadPin, (match, pin) => {
        return `pin${pin}.read_digital()`;
    });
    converted = converted.replace(REGEX_MAKECODE.analogWritePin, (match, pin, value) => {
        return `pin${pin}.write_analog(${value})`;
    });
    converted = converted.replace(REGEX_MAKECODE.analogReadPin, (match, pin) => {
        return `pin${pin}.read_analog()`;
    });
    return converted;
}

function convertMusicAndRadioFunctions(code) {
    let converted = code;
    converted = converted.replace(REGEX_MAKECODE.playTone, 'music.pitch($1, $2)');
    converted = converted.replace(REGEX_MAKECODE.stopAllSounds, 'music.stop()');
    converted = converted.replace(REGEX_MAKECODE.sendString, 'radio.send($1)');
    converted = converted.replace(REGEX_MAKECODE.receiveString, 'radio.receive()');
    converted = converted.replace(REGEX_MAKECODE.sendValue, 'radio.send(struct.pack("<b", $1))');
    converted = converted.replace(REGEX_MAKECODE.receiveValue, '(lambda v: struct.unpack("<b", v)[0] if v else None)(radio.receive())');
    converted = converted.replace(REGEX_MAKECODE.setGroup, 'radio.config(group=$1)');
    return converted;
}

function convertAnalogPitch(code) {
    if (!REGEX_MAKECODE.analogPitch.test(code)) {
        return code;
    }
    const codeLines = code.split('\n');
    const analogPitchLines = [];
    for (let i = 0; i < codeLines.length; i++) {
        const line = codeLines[i];
        const indentMatch = line.match(/^(\s*)/);
        const indent = indentMatch ? indentMatch[1] : '';
        const analogPitchMatch = line.match(REGEX_MAKECODE.analogPitch);
        if (analogPitchMatch) {
            const pin = analogPitchMatch[1];
            const freq = analogPitchMatch[2];
            const isPinNumber = /^\d+$/.test(pin);
            const pinExpr = isPinNumber ? `pin${pin}` : pin;
            const periodExpr = `int(1000000 / ${freq})`;
            analogPitchLines.push(`${indent}${pinExpr}.set_analog_period_microseconds(${periodExpr})`);
            analogPitchLines.push(`${indent}${pinExpr}.write_analog(${PWM_DUTY_CYCLE})`);
        } else {
            analogPitchLines.push(line);
        }
    }
    return analogPitchLines.join('\n');
}

function collectEventHandlers(code) {
    const buttonHandlers = [];
    const gestureHandlers = [];
    const logoTouchHandlers = [];
    let foreverFuncName = null;
    const foreverMatch = code.match(REGEX_MAKECODE.forever);
    if (foreverMatch) {
        foreverFuncName = foreverMatch[1];
        code = code.replace(REGEX_MAKECODE.forever, '');
    }
    code = code.replace(REGEX_MAKECODE.buttonPressed, (match, button, funcName) => {
        const buttonName = button.toLowerCase() === 'a' ? 'button_a' : 'button_b';
        buttonHandlers.push({ button: buttonName, func: funcName });
        return '';
    });
    code = code.replace(REGEX_MAKECODE.onGesture, (match, gesture, funcName) => {
        gestureHandlers.push({ gesture: gesture.toLowerCase(), func: funcName });
        return '';
    });
    code = code.replace(REGEX_MAKECODE.onLogoEvent, (match, event, funcName) => {
        logoTouchHandlers.push({ func: funcName });
        return '';
    });
    gestureHandlers.forEach(h => buttonHandlers.push({ button: 'accelerometer', gesture: h.gesture, func: h.func }));
    logoTouchHandlers.forEach(h => buttonHandlers.push({ button: 'pin_logo', func: h.func }));
    return { code, buttonHandlers, foreverFuncName };
}

function integrateEventHandlers(code, buttonHandlers, foreverFuncName) {
    if (buttonHandlers.length === 0 && !foreverFuncName) {
        return code;
    }
    const lines = code.split('\n');
    const newLines = [];
    let foundMainLoop = false;
    let mainLoopIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('while True:') && !foundMainLoop) {
            foundMainLoop = true;
            mainLoopIndex = i;
            break;
        }
    }
    if (buttonHandlers.length > 0) {
        for (let i = 0; i < lines.length; i++) {
            newLines.push(lines[i]);
            if (i === mainLoopIndex && foundMainLoop) {
                const nextLine = lines[i + 1] || '';
                const indentMatch = nextLine.match(/^(\s*)/);
                const indent = indentMatch && indentMatch[1] ? indentMatch[1] : '    ';
                buttonHandlers.forEach(handler => {
                    if (handler.gesture) {
                        newLines.push(`${indent}if accelerometer.was_gesture("${handler.gesture}"):`);
                        newLines.push(`${indent}    ${handler.func}()`);
                    } else if (handler.button === 'pin_logo') {
                        newLines.push(`${indent}if pin_logo.is_touched():`);
                        newLines.push(`${indent}    ${handler.func}()`);
                    } else {
                        newLines.push(`${indent}if ${handler.button}.was_pressed():`);
                        newLines.push(`${indent}    ${handler.func}()`);
                    }
                });
                if (foreverFuncName && code.includes(`def ${foreverFuncName}`)) {
                    newLines.push(`${indent}${foreverFuncName}()`);
                }
            }
        }
        if (!foundMainLoop) {
            newLines.push('');
            newLines.push('while True:');
            buttonHandlers.forEach(handler => {
                if (handler.gesture) {
                    newLines.push(`    if accelerometer.was_gesture("${handler.gesture}"):`);
                    newLines.push(`        ${handler.func}()`);
                } else if (handler.button === 'pin_logo') {
                    newLines.push(`    if pin_logo.is_touched():`);
                    newLines.push(`        ${handler.func}()`);
                } else {
                    newLines.push(`    if ${handler.button}.was_pressed():`);
                    newLines.push(`        ${handler.func}()`);
                }
            });
            const foreverToCall = foreverFuncName || 'on_forever';
            if (code.includes(`def ${foreverToCall}`)) {
                newLines.push(`    ${foreverToCall}()`);
            }
            newLines.push('    sleep(10)');
        }
        code = newLines.join('\n');
    } else if (foreverFuncName && !code.includes('while True:')) {
        const foreverLines = code.split('\n');
        const foreverNewLines = [];
        let defIndent = 0;
        let insertAfterIndex = -1;
        for (let i = 0; i < foreverLines.length; i++) {
            const line = foreverLines[i];
            const defMatch = line.match(new RegExp(`^(\\s*)def\\s+${foreverFuncName}\\s*\\(`));
            if (defMatch) {
                defIndent = defMatch[1].length;
                insertAfterIndex = i;
                for (let j = i + 1; j < foreverLines.length; j++) {
                    const next = foreverLines[j];
                    if (next.trim() === '') {
                        insertAfterIndex = j;
                        continue;
                    }
                    const nextIndent = (next.match(/^(\s*)/) || [])[1].length;
                    if (nextIndent <= defIndent) break;
                    insertAfterIndex = j;
                }
                break;
            }
        }
        for (let i = 0; i < foreverLines.length; i++) {
            foreverNewLines.push(foreverLines[i]);
            if (i === insertAfterIndex) {
                foreverNewLines.push('');
                foreverNewLines.push('while True:');
                foreverNewLines.push(`    ${foreverFuncName}()`);
                foreverNewLines.push('    sleep(10)');
            }
        }
        code = foreverNewLines.join('\n');
    }
    return code;
}

const ICON_MAP = {
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
    'EighthNote': 'EIGHTH_NOTE',
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

/**
 * Détecte si le code est du MakeCode Python (vs MicroPython standard).
 * @param {string} code
 * @returns {boolean}
 */
function isMakeCodePython(code) {
    return MAKECODE_PATTERNS.some(pattern => code.includes(pattern));
}

/**
 * Convertit le code MakeCode Python en MicroPython standard.
 * @param {string} code - Code MakeCode Python
 * @returns {string} Code MicroPython
 */
function convertMakeCodeToMicroPython(code) {
    let converted = code.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    converted = normalizeCodeIndentation(converted);
    converted = addMicrobitImports(converted);
    converted = convertBasicFunctions(converted, ICON_MAP);
    converted = convertInputFunctions(converted);
    converted = convertPinFunctions(converted);
    converted = convertMusicAndRadioFunctions(converted);
    converted = convertAnalogPitch(converted);
    const { code: codeAfterHandlers, buttonHandlers, foreverFuncName } = collectEventHandlers(converted);
    converted = codeAfterHandlers;
    converted = converted.replace(/\n{3,}/g, '\n\n');
    converted = integrateEventHandlers(converted, buttonHandlers, foreverFuncName);
    if (!converted.endsWith('\n')) {
        converted += '\n';
    }
    return converted;
}

module.exports = {
    isMakeCodePython,
    convertMakeCodeToMicroPython,
    normalizeCodeIndentation,
    addMicrobitImports,
    convertBasicFunctions,
    convertInputFunctions,
    convertPinFunctions,
    convertMusicAndRadioFunctions,
    convertAnalogPitch,
    collectEventHandlers,
    integrateEventHandlers,
    ICON_MAP
};
