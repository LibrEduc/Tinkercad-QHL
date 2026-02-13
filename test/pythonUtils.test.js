/**
 * Tests pour lib/pythonUtils.js (nettoyage et validation Python)
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { cleanPythonCode: clean, validatePythonSyntax: validate } = require('../lib/pythonUtils');

describe('cleanPythonCode', () => {
    it('retourne une chaîne vide pour null ou non-string', () => {
        assert.strictEqual(clean(null), '');
        assert.strictEqual(clean(undefined), '');
        assert.strictEqual(clean(42), '');
    });

    it('normalise les fins de ligne', () => {
        assert.strictEqual(clean('a\r\nb\rc').includes('\r'), false);
        assert.ok(clean('a\r\nb').includes('a\nb') || clean('a\r\nb') === 'a\nb\n');
    });

    it('remplace les tabs par 4 espaces', () => {
        // trim() enlève les espaces en tête du code global, donc on vérifie une ligne indentée
        const out = clean('def x():\n\treturn 1');
        assert.ok(out.includes('    return'));
    });

    it('réduit les lignes vides multiples', () => {
        const out = clean('a\n\n\n\nb');
        assert.ok(out.includes('a\n\nb') || out === 'a\n\nb\n');
    });

    it('ajoute un saut de ligne final si absent', () => {
        assert.ok(clean('x').endsWith('\n'));
        assert.strictEqual(clean('').endsWith('\n'), false);
    });
});

describe('validatePythonSyntax', () => {
    it('retourne des erreurs pour parenthèses non équilibrées', () => {
        const errs = validate('def f():\n    print(1');
        assert.ok(errs.length > 0);
        assert.ok(errs.some(e => e.message.includes('Parenthèse') || e.message.includes('parenthes')));
    });

    it('retourne une erreur pour import music manquant', () => {
        const errs = validate('music.pitch(440, 100)');
        assert.ok(errs.length > 0);
        assert.ok(errs.some(e => e.message.includes('music')));
    });

    it('retourne une erreur pour import radio manquant', () => {
        const errs = validate('radio.send("x")');
        assert.ok(errs.length > 0);
        assert.ok(errs.some(e => e.message.includes('radio')));
    });

    it('retourne un tableau vide pour code valide simple', () => {
        const errs = validate('from microbit import *\n\ndisplay.show(Image.HEART)\n');
        assert.strictEqual(errs.length, 0);
    });
});
