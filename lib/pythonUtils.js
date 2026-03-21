/**
 * @file pythonUtils.js
 * @description Utilities for Python / MicroPython code: cleaning (line endings, tabs, blank lines),
 * syntax validation (parentheses, indentation, music/radio imports). Used by the "Show converted code" menu
 * and the micro:bit compile flow.
 * @module lib/pythonUtils
 * @author Sébastien Canet
 * @license CC0-1.0
 */

const DEFAULT_VALIDATION_MESSAGES = {
    indentationError: 'Indentation error: line expected after ":"',
    unbalancedParentheses: 'Unbalanced parentheses ({count})',
    unbalancedBrackets: 'Unbalanced brackets ({count})',
    unbalancedBraces: 'Unbalanced braces ({count})',
    missingImportMusic: 'Missing import: add "import music" or "from microbit import *"',
    missingImportRadio: 'Missing import: add "import radio" or "from microbit import *"',
    errorLine: 'Line {line}: {message}',
    validationErrors: 'Errors detected in converted code:\n\n{errors}'
};

/**
 * Cleans and normalizes Python code: line endings, indentation, trailing spaces,
 * multiple blank lines, final newline.
 * @param {string} code - Python code to clean
 * @returns {string} Cleaned code
 */
function cleanPythonCode(code) {
    if (code == null || typeof code !== 'string') return '';
    // Normalize line endings
    let cleaned = code.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // Normalize indentation (tabs → 4 spaces) and remove trailing spaces
    cleaned = cleaned.split('\n')
        .map(line => line.replace(/\t/g, '    ').replace(/[ \t]+$/g, ''))
        .join('\n');
    // Reduce multiple blank lines
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
    // Ensure code ends with a newline
    if (cleaned.length > 0 && !cleaned.endsWith('\n')) {
        cleaned += '\n';
    }
    return cleaned;
}

/**
 * Validates Python syntax (parentheses, indentation, imports).
 * @param {string} code - Python code to validate
 * @param {Object} [messages] - Error labels (otherwise default English messages)
 * @returns {Array<{line: number, message: string}>} Array of errors
 */
function validatePythonSyntax(code, messages = {}) {
    const msg = { ...DEFAULT_VALIDATION_MESSAGES, ...messages };
    const errors = [];
    const lines = code.split('\n');

    let parenCount = 0;
    let bracketCount = 0;
    let braceCount = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;

        for (const char of line) {
            if (char === '(') parenCount++;
            else if (char === ')') parenCount--;
            else if (char === '[') bracketCount++;
            else if (char === ']') bracketCount--;
            else if (char === '{') braceCount++;
            else if (char === '}') braceCount--;
        }

        if (i > 0) {
            const prevLine = lines[i - 1];
            const prevTrim = prevLine.trim();
            const currentTrim = line.trim();
            if (prevTrim.endsWith(':') && currentTrim && !currentTrim.startsWith('#')) {
                const prevIndent = (prevLine.match(/^(\s*)/) || [])[1].length;
                const currIndent = (line.match(/^(\s*)/) || [])[1].length;
                const sameLevelBlock = /^(elif|else|except|finally)\b/.test(currentTrim);
                if (currIndent <= prevIndent && !sameLevelBlock) {
                    errors.push({ line: lineNum, message: msg.indentationError });
                }
            }
        }
    }

    if (parenCount !== 0) {
        errors.push({
            line: lines.length,
            message: msg.unbalancedParentheses.replace('{count}', `${parenCount > 0 ? '+' : ''}${parenCount}`)
        });
    }
    if (bracketCount !== 0) {
        errors.push({
            line: lines.length,
            message: msg.unbalancedBrackets.replace('{count}', `${bracketCount > 0 ? '+' : ''}${bracketCount}`)
        });
    }
    if (braceCount !== 0) {
        errors.push({
            line: lines.length,
            message: msg.unbalancedBraces.replace('{count}', `${braceCount > 0 ? '+' : ''}${braceCount}`)
        });
    }

    const hasMusic = code.includes('music.') && !code.includes('import music') && !code.includes('from microbit import');
    const hasRadio = code.includes('radio.') && !code.includes('import radio') && !code.includes('from microbit import');
    if (hasMusic) {
        errors.push({ line: 1, message: msg.missingImportMusic });
    }
    if (hasRadio) {
        errors.push({ line: 1, message: msg.missingImportRadio });
    }

    return errors;
}

/**
 * Validates code and shows errors via a notification if a window is provided.
 * @param {string} code - Python code to validate
 * @param {Object|null} browserWindow - Window to show the notification in
 * @param {Object} [messages] - Labels (errorLine, validationErrors + validatePythonSyntax)
 * @param {function} [showNotificationFn] - (window, message) => void
 * @returns {Array<{line: number, message: string}>} Array of errors
 */
function validatePythonSyntaxWithDisplay(code, browserWindow, messages = {}, showNotificationFn) {
    const errors = validatePythonSyntax(code, messages);
    if (errors.length > 0 && browserWindow && typeof showNotificationFn === 'function') {
        const msg = { ...DEFAULT_VALIDATION_MESSAGES, ...messages };
        const errorLines = errors.map(e =>
            (msg.errorLine || 'Line {line}: {message}')
                .replace('{line}', e.line)
                .replace('{message}', e.message)
        ).join('\n');
        const errorMsg = (msg.validationErrors || 'Errors detected:\n\n{errors}').replace('{errors}', errorLines);
        showNotificationFn(browserWindow, errorMsg);
    }
    return errors;
}

export {
    cleanPythonCode,
    validatePythonSyntax,
    validatePythonSyntaxWithDisplay,
    DEFAULT_VALIDATION_MESSAGES
};
