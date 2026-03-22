/**
 * @file scripts/set-debug-mode.js
 * @description Sets debug mode by writing src/debug-mode.ts (true or false); run npm run compile after.
 * Used by npm run start:debug and build:win:debug to enable file logging and DevTools opening.
 * Usage: node scripts/set-debug-mode.js true | node scripts/set-debug-mode.js false
 * @module scripts/set-debug-mode
 * @author scanet\@libreduc.cc (Sébastien Canet)
 * @license GPL-3.0
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const value = process.argv[2] === 'true';
const file = path.join(__dirname, '..', 'src', 'debug-mode.ts');
fs.writeFileSync(file, `/** Enable only via npm run start:debug or build:win:debug */\nexport default ${value};\n`);
console.log(`src/debug-mode.ts set to ${value}`);
