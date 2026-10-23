// Loopnote pro počítač: hlavní okno s appkou + jedna plovoucí bublina nad všemi aplikacemi.
// Klik na bublinu (nebo Ctrl/Cmd+Shift+L) = kroužkuješ přímo na živé obrazovce (nic se nezmrazí).
// Podržení nebo pravý klik na bublinu (nebo Ctrl/Cmd+Shift+Mezerník) = mluvíš s pomocníkem hlasem.
// V režimu „jen hlas“ nevyskočí žádné okénko: pomocník vidí obrazovku, mluví a kreslí přímo na ni (kroužek, šipka, podtržení, poznámka).
// Odpověď vyskočí v malém okénku hned vedle zakroužkovaného místa. Sešit se otevře jen přes „Uložit do sešitu“.
// Kamarád u kurzoru: malý Loopnote jezdí s myší, při mluvení ukazuje, kam kliknout (doletí na místo); úkoly na pozadí hlásí oznámením.
// Trojklik bublinu schová – vrátí se při dalším otevření Loopnote (ikona, zástupce, lišta u hodin).
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, shell, Tray, Menu, nativeImage, session, systemPreferences, Notification } = require("electron");
const path = require("path");

let win = null, bubble = null, overlay = null, panel = null, tray = null, bubbleOff = false, quitting = false;
let annot = null, screenTalk = { on: false, sid: 0 }, annotClearT = null;
let capDisplay = null, busy = false, lang = { ui: "en", loc: "en-US", mode: "screen", subs: true, buddy: "always" }, reqId = 0, talkWant = 0, overlayTimer = null;
const ALL_SPACES = { visibleOnFullScreen: true, skipTransformProcessType: true };
const BS = 72; // velikost bubliny – pevná, nikdy se nemění
let drag = null;
const pending = new Map(); // id -> panel webContents
const WWW = path.join(__dirname, "www", "index.html");
const PRELOAD = path.join(__dirname, "preload.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (!app.requestSingleInstanceLock()) app.exit(0); // druhé spuštění jen probudí to první
if (process.platform === "win32") app.setAppUserModelId("app.loopnote.desktop"); // oznámení (minutka, připomínky) ve Windows
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
    webPreferences: { preload: PRELOAD, contextIsolation: true, backgroundThrottling: false, autoplayPolicy: "no-user-gesture-required" },
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
    width: BS, height: BS, minWidth: BS, minHeight: BS, maxWidth: BS, maxHeight: BS,
    x: workArea.x + workArea.width - 100, y: workArea.y + Math.round(workArea.height * 0.62),
    frame: false, transparent: true, resizable: false, thickFrame: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    focusable: false, fullscreenable: false, maximizable: false, minimizable: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true },
  });
  bubble.setAlwaysOnTop(true, "screen-saver");
  bubble.setVisibleOnAllWorkspaces(true, ALL_SPACES);
  bubble.loadFile(path.join(__dirname, "bubble.html"), { query: { ui: lang.ui } });
  bubble.on("closed", () => { bubble = null; });
  // Windows s měřítkem displeje (125 %, 150 %) umí okno při posunu zvětšit – hned vrátit na pevnou velikost
  const fix = () => { if (!bubble || bubble.isDestroyed()) return; const b = bubble.getBounds(); if (b.width !== BS || b.height !== BS) bubble.setBounds({ x: b.x, y: b.y, width: BS, height: BS }); };
  bubble.on("resize", fix); bubble.on("moved", fix); screen.on("display-metrics-changed", fix);
}
function placeBubble(x, y) { if (bubble && !bubble.isDestroyed()) bubble.setBounds({ x: Math.round(x), y: Math.round(y), width: BS, height: BS }); }

