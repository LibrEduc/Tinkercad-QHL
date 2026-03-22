/**
 * @file notifications.ts
 * @description Notifications toast dans la page Tinkercad : exécute du JS dans le webview pour injecter
 * un bandeau temporaire (durée et délai définis dans `CONSTANTS`).
 * @remarks Toute chaîne utilisateur doit rester raisonnable en longueur ; les retours ligne sont échappés pour le script injecté.
 * @module lib/notifications
 * @author scanet\@libreduc.cc (Sébastien Canet)
 * @license GPL-3.0
 */

import { CONSTANTS } from './constants.js';

import type { BrowserWindow } from 'electron';

/**
 * Affiche un message en overlay dans le contenu chargé (page Tinkercad).
 * @param browserWindow - Fenêtre cible (webview chargée)
 * @param message - Texte brut ; certains caractères sont échappés pour l’injection JS
 */
function showNotification(browserWindow: BrowserWindow | null, message: string): void {
    if (!browserWindow || !message) return;
    const escapedMessage = message.replace(/[\\"']/g, '\\$&').replace(/\n/g, '\\n');
    const delay = CONSTANTS.NOTIFICATION_DELAY;
    const duration = CONSTANTS.NOTIFICATION_DURATION;
    browserWindow.webContents.executeJavaScript(`
        (() => {
            try {
                const existing = document.querySelectorAll('[data-tinkercad-notification]');
                existing.forEach(n => { n.style.opacity = '0'; setTimeout(() => n.remove(), ${delay}); });
                const el = document.createElement('div');
                el.setAttribute('data-tinkercad-notification', 'true');
                el.className = 'tinkercad-notification';
                el.textContent = "${escapedMessage}";
                el.addEventListener('click', () => { el.style.opacity = '0'; setTimeout(() => el.remove(), ${delay}); });
                document.body.appendChild(el);
                el.offsetHeight;
                el.style.opacity = '1';
                setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), ${delay}); }, ${duration});
            } catch (e) { console.error(e); }
        })();
    `);
}

export { showNotification };
