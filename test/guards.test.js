import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAppUrl, isExternalWebUrl, isTrustedDownloadUrl, compareVersions } from '../electron/guards.js';

const ORIGIN = 'http://127.0.0.1:4321';

test('isAppUrl: exact origin only (a longer port or host that merely starts the same is not the app)', () => {
  assert.equal(isAppUrl(`${ORIGIN}/`, ORIGIN), true);
  assert.equal(isAppUrl(`${ORIGIN}/api/books?x=1#y`, ORIGIN), true);
  assert.equal(isAppUrl(ORIGIN, ORIGIN), true);
  for (const url of [
    'http://127.0.0.1:43210/', // same prefix, different port
    'http://127.0.0.1:4321.evil.example/',
    'http://127.0.0.1:4321@evil.example/',
    'https://127.0.0.1:4321/',
    'http://localhost:4321/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'not a url',
    '',
    undefined,
    null,
  ]) {
    assert.equal(isAppUrl(url, ORIGIN), false, String(url));
  }
});

test('isExternalWebUrl: only http(s) links may be handed to the system browser', () => {
  assert.equal(isExternalWebUrl('https://example.com/book'), true);
  assert.equal(isExternalWebUrl('http://example.com'), true);
  for (const url of ['file:///Applications/Calculator.app', 'javascript:alert(1)', 'data:text/html,hi', 'mailto:a@b.c', 'smb://host/share', 'ms-msdt:/x', '', 'nonsense', undefined]) {
    assert.equal(isExternalWebUrl(url), false, String(url));
  }
});

test('isTrustedDownloadUrl: https GitHub pages only', () => {
  assert.equal(isTrustedDownloadUrl('https://github.com/milandawijekoon/home_library/releases/latest'), true);
  for (const url of [
    'http://github.com/x',
    'https://github.com.evil.example/x',
    'https://evil.example/github.com',
    'https://github.com@evil.example/x',
    'https://raw.githubusercontent.com/x',
    'javascript:alert(1)',
    'file:///x',
    '',
    undefined,
    42,
  ]) {
    assert.equal(isTrustedDownloadUrl(url), false, String(url));
  }
});

test('compareVersions orders semantic versions numerically', () => {
  assert.equal(compareVersions('1.1.2', '1.1.2'), 0);
  assert.equal(compareVersions('1.1.2', '1.1.10'), -1);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('0.0.1', '0.1.0'), -1);
});