function showBubble() {
  bubbleOff = false;
  if (!bubble) createBubble();
  keepBubbleOnScreen();
  bubble.showInactive();
  buddySync();
}
// po odpojení monitoru nebo přetažení mimo obrazovku vrátit bublinu na viditelné místo
function keepBubbleOnScreen() {
  if (!bubble || bubble.isDestroyed()) return;
  const b = bubble.getBounds(), wa = screen.getDisplayMatching(b).workArea;
  const x = Math.min(Math.max(b.x, wa.x), wa.x + wa.width - b.width), y = Math.min(Math.max(b.y, wa.y), wa.y + wa.height - b.height);
  if (x !== b.x || y !== b.y || b.width !== BS || b.height !== BS) placeBubble(x, y);
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
  overlay.setVisibleOnAllWorkspaces(true, ALL_SPACES);
  overlay.loadFile(path.join(__dirname, "overlay.html"), { query: { ui: lang.ui } });
  overlay.once("ready-to-show", () => { if (overlay) { overlay.moveTop(); overlay.focus(); } });
  overlay.webContents.once("did-finish-load", () => { if (overlay) { overlay.moveTop(); overlay.focus(); } });
  try { globalShortcut.register("Escape", () => { if (overlay) overlay.close(); }); } catch (e) { /* jiná appka ho drží */ }
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(() => { if (overlay) overlay.close(); }, 60000);
  overlay.on("closed", () => { overlay = null; clearTimeout(overlayTimer); try { globalShortcut.unregister("Escape"); } catch (e) { /* nic */ } });
}

// 2) výřez: overlay zmizí, vyfotí se jen zakroužkované místo
async function grab(rect, maxSide = 1280) {
  if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("screen") !== "granted") {
    // bez povolení by se vyfotila jen tapeta; tohle vyvolá systémovou žádost o povolení
    await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }).catch(() => {});
    return null;
  }
  const disp = capDisplay || screen.getPrimaryDisplay();
  const sf = disp.scaleFactor || 1;
  const size = { width: Math.round(disp.size.width * sf), height: Math.round(disp.size.height * sf) };
  const sources = await Promise.race([
    desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size }),
    wait(8000).then(() => { throw new Error("capture timeout"); }),
  ]);
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
  if (m > maxSide) img = img.resize({ width: Math.round(crop.width * maxSide / m), quality: "good" }); // menší = rychlejší odpověď
  return "data:image/jpeg;base64," + img.toJPEG(84).toString("base64");
}

// 3) okénko s odpovědí hned vedle výřezu
function openPanel(url, rect, talk = false) {
  if (panel) { const old = panel; panel = null; old.removeAllListeners("closed"); old.close(); stopTalkMain(); }
  const disp = capDisplay || screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  if (!rect) { // bez kroužku: okénko vedle bubliny
    const bb = bubble && bubble.isVisible() ? bubble.getBounds() : { x: disp.workArea.x + disp.workArea.width - 100, y: disp.workArea.y + disp.workArea.height - 140, width: 72, height: 72 };
    rect = { x: bb.x - disp.bounds.x, y: bb.y - disp.bounds.y - 200, w: bb.width, h: bb.height };
  }
  const wa = disp.workArea, W = 420, H = 540, gap = 4; // okno má kolem karty 10 px průhledný okraj na stín
  const ax = disp.bounds.x + rect.x, ay = disp.bounds.y + rect.y;
  let x = ax + rect.w + gap;
  if (x + W > wa.x + wa.width) x = ax - W - gap;
  if (x < wa.x) x = Math.min(wa.x + wa.width - W, Math.max(wa.x, ax + rect.w / 2 - W / 2));
  let y = Math.min(Math.max(wa.y, ay), wa.y + wa.height - H);
  panel = new BrowserWindow({
    x: Math.round(x), y: Math.round(y), width: W, height: H, minWidth: 320, minHeight: 300,
    frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false, thickFrame: false, alwaysOnTop: true, skipTaskbar: false,
    resizable: true, maximizable: false, fullscreenable: false, title: "Loopnote",
    webPreferences: { preload: PRELOAD, contextIsolation: true },
  });
  panel.setAlwaysOnTop(true, "floating");
  panel.loadFile(path.join(__dirname, "panel.html"), { query: { ui: lang.ui, loc: lang.loc } });
  panel.webContents.once("did-finish-load", () => { if (panel) panel.webContents.send("panel-init", { url, talk, ui: lang.ui }); });
  const me = panel;
  panel.on("closed", () => { if (panel !== me) return; panel = null; stopTalkMain(); });
  panel.focus();
}

