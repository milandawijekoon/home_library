// Desktop entry point used by the packaged app: starts the server on a free local port,
// keeps the library in the user's own data folder, and opens it in the default browser.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './server.js';

const BASE_PORT = Number(process.env.HOME_LIBRARY_PORT) || 47321;
const PORT_TRIES = 50;

function defaultDataDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'HomeLibrary');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'HomeLibrary');
  return path.join(os.homedir(), '.local', 'share', 'HomeLibrary');
}

const dataDir = process.env.HOME_LIBRARY_DATA_DIR ? path.resolve(process.env.HOME_LIBRARY_DATA_DIR) : defaultDataDir();
const portFile = path.join(dataDir, 'port');

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

// Shown when there is no terminal to read an error in.
function alertUser(message) {
  console.error(message);
  if (process.platform === 'darwin') {
    const text = message.replace(/[\\"]/g, ' ').replace(/\s+/g, ' ');
    spawn('osascript', ['-e', `display alert "Home Library" message "${text}"`], { stdio: 'ignore' }).on('error', () => {});
  } else if (process.platform === 'win32') {
    const text = message.replace(/['"]/g, ' ').replace(/\s+/g, ' ');
    const script = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${text}', 'Home Library') | Out-Null`;
    spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], { stdio: 'ignore' }).on('error', () => {});
  }
}

// If a copy is already running, reuse it instead of opening a second one on the same library file.
async function runningPort() {
  const port = Number(await fs.readFile(portFile, 'utf8').catch(() => ''));
  if (!port) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return (await res.json()).status === 'ok' ? port : null;
  } catch {
    return null;
  }
}

function listenOnFreePort(server) {
  return new Promise((resolve, reject) => {
    let port = BASE_PORT;
    const attempt = () => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && port < BASE_PORT + PORT_TRIES) {
          port += 1;
          attempt();
        } else {
          reject(err);
        }
      });
      server.listen(port, '127.0.0.1', () => {
        server.removeAllListeners('error');
        resolve(port);
      });
    };
    attempt();
  });
}

await fs.mkdir(dataDir, { recursive: true });

const existing = await runningPort();
if (existing) {
  openBrowser(`http://127.0.0.1:${existing}`);
  process.exit(0);
}

let stopping = false;
const { server, store, options } = createApp({
  host: '127.0.0.1',
  dataFile: path.join(dataDir, 'books.json'),
  googleBooksKey: process.env.GOOGLE_BOOKS_API_KEY || '',
  onQuit: () => shutdown(),
});

function shutdown() {
  if (stopping) return;
  stopping = true;
  fs.rm(portFile, { force: true }).finally(() => server.close(() => process.exit(0)));
  server.closeAllConnections();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  const count = await store.init();
  console.log(`Library file: ${options.dataFile} (${count} book${count === 1 ? '' : 's'})`);
  const port = await listenOnFreePort(server);
  await fs.writeFile(portFile, String(port));
  console.log(`Home Library is running at http://127.0.0.1:${port}`);
  openBrowser(`http://127.0.0.1:${port}`);
} catch (err) {
  alertUser(`Home Library could not start. ${err.message}`);
  process.exit(1);
}
