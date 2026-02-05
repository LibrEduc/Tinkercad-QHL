/**
 * Définit le mode debug pour le build (écriture des logs dans data/debug.log).
 * Usage: node scripts/set-debug-mode.js true|false
 */
const fs = require('fs');
const path = require('path');
const value = process.argv[2] === 'true';
const file = path.join(__dirname, '..', 'debug-mode.js');
fs.writeFileSync(file, `/** Activer uniquement via npm run start:debug ou build:win:debug */\nmodule.exports = ${value};\n`);
console.log(`debug-mode.js set to ${value}`);
