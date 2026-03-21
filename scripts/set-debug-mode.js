/**
 * @file scripts/set-debug-mode.js
 * @description Sets debug mode by writing debug-mode.js at the project root (true or false).
 * Used by npm run start:debug and build:win:debug to enable file logging and DevTools opening.
 * Usage: node scripts/set-debug-mode.js true | node scripts/set-debug-mode.js false
 * @module scripts/set-debug-mode
 * @author Sébastien Canet
 * @license CC0-1.0
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const value = process.argv[2] === 'true';
const file = path.join(__dirname, '..', 'debug-mode.js');
fs.writeFileSync(file, `/** Enable only via npm run start:debug or build:win:debug */\nexport default ${value};\n`);
console.log(`debug-mode.js set to ${value}`);