function toMain(ch, data) {
  if (!win) createMain(false);
  const send = () => win && !win.isDestroyed() && win.webContents.send(ch, data);
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", () => setTimeout(send, 1200)); else send();
}
function stopTalkMain() { talkWant = 0; toMain("talk", { on: false }); toMain("speak", null); bubbleState(""); }
function bubbleState(s) { if (bubble && !bubble.isDestroyed()) bubble.webContents.send("bubble-state", s); }
// mikrofon pro rozhovor (okna Loopnote si o něj můžou říct)
function allowMedia() {
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(["media", "notifications", "clipboard-read", "clipboard-sanitized-write"].includes(perm)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => ["media", "notifications", "clipboard-read", "clipboard-sanitized-write"].includes(perm));
}
async function micOk() {
  if (process.platform !== "darwin") return true;
  try { return systemPreferences.getMediaAccessStatus("microphone") === "granted" || await systemPreferences.askForMediaAccess("microphone"); } catch { return true; }
}
// rozhovor bez kroužkování: okénko vedle bubliny a rovnou poslouchá
async function startTalk() {
  if (overlay) overlay.close();
  if (lang.mode === "screen") return toggleScreenTalk();
  await micOk();
  capDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  openPanel("", null, true);
}

// --- režim „jen hlas“: bez okénka, pomocník kreslí na obrazovku ---
function annotWin() {
  const disp = capDisplay || screen.getPrimaryDisplay();
  if (annot && !annot.isDestroyed()) {
    const b = annot.getBounds();
    if (b.x !== disp.bounds.x || b.y !== disp.bounds.y || b.width !== disp.bounds.width || b.height !== disp.bounds.height) annot.setBounds(disp.bounds);
    return annot;
  }
  annot = new BrowserWindow({
    x: disp.bounds.x, y: disp.bounds.y, width: disp.bounds.width, height: disp.bounds.height,
    frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false, alwaysOnTop: true, skipTaskbar: true,
    focusable: false, resizable: false, movable: false, enableLargerThanScreen: true, fullscreenable: false, show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true },
  });
  annot.setIgnoreMouseEvents(true); // myš prochází skrz – kresba nic neblokuje
  annot.setAlwaysOnTop(true, "screen-saver");
  annot.setVisibleOnAllWorkspaces(true, ALL_SPACES);
  annot.loadFile(path.join(__dirname, "annot.html"), { query: { ui: lang.ui } });
  annot.once("ready-to-show", () => annot && annot.showInactive());
  annot.on("closed", () => { annot = null; });
  return annot;
}
function toAnnot(msg) {
  const w = annotWin();
  const send = () => { if (!w.isDestroyed()) { if (!w.isVisible()) w.showInactive(); if (bubble && !bubble.isDestroyed()) bubble.moveTop(); w.webContents.send("annot", Object.assign({ subs: lang.subs }, msg)); } };
  if (w.webContents.isLoading()) w.webContents.once("did-finish-load", send); else send();
}
async function toggleScreenTalk() {
  if (screenTalk.on) return stopScreenTalk();
  if (panel) panel.close();
  await micOk();
  const bb = bubble && bubble.isVisible() ? bubble.getBounds() : null;
  capDisplay = bb ? screen.getDisplayMatching(bb) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  screenTalk = { on: true, sid: Date.now() };
  try { globalShortcut.register("Escape", stopScreenTalk); } catch (e) { /* drží jiná appka */ }
  toAnnot({ st: "listening" });
  buddySync();
  toMain("talk", { on: true, sid: screenTalk.sid, mode: "screen" });
}
function stopScreenTalk() {
  if (!screenTalk.on) return;
  screenTalk.on = false;
  try { globalShortcut.unregister("Escape"); } catch (e) { /* nic */ }
  toMain("talk", { on: false }); toMain("speak", null); bubbleState("");
  if (annot) toAnnot({ st: "off", clear: "slow" });
  hideAnnotSoon();
  setTimeout(buddySync, 4000); // „jen při mluvení“ – chvíli ještě zůstane (doukazuje)
}
// --- kamarád u kurzoru ---
let curT = null, lastCur = "", jobsN = 0;
function buddyWanted() { return !bubbleOff && (lang.buddy === "always" || (lang.buddy === "talk" && screenTalk.on)); }
function buddySync() {
  const want = buddyWanted();
  if (want && !curT) {
    toAnnot({ buddy: true, jobs: jobsN });
    curT = setInterval(feedCursor, 16);
  } else if (!want && curT) {
    clearInterval(curT); curT = null; lastCur = "";
    if (annot && !annot.isDestroyed()) annot.webContents.send("annot", { buddy: false });
    if (!screenTalk.on) hideAnnotSoon();
  }
}
function feedCursor() {
  if (!annot || annot.isDestroyed()) { clearInterval(curT); curT = null; return; }
  const c = screen.getCursorScreenPoint();
  let b = annot.getBounds();
  // myš přejela na jiný monitor → kamarád (a vrstva) jde s ní, pokud zrovna nic nekreslí
  if (!screenTalk.on && (c.x < b.x || c.y < b.y || c.x >= b.x + b.width || c.y >= b.y + b.height)) {
    capDisplay = screen.getDisplayNearestPoint(c); annot.setBounds(capDisplay.bounds); b = annot.getBounds();
  }
  const k = (c.x - b.x) + "," + (c.y - b.y);
  if (k === lastCur) return;
  lastCur = k;
  if (!annot.isVisible()) annot.showInactive();
  annot.webContents.send("annot", { cur: [c.x - b.x, c.y - b.y] });
}
function hideAnnotSoon() { clearTimeout(annotClearT); annotClearT = setTimeout(() => { if (annot && !annot.isDestroyed() && !screenTalk.on && !curT) annot.hide(); }, 3500); }

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
ipcMain.on("panel-talk", async (_e, req) => {
  if (!req || !req.on) { talkWant = 0; toMain("talk", { on: false }); return; }
  talkWant = req.sid;
  await micOk();
  if (talkWant !== req.sid || !panel) return; // mezitím vypnuto nebo zavřeno
  toMain("talk", req);
});
ipcMain.on("panel-speak", (_e, req) => toMain("speak", req));
ipcMain.on("panel-open-nb", (_e, req) => { showMain(); toMain("open-nb", req); });
ipcMain.on("talk-event", (_e, ev) => {
  if (panel && !panel.isDestroyed()) panel.webContents.send("talk-event", ev);
  if (screenTalk.on && ev && ev.sid === screenTalk.sid) {
    if (ev.type === "state") {
      if (ev.st === "off" || ev.st === "error") { screenTalk.on = false; try { globalShortcut.unregister("Escape"); } catch (e) { /* nic */ } toAnnot({ st: ev.st === "error" ? "listening" : "off", text: ev.x || "", clear: "slow" }); if (ev.st === "error") setTimeout(() => { toAnnot({ st: "off" }); hideAnnotSoon(); }, 5000); else hideAnnotSoon(); setTimeout(buddySync, 4000); }
      else if (ev.st === "listening") toAnnot({ st: "listening" });
      else if (ev.st === "heard") toAnnot({ st: "heard", text: "„" + (ev.x || "") + "“" });
      else if (ev.st === "thinking") toAnnot({ st: "thinking" });
    }
    if (ev.type === "partial" && ev.text) toAnnot({ st: "thinking", text: ev.text.replace(/\s+/g, " ").slice(-220) });
    if (ev.type === "answer") toAnnot({ st: "speaking", text: (ev.text || "").replace(/\*\*/g, "").replace(/\s+/g, " ").slice(0, 320) });
  }
  if (ev && ev.type === "state") bubbleState(["listening", "thinking", "heard", "speaking"].includes(ev.st) ? ev.st : "");
  if (ev && ev.type === "speaking") bubbleState(ev.on ? "speaking" : "");
});
ipcMain.handle("screen-shot", async () => {
  if (screenTalk.on) { capDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()); if (annot && !annot.isDestroyed()) annotWin(); }
  const disp = capDisplay || screen.getPrimaryDisplay();
  const hadAnnot = annot && !annot.isDestroyed() && annot.isVisible();
  if (hadAnnot) { annot.setOpacity(0); await wait(60); } // vlastní kresba na snímek nepatří
  let url = null;
  try { url = await grab({ x: 0, y: 0, w: disp.bounds.width, h: disp.bounds.height }, 1600); } catch (e) { console.error(e); }
  if (hadAnnot) annot.setOpacity(1);
  return url ? { url, w: disp.bounds.width, h: disp.bounds.height } : null;
});
ipcMain.on("draw", (_e, d) => {
  clearTimeout(annotClearT);
  if (d && d.items && d.items.length) toAnnot({ items: d.items }); else toAnnot({ clear: "slow" });
});
// zkouška kreslení z nastavení (bez AI) – ukáže, že vrstva na obrazovce funguje
ipcMain.on("draw-test", (_e, d) => {
  if (!screenTalk.on) { const bb = bubble && bubble.isVisible() ? bubble.getBounds() : null; capDisplay = bb ? screen.getDisplayMatching(bb) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()); }
  if (win && win.isVisible() && !screenTalk.on) win.minimize(); // ať je kresba vidět na ploše
  clearTimeout(annotClearT);
  setTimeout(() => { toAnnot({ items: (d && d.items) || [], st: "speaking", text: (d && d.text) || "" }); annotClearT = setTimeout(() => { toAnnot({ st: "off", clear: "slow" }); hideAnnotSoon(); }, 6000); }, 350);
});
ipcMain.on("draw-clear", (_e, slow) => { clearTimeout(annotClearT); annotClearT = setTimeout(() => { if (annot) toAnnot({ clear: "slow" }); }, slow ? 7000 : 0); });
ipcMain.on("overlay-talk", () => { if (overlay) overlay.close(); setTimeout(startTalk, 80); });
ipcMain.on("bubble-talk", () => startTalk());
ipcMain.on("explain-partial", (_e, res) => { const s = pending.get(res.id); if (s && !s.isDestroyed()) s.send("panel-partial", res); });
ipcMain.on("explain-result", (_e, res) => {
  if (res && res.ui) lang = Object.assign({}, lang, { ui: res.ui, loc: res.lang || lang.loc });
  const s = pending.get(res.id);
  pending.delete(res.id);
  if (s && !s.isDestroyed()) s.send("panel-answer", res);
});
ipcMain.on("hello", (_e, l) => { if (!l || !l.ui) return; const m0 = lang.mode; const b0 = lang.buddy; lang = { ui: l.ui, loc: l.loc || lang.loc, mode: l.mode || lang.mode, subs: l.subs !== false, buddy: l.buddy || lang.buddy }; if (m0 !== lang.mode || b0 !== lang.buddy) updateTray(); buddySync(); });
// úkoly na pozadí: počet běžících (kamarád ukáže točící se tečku) a oznámení, když je hotovo
ipcMain.on("jobs", (_e, n) => { jobsN = +n || 0; if (annot && !annot.isDestroyed()) annot.webContents.send("annot", { jobs: jobsN }); if (tray) tray.setToolTip(jobsN ? `Loopnote – ${jobsN} ⏳` : "Loopnote"); });
ipcMain.on("notify", (_e, d) => {
  if (!d) return;
  if (curT && d.say) toAnnot({ say: String(d.say).slice(0, 120) });
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: String(d.title || "Loopnote"), body: String(d.body || "").slice(0, 240), icon: path.join(__dirname, "build", "tray.png") });
    n.on("click", () => { showMain(); if (d.nbId) toMain("open-nb", { nbId: d.nbId, pi: d.pi || 0 }); });
    n.show();
  } catch (e) { console.error(e); }
});
ipcMain.on("panel-save", (_e, d) => {
  if (panel) panel.close();
  showMain();
  const send = () => win.webContents.send("circle-image", d);
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", () => setTimeout(send, 900)); else send();
});
ipcMain.on("panel-close", () => { if (panel) panel.close(); });
ipcMain.on("panel-again", () => { if (panel) panel.close(); setTimeout(startCircle, 120); });

