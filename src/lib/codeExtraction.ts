/**
 * @file codeExtraction.ts
 * @description Extraction du code depuis l’éditeur Tinkercad (webview) : script injecté ciblant CodeMirror
 * ou sélecteurs équivalents, puis normalisation Unicode pour éviter les caractères « typographiques »
 * qui cassent Python/Arduino.
 * @remarks Si Tinkercad change son DOM, adapter les sélecteurs dans `buildCodeExtractionScript`.
 * @module lib/codeExtraction
 * @author scanet\@libreduc.cc (Sébastien Canet)
 * @license GPL-3.0
 */

import { webContents } from 'electron';
import { CONSTANTS } from './constants.js';
import { logger } from './logger.js';

/**
 * Construit le script IIFE exécuté dans la page pour lire le texte de l’éditeur.
 * @param emptyCode - Valeur renvoyée si aucun éditeur détecté (ex. `CONSTANTS.EMPTY_CODE`)
 */
function buildCodeExtractionScript(emptyCode: string): string {
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
 * Normalise les guillemets, tirets, espaces insécables et caractères de largeur nulle.
 * @param options - `useNFKC` et `removeZeroWidth` (défaut true)
 */
function normalizeUnicode(text: string, options: Record<string, unknown> = {}): string {
    let normalized = text;
    if (options.useNFKC !== false) normalized = normalized.normalize('NFKC');
    normalized = normalized.replace(/[\u2018\u2019\u201C\u201D]/g, '"');
    normalized = normalized.replace(/[\u2013\u2014]/g, '-');
    if (options.removeZeroWidth !== false) normalized = normalized.replace(/[\u200B-\u200D\uFEFF]/g, '');
    normalized = normalized.replace(/[\u00A0]/g, ' ');
    return normalized;
}

/**
 * Exécute du JS dans le webview Tinkercad (URL contenant `tinkercad.com`) si possible, sinon dans la fenêtre.
 * Attend le chargement complet avant évaluation sur la page Tinkercad.
 */
async function executeScriptInWebview(browserWindow: Electron.BrowserWindow, script: string): Promise<unknown> {
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
 * Récupère le code source affiché dans l’éditeur ; optionnellement applique `normalizeUnicode` (NFKC selon `useAdvancedSelectors`).
 */
async function extractCodeFromEditor(browserWindow: Electron.BrowserWindow, options: Record<string, unknown> = {}): Promise<string> {
    const { useAdvancedSelectors = true, normalizeUnicode: shouldNormalize = true } = options;
    try {
        const raw = await executeScriptInWebview(browserWindow, CODE_EXTRACTION_SCRIPT);
        const code = typeof raw === 'string' ? raw : '';
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
