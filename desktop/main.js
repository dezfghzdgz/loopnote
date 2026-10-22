// Loopnote pro počítač: hlavní okno s appkou + jedna plovoucí bublina nad všemi aplikacemi.
// Klik na bublinu (nebo Ctrl/Cmd+Shift+L) = kroužkuješ přímo na živé obrazovce (nic se nezmrazí).
// Odpověď vyskočí v malém okénku hned vedle zakroužkovaného místa. Sešit se otevře jen přes „Uložit do sešitu“.
// Trojklik bublinu schová – vrátí se při dalším otevření Loopnote (ikona, zástupce, lišta u hodin).
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, shell, Tray, Menu, nativeImage } = require("electron");
const path = require("path");

let win = null, bubble = null, overlay = null, panel = null, tray = null, bubbleOff = false, quitting = false;
let capDisplay = null, busy = false, lang = { ui: "en", loc: "en-US" }, reqId = 0;
const pending = new Map(); // id -> panel webContents
const WWW = path.join(__dirname, "www", "index.html");
const PRELOAD = path.join(__dirname, "preload.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (!app.requestSingleInstanceLock()) app.quit();
// když appku otevřeš znovu (ikona, zástupce), vrátí se i schovaná bublina
app.on("second-instance", () => { showBubble(); showMain(); });

function showMain() {
  if (!win) createMain(true);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createMain(visible = true) {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 420, minHeight: 500, title: "Loopnote", show: visible,
    icon: path.join(__dirname, "build", "tray.png"), backgroundColor: "#eef1ef", autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, backgroundThrottling: false },
  });
  win.loadFile(WWW);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (/^https?:/.test(url)) { e.preventDefault(); shell.openExternal(url); } });
  // zavření okna = appka běží dál v liště, aby bublina fungovala
  win.on("close", (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
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
  bubble.on("closed", () => { bubble = null; });
}

function showBubble() {
  bubbleOff = false;
  if (!bubble) createBubble();
  bubble.showInactive();
}

// 1) kroužkování na živé obrazovce: průhledné okno, pod ním všechno běží dál
function startCircle() {
  if (overlay || busy) return;
  if (panel) panel.close();
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  capDisplay = disp;
  overlay = new BrowserWindow({
    x: disp.bounds.x, y: disp.bounds.y, width: disp.bounds.width, height: disp.bounds.height,
    frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false, alwaysOnTop: true, skipTaskbar: true,
    resizable: false, movable: false, enableLargerThanScreen: true, fullscreenable: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true },
  });
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadFile(path.join(__dirname, "overlay.html"), { query: { ui: lang.ui } });
  overlay.once("ready-to-show", () => overlay && overlay.focus());
  overlay.on("closed", () => { overlay = null; });
}

// 2) výřez: overlay zmizí, vyfotí se jen zakroužkované místo
async function grab(rect) {
  const disp = capDisplay || screen.getPrimaryDisplay();
  const sf = disp.scaleFactor || 1;
  const size = { width: Math.round(disp.size.width * sf), height: Math.round(disp.size.height * sf) };
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
  const src = sources.find((s) => String(s.display_id) === String(disp.id)) || sources[0];
  if (!src || src.thumbnail.isEmpty()) return null;
  const t = src.thumbnail, ts = t.getSize(), k = ts.width / disp.bounds.width;
  const crop = {
    x: Math.max(0, Math.round(rect.x * k)), y: Math.max(0, Math.round(rect.y * k)),
    width: Math.round(rect.w * k), height: Math.round(rect.h * k),
  };
  crop.width = Math.max(1, Math.min(crop.width, ts.width - crop.x));
  crop.height = Math.max(1, Math.min(crop.height, ts.height - crop.y));
  let img = t.crop(crop);
  const m = Math.max(crop.width, crop.height);
  if (m > 1600) img = img.resize({ width: Math.round(crop.width * 1600 / m), quality: "good" });
  return "data:image/jpeg;base64," + img.toJPEG(88).toString("base64");
}

