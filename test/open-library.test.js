import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePublishDate, openLibraryToVolume } from '../open-library.js';

test('publish dates are normalised', () => {
  assert.equal(normalizePublishDate('1988'), '1988');
  assert.equal(normalizePublishDate('2008-08'), '2008-08');
  assert.equal(normalizePublishDate('March 1, 1988'), '1988-03-01');
  assert.equal(normalizePublishDate('Mar 1999'), '1999');
  assert.equal(normalizePublishDate('circa 1750?'), '1750');
  assert.equal(normalizePublishDate('unknown'), '');
  assert.equal(normalizePublishDate(undefined), '');
});

test('sparse Open Library records convert safely and keep the searched ISBN', () => {
  const v = openLibraryToVolume({ title: 'Only a title' }, '0140328726');
  assert.equal(v.volumeInfo.title, 'Only a title');
  assert.deepEqual(v.volumeInfo.authors, []);
  assert.equal(v.volumeInfo.industryIdentifiers[0].identifier, '9780140328721');
  assert.equal(v.volumeInfo.pageCount, undefined);
  assert.equal(v.volumeInfo.imageLinks, undefined);
});
