/**
 * Utilitaires partagés (fichiers, flux)
 */
const fs = require('fs');

/**
 * Supprime un fichier de façon silencieuse (ignore les erreurs).
 * @param {string} p - Chemin du fichier
 */
function safeUnlink(p) {
    try {
        fs.unlinkSync(p);
    } catch (_) {}
}

/**
 * Ferme un flux de façon silencieuse (ignore les erreurs).
 * @param {NodeJS.WritableStream|{ close?: () => void }|null} stream
 */
function safeClose(stream) {
    try {
        if (stream && typeof stream.close === 'function') {
            stream.close();
        }
    } catch (_) {}
}

module.exports = {
    safeUnlink,
    safeClose
};
