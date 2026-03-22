/**
 * @file debug-mode.ts
 * @description Drapeau de mode debug importé par `lib/logger.ts`. Quand il vaut `true` (ou `TINKERCAD_DEBUG=1`),
 * les logs vont aussi dans `data/debug.log` et les DevTools peuvent s’ouvrir au démarrage.
 * @remarks Ne pas modifier à la main en production : le script `scripts/set-debug-mode.js` (voir `npm run build:win:debug`)
 * bascule cette valeur pour les builds de débogage.
 * @module debug-mode
 * @author scanet\@libreduc.cc (Sébastien Canet)
 * @license GPL-3.0
 */
export default false;
