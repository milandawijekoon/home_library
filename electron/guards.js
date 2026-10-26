// Pure helpers for the Electron shell (no electron import, so they can be unit-tested).

/** True only for a URL on exactly this origin. A prefix test is not enough: ":1234" would match ":12345". */
export function isAppUrl(url, origin) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** Only web links may leave the app for the user's own browser; never file:, javascript: and the like. */
export function isExternalWebUrl(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/** The update config may only send people to a GitHub page over https. */
export function isTrustedDownloadUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && hostname === 'github.com';
  } catch {
    return false;
  }
}

/** Compare "major.minor.patch" strings: -1, 0 or 1. */
export function compareVersions(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