// tažení bubliny podle polohy kurzoru (ne sčítáním posunů – to na Windows s měřítkem ujíždí a zvětšuje okno)
ipcMain.on("bubble-drag", (_e, phase) => {
  if (!bubble) return;
  const c = screen.getCursorScreenPoint();
  if (phase === "start") { const b = bubble.getBounds(); drag = { dx: c.x - b.x, dy: c.y - b.y }; return; }
  if (phase === "end") { drag = null; keepBubbleOnScreen(); return; }
  if (!drag) return;
  placeBubble(c.x - drag.dx, c.y - drag.dy);
});
ipcMain.on("bubble-move", (_e, dx, dy) => { if (!bubble) return; const b = bubble.getBounds(); placeBubble(b.x + dx, b.y + dy); clearTimeout(bubble._kt); bubble._kt = setTimeout(keepBubbleOnScreen, 400); });
ipcMain.on("bubble-click", () => { if (screenTalk.on) return stopScreenTalk(); startCircle(); });
ipcMain.on("bubble-off", () => {
  bubbleOff = true; if (bubble) bubble.hide(); buddySync();
  const cs = lang.ui === "cs";
  try { new Notification({ title: "Loopnote", body: cs ? "Bublina je schovaná. Vrátí se, když znovu otevřeš Loopnote (ikona u hodin)." : "Bubble hidden. It comes back when you open Loopnote again (icon near the clock)." }).show(); } catch (e) { /* nic */ }
});

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, "build", "tray.png")).resize({ width: 18, height: 18 });
  tray = new Tray(img);
  tray.setToolTip("Loopnote");
  updateTray();
  tray.on("click", () => { showBubble(); showMain(); });
}
function updateTray() {
  if (!tray) return;
  const cs = lang.ui === "cs";
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Loopnote", click: () => { showBubble(); showMain(); } },
    { label: "Circle on screen (Ctrl+Shift+L)", click: () => startCircle() },
    { label: "Talk (Ctrl+Shift+Space)", click: () => startTalk() },
    { label: "Show bubble", click: showBubble },
    { type: "separator" },
    { label: cs ? "Mluvení: jen hlas a kreslení na obrazovku" : "Talking: voice + drawing on screen", type: "radio", checked: lang.mode === "screen", click: () => setMode("screen") },
    { label: cs ? "Mluvení: s okénkem" : "Talking: with a panel", type: "radio", checked: lang.mode !== "screen", click: () => setMode("panel") },
    { type: "separator" },
    { label: cs ? "Kamarád u kurzoru" : "Cursor buddy", type: "checkbox", checked: lang.buddy !== "off", click: (it) => { lang.buddy = it.checked ? "always" : "off"; toMain("set-pref", { buddy: lang.buddy }); buddySync(); } },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]));
}
function setMode(m) { lang.mode = m; toMain("set-pref", { deskTalk: m }); updateTray(); }

app.whenReady().then(() => {
  allowMedia();
  createMain(true);
  showBubble();
  createTray();
  globalShortcut.register("CommandOrControl+Shift+L", () => startCircle());
  try { globalShortcut.register("CommandOrControl+Shift+Space", () => startTalk()); } catch (e) { console.error(e); }
  app.on("activate", () => { showBubble(); showMain(); });
  screen.on("display-removed", keepBubbleOnScreen);
  screen.on("display-metrics-changed", keepBubbleOnScreen);
  if (process.env.LOOPNOTE_TEST_HOOK) require(process.env.LOOPNOTE_TEST_HOOK)({ startCircle, startTalk, get win() { return win; }, get panel() { return panel; }, get overlay() { return overlay; }, get bubble() { return bubble; } });
});
app.on("before-quit", () => { quitting = true; });
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => { /* běží dál v liště */ });
