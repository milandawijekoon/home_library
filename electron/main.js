// Electron entry point: runs the same local server as before, but shows the library in
// its own app window instead of the default browser. Books stay in the user's data folder.
import { app, BrowserWindow, dialog, Menu, session, shell } from 'electron';
import path from 'node:path';
import { createApp } from '../server.js';
import { initUpdater } from './updater.js';
import { isAppUrl, isExternalWebUrl } from './guards.js';

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

  // The window never leaves the app: web links open in the user's own browser, everything else is dropped.
  const keepInApp = (event, url) => {
    if (isAppUrl(url, origin)) return;
    event.preventDefault();
    if (isExternalWebUrl(url)) shell.openExternal(url);
  };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalWebUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', keepInApp);
  mainWindow.webContents.on('will-redirect', keepInApp);
}

// The barcode scanner needs the camera; allow it for our own page only.
function allowCameraForApp(ses) {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(permission === 'media' && isAppUrl(details.requestingUrl, origin));
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) =>
    permission === 'media' && isAppUrl(requestingOrigin, origin));
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

// The app never uses <webview>; refuse to attach one even if markup tries to.
app.on('web-contents-created', (event, contents) => {
  contents.on('will-attach-webview', (attachEvent) => attachEvent.preventDefault());
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
