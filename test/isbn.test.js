import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidIsbn10, isValidIsbn13, canonicalIsbn, isbn10To13, isbn13To10, normalizeIsbn } from '../public/js/isbn.js';

test('ISBN-13 checksum', () => {
  assert.ok(isValidIsbn13('9780140328721'));
  assert.ok(isValidIsbn13('978-0-306-40615-7'));
  assert.ok(isValidIsbn13('9791090636071'));
  assert.ok(!isValidIsbn13('9780140328720'));
  assert.ok(!isValidIsbn13('1234567890123')); // wrong prefix
  assert.ok(!isValidIsbn13('978014032872'));
});

test('ISBN-10 checksum incl. X check digit', () => {
  assert.ok(isValidIsbn10('0140328726'));
  assert.ok(isValidIsbn10('080442957X'));
  assert.ok(isValidIsbn10('0-8044-2957-x'));
  assert.ok(!isValidIsbn10('0140328727'));
  assert.ok(!isValidIsbn10('X140328726'));
});

test('conversion and canonical form', () => {
  assert.equal(isbn10To13('0140328726'), '9780140328721');
  assert.equal(isbn13To10('9780140328721'), '0140328726');
  assert.equal(isbn13To10('9791090636071'), ''); // 979 has no ISBN-10
  assert.equal(isbn13To10(isbn10To13('080442957X')), '080442957X');
  assert.equal(canonicalIsbn('0-14-032872-6'), '9780140328721');
  assert.equal(canonicalIsbn('nonsense'), '');
  assert.equal(normalizeIsbn(' 978 0140-328721 '), '9780140328721');
  assert.equal(normalizeIsbn(null), '');
});
