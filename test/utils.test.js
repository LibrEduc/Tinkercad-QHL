/**
 * Tests for lib/utils.js (no Electron dependency)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { safeUnlink, safeClose } from '../lib/utils.js';

describe('safeUnlink', () => {
    it('does not throw if the file does not exist', () => {
        assert.doesNotThrow(() => safeUnlink(path.join(os.tmpdir(), 'nonexistent-' + Date.now())));
    });

    it('removes an existing file', () => {
        const p = path.join(os.tmpdir(), 'tinkercad-test-' + Date.now());
        fs.writeFileSync(p, '');
        assert.strictEqual(fs.existsSync(p), true);
        safeUnlink(p);
        assert.strictEqual(fs.existsSync(p), false);
    });
});

describe('safeClose', () => {
    it('does not throw if stream is null', () => {
        assert.doesNotThrow(() => safeClose(null));
    });

    it('does not throw if stream has no close', () => {
        assert.doesNotThrow(() => safeClose({}));
    });

    it('calls close when present', () => {
        let closed = false;
        safeClose({ close: () => { closed = true; } });
        assert.strictEqual(closed, true);
    });
});
