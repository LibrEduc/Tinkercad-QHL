/**
 * Notifications dans la fenêtre (injection CSS + message)
 */
const { CONSTANTS } = require('./constants');

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

module.exports = { showNotification };
