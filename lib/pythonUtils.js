/**
 * Utilitaires pour le code Python / MicroPython (nettoyage, normalisation, validation)
 */

const DEFAULT_VALIDATION_MESSAGES = {
    indentationError: 'Erreur d\'indentation: ligne attendue après ":"',
    unbalancedParentheses: 'Parenthèses non équilibrées ({count})',
    unbalancedBrackets: 'Crochets non équilibrés ({count})',
    unbalancedBraces: 'Accolades non équilibrées ({count})',
    missingImportMusic: 'Import manquant: ajoutez "import music" ou "from microbit import *"',
    missingImportRadio: 'Import manquant: ajoutez "import radio" ou "from microbit import *"',
    errorLine: 'Ligne {line}: {message}',
    validationErrors: 'Erreurs détectées dans le code converti:\n\n{errors}'
};

/**
 * Nettoie et normalise le code Python : fins de ligne, indentation, espaces en fin de ligne,
 * lignes vides multiples, saut de ligne final.
 * @param {string} code - Le code Python à nettoyer
 * @returns {string} Le code nettoyé
 */
function cleanPythonCode(code) {
    if (code == null || typeof code !== 'string') return '';
    // Normaliser les fins de ligne
    let cleaned = code.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // Normaliser l'indentation (tabs → 4 espaces) et supprimer les espaces en fin de ligne
    cleaned = cleaned.split('\n')
        .map(line => line.replace(/\t/g, '    ').replace(/[ \t]+$/g, ''))
        .join('\n');
    // Réduire les lignes vides multiples
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
    // S'assurer que le code se termine par un saut de ligne
    if (cleaned.length > 0 && !cleaned.endsWith('\n')) {
        cleaned += '\n';
    }
    return cleaned;
}

/**
 * Valide la syntaxe Python (parenthèses, indentation, imports).
 * @param {string} code - Le code Python à valider
 * @param {Object} [messages] - Libellés d'erreur (sinon défauts en français)
 * @returns {Array<{line: number, message: string}>} Tableau d'erreurs
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
 * Valide le code et affiche les erreurs via une notification si une fenêtre est fournie.
 * @param {string} code - Le code Python à valider
 * @param {Object|null} browserWindow - Fenêtre pour afficher la notification
 * @param {Object} [messages] - Libellés (errorLine, validationErrors + validatePythonSyntax)
 * @param {function} [showNotificationFn] - (window, message) => void
 * @returns {Array<{line: number, message: string}>} Tableau d'erreurs
 */
function validatePythonSyntaxWithDisplay(code, browserWindow, messages = {}, showNotificationFn) {
    const errors = validatePythonSyntax(code, messages);
    if (errors.length > 0 && browserWindow && typeof showNotificationFn === 'function') {
        const msg = { ...DEFAULT_VALIDATION_MESSAGES, ...messages };
        const errorLines = errors.map(e =>
            (msg.errorLine || 'Ligne {line}: {message}')
                .replace('{line}', e.line)
                .replace('{message}', e.message)
        ).join('\n');
        const errorMsg = (msg.validationErrors || 'Erreurs détectées:\n\n{errors}').replace('{errors}', errorLines);
        showNotificationFn(browserWindow, errorMsg);
    }
    return errors;
}

module.exports = {
    cleanPythonCode,
    validatePythonSyntax,
    validatePythonSyntaxWithDisplay,
    DEFAULT_VALIDATION_MESSAGES
};
