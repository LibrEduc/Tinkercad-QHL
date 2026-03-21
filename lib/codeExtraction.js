/**
 * @file codeExtraction.js
 * @description Code extraction from the Tinkercad editor (webview / CodeMirror). Builds a script
 * injected into the page to read editor content (CodeMirror / cm-editor selectors), normalizes
 * Unicode. Exposes CODE_EXTRACTION_SCRIPT, executeScriptInWebview, extractCodeFromEditor, normalizeUnicode.
 * @module lib/codeExtraction
 * @author Sébastien Canet
 * @license CC0-1.0
 */

import { webContents } from 'electron';
import { CONSTANTS } from './constants.js';
import { logger } from './logger.js';

/**
 * Builds the IIFE script injected into the webview to extract editor text.
 * @param {string} emptyCode - Fallback value if no editor found (e.g. CONSTANTS.EMPTY_CODE)
 * @returns {string} JavaScript code to execute in the page
 */
function buildCodeExtractionScript(emptyCode) {
    return `
    (() => {
        let editorElement = document.querySelector('.CodeMirror-code');
        if (!editorElement) editorElement = document.querySelector('.CodeMirror-lines');
        if (!editorElement) editorElement = document.querySelector('.cm-editor .cm-content');
        if (!editorElement) editorElement = document.querySelector('[class*="CodeMirror"]');
        if (!editorElement) {
            const codeContainers = document.querySelectorAll('[class*="code"], [class*="editor"], [class*="program"], pre, code');
            for (const container of codeContainers) {
                const text = container.textContent || container.innerText;
                if (text && text.trim().length > 10 &&
                    (text.includes('def ') || text.includes('import ') || text.includes('basic.') || text.includes('input.'))) {
                    editorElement = container;
                    break;
                }
            }
        }
        if (!editorElement) return '${emptyCode}';
        const clonedElement = editorElement.cloneNode(true);
        clonedElement.querySelectorAll('.CodeMirror-gutter-wrapper, .cm-gutter, [class*="gutter"]').forEach(w => w.remove());
        let codeText = '';
        const preElements = clonedElement.querySelectorAll('pre');
        if (preElements.length > 0) {
            codeText = Array.from(preElements).map(pre => pre.textContent || pre.innerText || '').join('\\r\\n');
        } else {
            codeText = clonedElement.textContent || clonedElement.innerText || '';
        }
        if (codeText) {
            codeText = codeText
                .replace(/[\\u2018\\u2019\\u201C\\u201D]/g, '"')
                .replace(/[\\u2013\\u2014]/g, '-')
                .replace(/[\\u200B]/g, '')
                .trim();
        }
        return codeText && codeText !== 'undefined' && codeText.length > 0 ? codeText : '${emptyCode}';
    })()
`;
}

const CODE_EXTRACTION_SCRIPT = buildCodeExtractionScript(CONSTANTS.EMPTY_CODE);

/**
 * Normalizes Unicode characters (smart quotes, dashes, non-breaking spaces, zero-width characters).
 * @param {string} text - Source text
 * @param {Object} [options] - useNFKC, removeZeroWidth (default true)
 * @returns {string} Normalized text
 */
function normalizeUnicode(text, options = {}) {
    let normalized = text;
    if (options.useNFKC !== false) normalized = normalized.normalize('NFKC');
    normalized = normalized.replace(/[\u2018\u2019\u201C\u201D]/g, '"');
    normalized = normalized.replace(/[\u2013\u2014]/g, '-');
    if (options.removeZeroWidth !== false) normalized = normalized.replace(/[\u200B-\u200D\uFEFF]/g, '');
    normalized = normalized.replace(/[\u00A0]/g, ' ');
    return normalized;
}

/**
 * Executes a script in a webContents whose URL contains tinkercad.com, or otherwise in browserWindow.
 * Waits for document.readyState === 'complete' before executing on the Tinkercad page.
 * @param {Electron.BrowserWindow} browserWindow - Host window
 * @param {string} script - JavaScript code to evaluate
 * @returns {Promise<*>} Evaluation result (or CONSTANTS.EMPTY_CODE on error)
 */
async function executeScriptInWebview(browserWindow, script) {
    try {
        const allWebContents = webContents.getAllWebContents();
        for (const wc of allWebContents) {
            try {
                const url = wc.getURL();
                if (url && url.includes('tinkercad.com')) {
                    await wc.executeJavaScript(`
                        new Promise((resolve) => {
                            if (document.readyState === 'complete') resolve();
                            else {
                                window.addEventListener('load', () => resolve(), { once: true });
                                setTimeout(() => resolve(), 1000);
                            }
                        })
                    `);
                    const result = await wc.executeJavaScript(script);
                    if (result && result !== CONSTANTS.EMPTY_CODE) return result;
                }
            } catch (e) {}
        }
        return await browserWindow.webContents.executeJavaScript(script);
    } catch (e) {
        logger.error('Error executing script:', e.message);
        return CONSTANTS.EMPTY_CODE;
    }
}

/**
 * Extracts code from the Tinkercad editor (webview), with optional Unicode normalization.
 * @param {Electron.BrowserWindow} browserWindow - Window containing the Tinkercad webview
 * @param {Object} [options] - useAdvancedSelectors, normalizeUnicode (default true)
 * @returns {Promise<string>} Extracted code or CONSTANTS.EMPTY_CODE
 */
async function extractCodeFromEditor(browserWindow, options = {}) {
    const { useAdvancedSelectors = true, normalizeUnicode: shouldNormalize = true } = options;
    try {
        const code = await executeScriptInWebview(browserWindow, CODE_EXTRACTION_SCRIPT);
        if (!code || code === CONSTANTS.EMPTY_CODE) return CONSTANTS.EMPTY_CODE;
        if (shouldNormalize) return normalizeUnicode(code, { useNFKC: useAdvancedSelectors });
        return code;
    } catch (error) {
        logger.error('Error extracting code from editor:', error);
        return CONSTANTS.EMPTY_CODE;
    }
}

export {
    CODE_EXTRACTION_SCRIPT,
    normalizeUnicode,
    executeScriptInWebview,
    extractCodeFromEditor
};
