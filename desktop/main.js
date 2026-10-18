// Sender, application de bureau : lance le serveur sur l'ordinateur et l'affiche dans une fenêtre.
const { app, BrowserWindow, shell, dialog } = require('electron');
const net = require('net');
const path = require('path');

// Port fixe pour que le brouillon (gardé par la fenêtre) soit retrouvé d'un lancement à l'autre.
const PREFERRED_PORT = 47321;

const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer().once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

if (!app.requestSingleInstanceLock()) app.quit();

let win;
async function start() {
  // Réglages, modèles, CV et historique : dans le dossier de l'utilisateur, conservés entre les mises à jour.
  process.env.STORAGE_DIR = app.getPath('userData');
  process.env.HOST = '127.0.0.1';
  process.env.PORT = String((await portFree(PREFERRED_PORT)) ? PREFERRED_PORT : 0);
  process.env.LOGIN = '1';
  process.env.SEED_FILE = path.join(__dirname, 'seed', 'sender-sauvegarde.json');
  const server = await require('../server.js');
  const url = `http://127.0.0.1:${server.address().port}/`;

  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    title: 'Sender', autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  // Les liens externes s'ouvrent dans le navigateur habituel.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!target.startsWith(url)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(url)) { e.preventDefault(); shell.openExternal(target); }
  });
  win.loadURL(url);
}

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
app.whenReady().then(start).catch((e) => {
  dialog.showErrorBox('Sender', 'Démarrage impossible : ' + e.message);
  app.quit();
});
app.on('window-all-closed', () => app.quit());
