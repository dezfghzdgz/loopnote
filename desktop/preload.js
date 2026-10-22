// Most mezi okny a hlavním procesem (bezpečně přes contextBridge).
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("loopnoteDesktop", {
  // hlavní okno (appka)
  onImage: (cb) => ipcRenderer.on("circle-image", (_e, d) => cb(d)),
  onCaptureFailed: (cb) => ipcRenderer.on("capture-failed", () => cb()),
  onExplain: (cb) => ipcRenderer.on("explain", (_e, req) => cb(req)),
  explainResult: (res) => ipcRenderer.send("explain-result", res),
  hello: (l) => ipcRenderer.send("hello", l),
  capture: () => ipcRenderer.send("bubble-click"),
  // bublina
  bubbleMove: (dx, dy) => ipcRenderer.send("bubble-move", dx, dy),
  bubbleClick: () => ipcRenderer.send("bubble-click"),
  bubbleOff: () => ipcRenderer.send("bubble-off"),
  // kroužkování na živé obrazovce
  overlayDone: (rect) => ipcRenderer.send("overlay-done", rect),
  // okénko s odpovědí
  onPanelInit: (cb) => ipcRenderer.on("panel-init", (_e, d) => cb(d)),
  onAnswer: (cb) => ipcRenderer.on("panel-answer", (_e, d) => cb(d)),
  ask: (req) => ipcRenderer.send("panel-ask", req),
  save: (d) => ipcRenderer.send("panel-save", d),
  close: () => ipcRenderer.send("panel-close"),
  again: () => ipcRenderer.send("panel-again"),
});
