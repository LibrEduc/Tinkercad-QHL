/**
 * @file utils.ts
 * @description Utilitaires transverses : suppression de fichier et fermeture de flux sans propager d’erreur
 * (téléchargements annulés, nettoyage d’archives temporaires).
 * @module lib/utils
 * @author scanet\@libreduc.cc (Sébastien Canet)
 * @license GPL-3.0
 */

import fs from 'fs';

/**
 * Supprime un fichier si possible ; ignore toute erreur (fichier absent, verrou, etc.).
 */
function safeUnlink(p: string): void {
    try {
        fs.unlinkSync(p);
    } catch (_) {}
}

/**
 * Closes a stream silently (ignores errors).
 * Accepte tout objet possédant une méthode `close` (flux Node, etc.).
 */
function safeClose(stream: { close?: () => void } | null | undefined): void {
    try {
        if (stream && typeof stream.close === 'function') {
            stream.close();
        }
    } catch (_) {}
}

export {
    safeUnlink,
    safeClose
};
