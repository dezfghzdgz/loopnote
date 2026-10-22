// Loopnote pro počítač: hlavní okno s appkou + plovoucí bublina nad všemi aplikacemi.
// Klik na bublinu (nebo Ctrl/Cmd+Shift+L) = vyfotí obrazovku, zakroužkuješ, co nechápeš, a otevře se pomocník.
// Trojklik na bublinu ji schová do dalšího spuštění. Zavřením okna appka běží dál v liště (ikona u hodin).
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, shell, Tray, Menu, nativeImage } = require("electron");
const path = require("path");

let win = null, bubble = null, overlay = null, tray = null, bubbleOff = false, quitting = false;
const WWW = path.join(__dirname, "www", "index.html");
const PRELOAD = path.join(__dirname, "preload.js");

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => showMain());

function showMain() {
  if (!win) createMain();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createMain() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 420, minHeight: 500, title: "Loopnote",
    icon: path.join(__dirname, "build", "tray.png"), backgroundColor: "#eef1ef", autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true },
  });
  win.loadFile(WWW);
  // odkazy ven (platby, web) do prohlížeče
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (/^https?:/.test(url)) { e.preventDefault(); shell.openExternal(url); } });
  win.on("close", (e) => { if (!quitting && process.platform !== "darwin") { e.preventDefault(); win.hide(); } });
  win.on("closed", () => { win = null; });
}

function createBubble() {
  const { workArea } = screen.getPrimaryDisplay();
  bubble = new BrowserWindow({
    width: 72, height: 72, x: workArea.x + workArea.width - 100, y: workArea.y + Math.round(workArea.height * 0.62),
    frame: false, transparent: true, resizable: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    focusable: false, fullscreenable: false, maximizable: false, minimizable: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true },
  });
  bubble.setAlwaysOnTop(true, "screen-saver");
  bubble.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  bubble.loadFile(path.join(__dirname, "bubble.html"));
}

async function startCapture() {
  if (overlay) return;
  const b = bubble ? bubble.getBounds() : screen.getCursorScreenPoint();
  const disp = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
  if (bubble) bubble.hide();
  await new Promise((r) => setTimeout(r, 180)); // ať bublina není na fotce
  let shot = null;
  try {
    const size = { width: Math.round(disp.size.width * disp.scaleFactor), height: Math.round(disp.size.height * disp.scaleFactor) };
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
    const src = sources.find((s) => String(s.display_id) === String(disp.id)) || sources[0];
    if (src && !src.thumbnail.isEmpty()) shot = src.thumbnail.toDataURL();
  } catch (e) { console.error(e); }
  if (!shot) { // na Macu je potřeba povolit nahrávání obrazovky
    if (bubble && !bubbleOff) bubble.showInactive();
    showMain();
    win.webContents.send("capture-failed");
    return;
  }
  overlay = new BrowserWindow({
    x: disp.bounds.x, y: disp.bounds.y, width: disp.bounds.width, height: disp.bounds.height,
    frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false, enableLargerThanScreen: true,
    fullscreen: process.platform !== "darwin", backgroundColor: "#000000",
    webPreferences: { preload: PRELOAD, contextIsolation: true },
  });
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.loadFile(path.join(__dirname, "overlay.html"));
  overlay.webContents.once("did-finish-load", () => overlay.webContents.send("shot", shot));
  overlay.on("closed", () => { overlay = null; if (bubble && !bubbleOff) bubble.showInactive(); });
}

ipcMain.on("bubble-move", (_e, dx, dy) => { if (!bubble) return; const [x, y] = bubble.getPosition(); bubble.setPosition(Math.round(x + dx), Math.round(y + dy)); });
ipcMain.on("bubble-click", () => startCapture());
ipcMain.on("bubble-off", () => { bubbleOff = true; if (bubble) bubble.hide(); });
ipcMain.on("overlay-done", (_e, dataUrl) => {
  if (overlay) overlay.close();
  if (!dataUrl) return;
  showMain();
  const send = () => win.webContents.send("circle-image", dataUrl);
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", () => setTimeout(send, 900)); else send();
});

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, "build", "tray.png")).resize({ width: 18, height: 18 });
  tray = new Tray(img);
  tray.setToolTip("Loopnote");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Loopnote", click: showMain },
    { label: "Circle on screen (Ctrl+Shift+L)", click: () => startCapture() },
    { label: "Show bubble", click: () => { bubbleOff = false; if (!bubble) createBubble(); bubble.showInactive(); } },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", showMain);
}

app.whenReady().then(() => {
  createMain();
  createBubble();
  createTray();
  globalShortcut.register("CommandOrControl+Shift+L", () => startCapture());
  app.on("activate", showMain);
});
app.on("before-quit", () => { quitting = true; });
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => { /* běží dál v liště */ });
