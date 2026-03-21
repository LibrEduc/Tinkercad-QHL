/**
 * Tests for lib/pythonUtils.js (Python cleaning and validation)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { cleanPythonCode as clean, validatePythonSyntax as validate } from '../lib/pythonUtils.js';

describe('cleanPythonCode', () => {
    it('returns empty string for null or non-string', () => {
        assert.strictEqual(clean(null), '');
        assert.strictEqual(clean(undefined), '');
        assert.strictEqual(clean(42), '');
    });

    it('normalizes line endings', () => {
        assert.strictEqual(clean('a\r\nb\rc').includes('\r'), false);
        assert.ok(clean('a\r\nb').includes('a\nb') || clean('a\r\nb') === 'a\nb\n');
    });

    it('replaces tabs with 4 spaces', () => {
        // trim() removes leading spaces from top-level code, so we check an indented line
        const out = clean('def x():\n\treturn 1');
        assert.ok(out.includes('    return'));
    });

    it('reduces multiple blank lines', () => {
        const out = clean('a\n\n\n\nb');
        assert.ok(out.includes('a\n\nb') || out === 'a\n\nb\n');
    });

    it('adds final newline if missing', () => {
        assert.ok(clean('x').endsWith('\n'));
        assert.strictEqual(clean('').endsWith('\n'), false);
    });
});

describe('validatePythonSyntax', () => {
    it('returns errors for unbalanced parentheses', () => {
        const errs = validate('def f():\n    print(1');
        assert.ok(errs.length > 0);
        assert.ok(errs.some(e => e.message.includes('parenthes')));
    });

    it('returns an error for missing import music', () => {
        const errs = validate('music.pitch(440, 100)');
        assert.ok(errs.length > 0);
        assert.ok(errs.some(e => e.message.includes('music')));
    });

    it('returns an error for missing import radio', () => {
        const errs = validate('radio.send("x")');
        assert.ok(errs.length > 0);
        assert.ok(errs.some(e => e.message.includes('radio')));
    });

    it('returns empty array for simple valid code', () => {
        const errs = validate('from microbit import *\n\ndisplay.show(Image.HEART)\n');
        assert.strictEqual(errs.length, 0);
    });
});
