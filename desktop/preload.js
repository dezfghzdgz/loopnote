// Most mezi okny a hlavním procesem (bezpečně přes contextBridge).
const { contextBridge, ipcRenderer } = require("electron");
const on = (ch, cb) => ipcRenderer.on(ch, (_e, d) => cb(d));
contextBridge.exposeInMainWorld("loopnoteDesktop", {
  // hlavní okno (appka): vysvětlení, rozhovor, hlas, otevření sešitu
  onImage: (cb) => on("circle-image", cb),
  onCaptureFailed: (cb) => on("capture-failed", cb),
  onExplain: (cb) => on("explain", cb),
  explainResult: (res) => ipcRenderer.send("explain-result", res),
  explainPartial: (res) => ipcRenderer.send("explain-partial", res),
  onTalk: (cb) => on("talk", cb),
  talkEvent: (ev) => ipcRenderer.send("talk-event", ev),
  onSpeak: (cb) => on("speak", cb),
  onOpenNb: (cb) => on("open-nb", cb),
  hello: (l) => ipcRenderer.send("hello", l),
  onSetPref: (cb) => on("set-pref", cb),
  screenShot: () => ipcRenderer.invoke("screen-shot"),
  draw: (d) => ipcRenderer.send("draw", d),
  drawClear: (slow) => ipcRenderer.send("draw-clear", slow),
  onAnnot: (cb) => on("annot", cb),
  capture: () => ipcRenderer.send("bubble-click"),
  // bublina
  bubbleMove: (dx, dy) => ipcRenderer.send("bubble-move", dx, dy),
  bubbleDrag: (phase) => ipcRenderer.send("bubble-drag", phase),
  bubbleClick: () => ipcRenderer.send("bubble-click"),
  bubbleTalk: () => ipcRenderer.send("bubble-talk"),
  bubbleOff: () => ipcRenderer.send("bubble-off"),
  onBubbleState: (cb) => on("bubble-state", cb),
  // kroužkování na živé obrazovce
  overlayDone: (rect) => ipcRenderer.send("overlay-done", rect),
  overlayTalk: () => ipcRenderer.send("overlay-talk"),
  // okénko s odpovědí
  onPanelInit: (cb) => on("panel-init", cb),
  onAnswer: (cb) => on("panel-answer", cb),
  onPartial: (cb) => on("panel-partial", cb),
  onTalkEvent: (cb) => on("talk-event", cb),
  ask: (req) => ipcRenderer.send("panel-ask", req),
  talk: (req) => ipcRenderer.send("panel-talk", req),
  speak: (req) => ipcRenderer.send("panel-speak", req),
  openNb: (req) => ipcRenderer.send("panel-open-nb", req),
  save: (d) => ipcRenderer.send("panel-save", d),
  close: () => ipcRenderer.send("panel-close"),
  again: () => ipcRenderer.send("panel-again"),
});
