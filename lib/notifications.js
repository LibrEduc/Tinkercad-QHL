/**
 * @file notifications.js
 * @description Notification display in the main window: injects a div with configurable
 * style and duration (CONSTANTS). Used by menu, Arduino CLI, micro:bit, etc.
 * @module lib/notifications
 * @author Sébastien Canet
 * @license CC0-1.0
 */

import { CONSTANTS } from './constants.js';

/**
 * Shows a message as a notification overlay in the window (CSS + div injection).
 * @param {Electron.BrowserWindow|null} browserWindow - Window in which to inject the notification
 * @param {string} message - Text to display (escaped for JavaScript)
 */
function showNotification(browserWindow, message) {
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
