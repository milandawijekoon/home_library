// Electron entry point: runs the same local server as before, but shows the library in
// its own app window instead of the default browser. Books stay in the user's data folder.
import { app, BrowserWindow, dialog, Menu, session, shell } from 'electron';
import path from 'node:path';
import { createApp } from '../server.js';
import { initUpdater } from './updater.js';

let mainWindow = null;
let server = null;
let origin = '';

// Folder name kept from the earlier launcher (before the rename) so existing libraries carry over.
const dataDir = process.env.HOME_LIBRARY_DATA_DIR
  ? path.resolve(process.env.HOME_LIBRARY_DATA_DIR)
  : path.join(app.getPath('appData'), 'HomeLibrary');
app.setPath('userData', dataDir);

if (!app.requestSingleInstanceLock()) app.quit();

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

function listen(srv, host) {
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    // Port 0: the OS picks a free port, so the app never clashes with anything else.
    srv.listen(0, host, () => resolve(srv.address().port));
  });
}

async function startServer() {
  const created = createApp({
    host: '127.0.0.1',
    dataFile: path.join(dataDir, 'books.json'),
    googleBooksKey: process.env.GOOGLE_BOOKS_API_KEY || '',
  });
  server = created.server;
  await created.store.init();
  const port = await listen(server, '127.0.0.1');
  origin = `http://127.0.0.1:${port}`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    title: 'Shelfie Home Library',
    backgroundColor: '#ffffff',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  mainWindow.loadURL(origin);
  mainWindow.on('closed', () => { mainWindow = null; });

  // Anything outside the app (book links, etc.) opens in the user's own browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) {
      event.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
}

// The barcode scanner needs the camera; allow it for our own page only.
function allowCameraForApp(ses) {
  const isApp = (url) => typeof url === 'string' && url.startsWith(origin);
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(permission === 'media' && isApp(details.requestingUrl));
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) =>
    permission === 'media' && isApp(requestingOrigin));
}

app.whenReady().then(async () => {
  try {
    await startServer();
  } catch (err) {
    dialog.showErrorBox('Shelfie Home Library could not start', err.message);
    app.quit();
    return;
  }
  allowCameraForApp(session.defaultSession);
  const updater = initUpdater({ getWindow: () => mainWindow });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Check for Updates…', click: () => updater.checkNow({ userInitiated: true }) }] },
  ]));
  createWindow();
  app.on('activate', () => { if (!mainWindow) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (server) {
    server.closeAllConnections();
    server.close();
  }
});
