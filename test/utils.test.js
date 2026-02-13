/**
 * Tests pour lib/utils.js (sans dépendance Electron)
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { safeUnlink, safeClose } = require('../lib/utils');

describe('safeUnlink', () => {
    it('ne leve pas exception si le fichier nexiste pas', () => {
        assert.doesNotThrow(() => safeUnlink(path.join(os.tmpdir(), 'nonexistent-' + Date.now())));
    });

    it('supprime un fichier existant', () => {
        const p = path.join(os.tmpdir(), 'tinkercad-test-' + Date.now());
        fs.writeFileSync(p, '');
        assert.strictEqual(fs.existsSync(p), true);
        safeUnlink(p);
        assert.strictEqual(fs.existsSync(p), false);
    });
});

describe('safeClose', () => {
    it('ne leve pas exception si stream est null', () => {
        assert.doesNotThrow(() => safeClose(null));
    });

    it('ne leve pas exception si stream na pas de close', () => {
        assert.doesNotThrow(() => safeClose({}));
    });

    it('appelle close si present', () => {
        let closed = false;
        safeClose({ close: () => { closed = true; } });
        assert.strictEqual(closed, true);
    });
});