// 3) okénko s odpovědí hned vedle výřezu
function openPanel(url, rect) {
  const disp = capDisplay || screen.getPrimaryDisplay();
  const wa = disp.workArea, W = 400, H = 470, gap = 14;
  const ax = disp.bounds.x + rect.x, ay = disp.bounds.y + rect.y;
  let x = ax + rect.w + gap;
  if (x + W > wa.x + wa.width) x = ax - W - gap;
  if (x < wa.x) x = Math.min(wa.x + wa.width - W, Math.max(wa.x, ax + rect.w / 2 - W / 2));
  let y = Math.min(Math.max(wa.y, ay), wa.y + wa.height - H);
  panel = new BrowserWindow({
    x: Math.round(x), y: Math.round(y), width: W, height: H, minWidth: 300, minHeight: 260,
    frame: false, transparent: false, backgroundColor: "#fbfaf6", alwaysOnTop: true, skipTaskbar: false,
    resizable: true, maximizable: false, fullscreenable: false, title: "Loopnote",
    webPreferences: { preload: PRELOAD, contextIsolation: true },
  });
  panel.setAlwaysOnTop(true, "floating");
  panel.loadFile(path.join(__dirname, "panel.html"), { query: { ui: lang.ui, loc: lang.loc } });
  panel.webContents.once("did-finish-load", () => { if (panel) panel.webContents.send("panel-init", { url }); });
  panel.on("closed", () => { panel = null; });
}

function askMain(sender, req) {
  const id = ++reqId;
  pending.set(id, sender);
  if (!win) createMain(false);
  const send = () => win && win.webContents.send("explain", Object.assign({ id }, req));
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", () => setTimeout(send, 1200)); else send();
  setTimeout(() => { // pojistka, kdyby appka neodpověděla
    const s = pending.get(id);
    if (s && !s.isDestroyed()) s.send("panel-answer", { id, err: "timeout" });
    pending.delete(id);
  }, 90000);
}

ipcMain.on("overlay-done", async (_e, rect) => {
  if (overlay) overlay.close();
  if (!rect) return;
  busy = true;
  const hideB = bubble && bubble.isVisible() && bubble.getBounds();
  // bublinu schovat jen když je v zakroužkovaném místě
  const db = capDisplay ? capDisplay.bounds : { x: 0, y: 0 };
  const inside = hideB && hideB.x - db.x < rect.x + rect.w && hideB.x - db.x + hideB.width > rect.x && hideB.y - db.y < rect.y + rect.h && hideB.y - db.y + hideB.height > rect.y;
  if (inside) bubble.hide();
  await wait(process.platform === "win32" ? 220 : 160);
  let url = null;
  try { url = await grab(rect); } catch (e) { console.error(e); }
  if (inside && !bubbleOff && bubble) bubble.showInactive();
  busy = false;
  if (!url) { showMain(); win.webContents.send("capture-failed"); return; }
  openPanel(url, rect);
  if (process.env.LOOPNOTE_TEST_HOOK) process.emit("loopnote-panel", panel, url);
});

ipcMain.on("panel-ask", (e, req) => askMain(e.sender, req));
ipcMain.on("explain-result", (_e, res) => {
  if (res && res.ui) lang = { ui: res.ui, loc: res.lang || lang.loc };
  const s = pending.get(res.id);
  pending.delete(res.id);
  if (s && !s.isDestroyed()) s.send("panel-answer", res);
});
ipcMain.on("hello", (_e, l) => { if (l && l.ui) lang = { ui: l.ui, loc: l.loc || lang.loc }; });
ipcMain.on("panel-save", (_e, d) => {
  if (panel) panel.close();
  showMain();
  const send = () => win.webContents.send("circle-image", d);
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", () => setTimeout(send, 900)); else send();
});
ipcMain.on("panel-close", () => { if (panel) panel.close(); });
ipcMain.on("panel-again", () => { if (panel) panel.close(); setTimeout(startCircle, 120); });

ipcMain.on("bubble-move", (_e, dx, dy) => { if (!bubble) return; const [x, y] = bubble.getPosition(); bubble.setPosition(Math.round(x + dx), Math.round(y + dy)); });
ipcMain.on("bubble-click", () => startCircle());
ipcMain.on("bubble-off", () => { bubbleOff = true; if (bubble) bubble.hide(); });

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, "build", "tray.png")).resize({ width: 18, height: 18 });
  tray = new Tray(img);
  tray.setToolTip("Loopnote");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Loopnote", click: () => { showBubble(); showMain(); } },
    { label: "Circle on screen (Ctrl+Shift+L)", click: () => startCircle() },
    { label: "Show bubble", click: showBubble },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", () => { showBubble(); showMain(); });
}

app.whenReady().then(() => {
  createMain(true);
  showBubble();
  createTray();
  globalShortcut.register("CommandOrControl+Shift+L", () => startCircle());
  app.on("activate", () => { showBubble(); showMain(); });
  if (process.env.LOOPNOTE_TEST_HOOK) require(process.env.LOOPNOTE_TEST_HOOK)({ startCircle, get win() { return win; }, get panel() { return panel; }, get overlay() { return overlay; }, get bubble() { return bubble; } });
});
app.on("before-quit", () => { quitting = true; });
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => { /* běží dál v liště */ });
