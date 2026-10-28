// tinykeemap (キーマップの表示・変更・保存)
// 仕様: docs/protocol.md (Draft v1, proto=1)
// keycode の名前の表・入力の解釈は keycodes.js(先に読み込む)
//
// 構成(上から順に、下の層は上の層を知らない):
//   1. SerialLineTransport … WebSerial で「1行送る / 1行受け取る」だけ(USBの都合はここに閉じ込める)
//   2. protocol … 1行の文字列 ⇔ コマンドの結果 の変換
//   3. 画面 … ボタン・表・編集欄・ログの表示

"use strict";

/* ------------------------------------------------------------------ */
/* 1. 行の送受信 (WebSerial)                                            */
/* ------------------------------------------------------------------ */

class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "TimeoutError";
  }
}

// タイムアウトのあと、遅れて届く応答も待ったが、来なかった
class SyncBrokenError extends Error {
  constructor(message) {
    super(message);
    this.name = "SyncBrokenError";
  }
}

// タイムアウトしたコマンドの応答が遅れて届くかもしれないので、このぶん待つ(ミリ秒)
const LATE_GRACE_MS = 5000;

class SerialLineTransport {
  // callbacks: { onDebug(line), onStray(line), onLate(line), onBroken(), onClosed(errorOrNull) }
  constructor(port, callbacks) {
    this.port = port;
    this.cb = callbacks;
    this.buffer = "";
    this.waiter = null; // 応答待ちの { resolve, reject, timer }
    this.reader = null;
    this.writer = null;
    this.readLoopDone = null;
    this.closing = false;
    this.closedNotified = false;
    // 応答のずれを防ぐための状態
    //   "ready"  … 通常。次のコマンドを送ってよい
    //   "late"   … タイムアウトした。前のコマンドの応答が遅れて届くかもしれないので、次は送らない
    //   "broken" … 待っても届かなかった。接続し直すまで、コマンドは送れない
    this.syncState = "ready";
    this.lateTimer = null;
    this.readyWaiters = []; // whenReady() で待っている { resolve, reject }
  }

  async open() {
    // USB CDC ではボーレートは実際の速度に影響しないが、指定は必須
    await this.port.open({ baudRate: 115200 });
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.readLoopDone = this._readLoop();
  }

  async _readLoop() {
    const decoder = new TextDecoder();
    let error = null;
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        this._drainBuffer();
      }
    } catch (e) {
      error = e; // ケーブルを抜いた場合などはここに来る
    } finally {
      try { this.reader.releaseLock(); } catch (_) { /* 無視 */ }
      this._notifyClosed(this.closing ? null : error || new Error("接続が閉じられました"));
    }
  }

  // \n と \r のどちらも行末として扱い、空の行は無視する(ファーム側と同じ扱い)
  _drainBuffer() {
    for (;;) {
      const i = this.buffer.search(/[\r\n]/);
      if (i < 0) return;
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      if (line === "") continue;
      this._onLine(line);
    }
  }

  _onLine(line) {
    // "# " で始まる行はデバッグ出力。応答ではないので無視する(ログにだけ出す)
    if (line.startsWith("# ")) {
      this.cb.onDebug(line);
      return;
    }
    if (this.syncState === "late") {
      // タイムアウトした前のコマンドの応答が、遅れて届いた。
      // 次のコマンドの応答と取り違えないよう、捨てる
      this._setSyncState("ready");
      this.cb.onLate(line);
      return;
    }
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      clearTimeout(w.timer);
      w.resolve(line);
    } else {
      this.cb.onStray(line); // 待っていないのに届いた行
    }
  }

  _setSyncState(next) {
    this.syncState = next;
    if (next !== "late" && this.lateTimer) {
      clearTimeout(this.lateTimer);
      this.lateTimer = null;
    }
    if (next === "ready" || next === "broken") {
      const waiters = this.readyWaiters;
      this.readyWaiters = [];
      for (const w of waiters) {
        if (next === "ready") w.resolve();
        else w.reject(new SyncBrokenError("デバイスから応答がありません"));
      }
    }
  }

  // タイムアウトした。遅れて届く応答を LATE_GRACE_MS だけ待つ
  _enterLate() {
    if (this.closing || this.closedNotified) return;
    this._setSyncState("late");
    this.lateTimer = setTimeout(() => {
      this.lateTimer = null;
      this._setSyncState("broken");
      this.cb.onBroken();
    }, LATE_GRACE_MS);
  }

  _notifyClosed(err) {
    if (this.closedNotified) return;
    this.closedNotified = true;
    if (this.lateTimer) {
      clearTimeout(this.lateTimer);
      this.lateTimer = null;
    }
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w.reject(new Error("接続が切れました"));
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      clearTimeout(w.timer);
      w.reject(new Error("接続が切れました"));
    }
    this.cb.onClosed(err);
  }

  async writeLine(text) {
    await this.writer.write(new TextEncoder().encode(text + "\n"));
  }

  // 次のコマンドを送ってよい状態になるまで待つ(遅れた応答が届くまで。待っても来なければ失敗)
  whenReady() {
    if (this.syncState === "ready") return Promise.resolve();
    if (this.syncState === "broken") return Promise.reject(new SyncBrokenError("デバイスから応答がありません"));
    return new Promise((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
  }

  // 次の1行(デバッグ行を除く)を待つ
  readLine(timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.waiter) {
        reject(new Error("内部エラー: 同時に2つの応答は待てません"));
        return;
      }
      const timer = setTimeout(() => {
        this.waiter = null;
        this._enterLate(); // 応答が遅れて届くかもしれない。しばらく次のコマンドを送らない
        reject(new TimeoutError("応答が " + timeoutMs + "ms 以内に返りませんでした"));
      }, timeoutMs);
      this.waiter = { resolve, reject, timer };
    });
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    try { if (this.reader) await this.reader.cancel(); } catch (_) { /* 無視 */ }
    try { if (this.readLoopDone) await this.readLoopDone; } catch (_) { /* 無視 */ }
    try { if (this.writer) this.writer.releaseLock(); } catch (_) { /* 無視 */ }
    try { await this.port.close(); } catch (_) { /* 既に閉じている場合など */ }
    this._notifyClosed(null);
  }
}

/* ------------------------------------------------------------------ */
/* 2. プロトコル                                                        */
/* ------------------------------------------------------------------ */

class ProtocolError extends Error {
  // code: "BADCMD" など。応答が壊れているときは "BADRESP"
  constructor(code, message) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

// protocol.md §3: 通常のコマンドは1秒、SAVE は2秒以上(余裕を見て3秒)
const DEFAULT_TIMEOUT_MS = 1000;
const SAVE_TIMEOUT_MS = 3000;

function timeoutFor(command) {
  const name = command.split(" ")[0];
  return name === "SAVE" ? SAVE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

// 1行の応答を { data } にする。ERR なら ProtocolError を投げる
function parseResponse(line) {
  if (line === "OK") return { data: "" };
  if (line.startsWith("OK ")) return { data: line.slice(3).trim() };
  if (line === "ERR" || line.startsWith("ERR ")) {
    const rest = line.slice(3).trim();
    const sp = rest.indexOf(" ");
    const code = sp < 0 ? rest : rest.slice(0, sp);
    const msg = sp < 0 ? "" : rest.slice(sp + 1).trim();
    throw new ProtocolError(code || "UNKNOWN", msg);
  }
  throw new ProtocolError("BADRESP", "OK でも ERR でもない応答です: " + line);
}

// "name=takoyaki8 proto=1 ..." → { name: "takoyaki8", proto: "1", ... } (知らないキーもそのまま持つ)
function parseInfoData(data) {
  const out = {};
  for (const token of data.split(/\s+/)) {
    if (!token) continue;
    const eq = token.indexOf("=");
    if (eq <= 0) continue; // key=value の形でないものは無視
    out[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return out;
}

function toPositiveInt(obj, key) {
  const v = obj[key];
  if (v === undefined || !/^[0-9]+$/.test(v) || Number(v) < 1) {
    throw new ProtocolError("BADRESP", "INFO の " + key + " が正しくありません: " + (v === undefined ? "(なし)" : v));
  }
  return Number(v);
}

function normalizeInfo(raw) {
  return {
    name: raw.name || "(不明)",
    proto: toPositiveInt(raw, "proto"),
    fw: raw.fw || "(不明)",
    keys: toPositiveInt(raw, "keys"),
    rows: toPositiveInt(raw, "rows"),
    cols: toPositiveInt(raw, "cols"),
    layers: toPositiveInt(raw, "layers"),
  };
}

// "0x0004 0x0005 ..." → [4, 5, ...]
function parseDumpData(data, expectedKeys) {
  const tokens = data.split(/\s+/).filter(Boolean);
  if (tokens.length !== expectedKeys) {
    throw new ProtocolError("BADRESP", "DUMP のキー数が違います (期待 " + expectedKeys + " / 実際 " + tokens.length + ")");
  }
  return tokens.map((t) => {
    if (!/^0x[0-9a-fA-F]{1,4}$/.test(t)) {
      throw new ProtocolError("BADRESP", "keycode の形式が正しくありません: " + t);
    }
    return parseInt(t, 16);
  });
}

function hex4(n) {
  return "0x" + n.toString(16).toUpperCase().padStart(4, "0");
}

/* ------------------------------------------------------------------ */
/* 3. 画面                                                              */
/* ------------------------------------------------------------------ */

const els = {
  connect: document.getElementById("btn-connect"),
  reload: document.getElementById("menu-reload"),
  disconnect: document.getElementById("menu-disconnect"),
  status: document.getElementById("status"),
  statusDot: document.getElementById("status-dot"),
  error: document.getElementById("error"),
  detail: document.getElementById("detail"),
  info: document.getElementById("info"),
  btnMenu: document.getElementById("btn-menu"),
  menu: document.getElementById("menu"),
  menuReset: document.getElementById("menu-reset"),
  menuDetail: document.getElementById("menu-detail"),
  menuLayout: document.getElementById("menu-layout"),
  menuLayoutClear: document.getElementById("menu-layout-clear"),
  layoutFile: document.getElementById("layout-file"),
  resetConfirm: document.getElementById("reset-confirm"),
  resetConfirmText: document.getElementById("reset-confirm-text"),
  resetCancel: document.getElementById("reset-cancel"),
  resetOk: document.getElementById("reset-ok"),
  keymapPanel: document.getElementById("keymap-panel"),
  keymap: document.getElementById("keymap"),
  layerTabs: document.getElementById("layer-tabs"),
  editPanel: document.getElementById("edit-panel"),
  editTitle: document.getElementById("edit-title"),
  btnDeselect: document.getElementById("btn-deselect"),
  cardBody: document.getElementById("card-body"),
  cardCap: document.getElementById("card-cap"),
  cardName: document.getElementById("card-name"),
  editPick: document.getElementById("edit-pick"),
  kindKey: document.getElementById("kind-key"),
  kindLayer: document.getElementById("kind-layer"),
  pickKey: document.getElementById("pick-key"),
  kcSearch: document.getElementById("kc-search"),
  kcCats: document.getElementById("kc-cats"),
  kcGrid: document.getElementById("kc-grid"),
  kcAfter: document.getElementById("kc-after"),
  kcHex: document.getElementById("kc-hex"),
  kcPreview: document.getElementById("kc-preview"),
  btnSet: document.getElementById("btn-set"),
  editMsg: document.getElementById("edit-msg"),
  btnSave: document.getElementById("btn-save"),
  btnLoad: document.getElementById("btn-load"),
  dirtyBadge: document.getElementById("dirty-badge"),
  saveMsg: document.getElementById("save-msg"),
  log: document.getElementById("log"),
};

let transport = null; // 接続中の SerialLineTransport
let busy = false; // 読み込み中は次の操作を受け付けない
let currentPort = null;
// 画面に出しているキーマップ。{ info, codes[layer][index], caps[layer][index](マスの部品), selected: {layer, index} | null }
let model = null;
// 「保存済み(Flash と同じ)」とみなしている keycode の写し[layer][index]。
// ツールは Flash の中身を読めないので、接続したときの内容、または最後に保存・読み直したときの内容とする。
// これと画面の内容との違いが「未保存の変更」。再読み込みでは変えない。接続し直すと作り直す
let baseline = null;
// SAVE / LOAD / RESET がタイムアウトしたあと、遅れて届いた応答の行を受け取る入れ物
let lateCapture = null;

function setStatus(kind, text) {
  els.status.className = "status status-" + kind;
  els.status.textContent = text;
  els.statusDot.className = "dot dot-" + kind;
}

function showError(message, isWarning) {
  els.error.textContent = message;
  els.error.className = "error" + (isWarning ? " warn" : "");
  els.error.hidden = false;
}

function clearError() {
  els.error.hidden = true;
  els.error.textContent = "";
}

function log(kind, text) {
  const span = document.createElement("span");
  span.className = kind;
  span.textContent = text + "\n";
  els.log.appendChild(span);
  while (els.log.childNodes.length > 300) els.log.removeChild(els.log.firstChild);
  els.log.scrollTop = els.log.scrollHeight;
}

function updateButtons() {
  const connected = transport !== null;
  const broken = connected && transport.syncState === "broken"; // 応答が途絶えた。接続し直すまで操作できない
  els.connect.hidden = connected; // 接続中は、上の1行に出さない(切断は「…」メニュー)
  els.connect.disabled = connected || busy;
  els.reload.disabled = !connected || busy || broken;
  els.disconnect.disabled = !connected;
  updateEditControls();
  updateSaveControls();
}

// 編集・保存の操作は、キーマップを表示していて、通信中でも応答なしでもないときだけできる
function canOperate() {
  return transport !== null && !busy && model !== null && transport.syncState !== "broken";
}

function updateSaveControls() {
  const usable = canOperate();
  els.btnSave.disabled = !usable;
  els.menuLayout.disabled = !usable;
  els.menuLayoutClear.hidden = !(model !== null && model.custom !== null);
  els.menuLayoutClear.disabled = !usable;
  els.btnLoad.disabled = !usable;
  els.menuReset.disabled = !usable;
}

function updateEditControls() {
  const usable = canOperate();
  els.editPick.querySelectorAll("button, input").forEach((el) => { el.disabled = !usable; });
  els.kcHex.disabled = !usable;
  els.btnSet.disabled = !(usable && model.selected !== null);
}

function clearResults() {
  closePopups();
  els.keymapPanel.hidden = true;
  els.editPanel.hidden = true;
  els.info.replaceChildren();
  els.keymap.replaceChildren();
  els.layerTabs.querySelectorAll(".tab").forEach((t) => t.remove());
  model = null;
  setDeviceLayers(0); // 接続していない間は、レイヤー数が分からない
  renderPicker();
  els.kcHex.value = "";
  updatePreview();
  clearEditMessage();
  clearSaveMessage();
  refreshDirtyMarks();
}

// コマンドを1つ送り、応答が返るまで待つ(リクエスト/レスポンス方式)。
// 呼び出しは待ち行列に入り、必ず1つずつ順番に実行される
let requestQueueTail = Promise.resolve();

function request(command, timeoutMs) {
  const result = requestQueueTail.then(() => doRequest(command, timeoutMs));
  requestQueueTail = result.catch(() => { /* 失敗しても次の呼び出しは実行する */ });
  return result;
}

async function doRequest(command, timeoutMs) {
  if (!transport) throw new Error("接続されていません");
  const t = transport;

  // 前のコマンドがタイムアウトしていたら、遅れた応答が届くまで待つ(応答の取り違えを防ぐ)
  if (t.syncState !== "ready") {
    setStatus("busy", "遅れた応答を待っています…");
    log("dbg", "(前のコマンドの遅れた応答を待っています)");
  }
  await t.whenReady();
  if (transport !== t) throw new Error("接続が切れました");

  log("tx", "> " + command);
  await t.writeLine(command);
  let line;
  try {
    line = await t.readLine(timeoutMs || timeoutFor(command));
  } catch (e) {
    log("bad", "! " + e.message);
    throw e;
  }
  log("rx", "< " + line);
  return parseResponse(line);
}

function renderInfo(info, rawInfo, layoutResult) {
  els.info.replaceChildren();
  const rows = [
    ["機種名 (name)", info.name],
    ["プロトコル (proto)", String(info.proto)],
    ["ファーム (fw)", info.fw],
    ["キー数 (keys)", String(info.keys)],
    ["行 × 列 (rows × cols)", info.rows + " × " + info.cols],
    ["レイヤー数 (layers)", String(info.layers)],
    ["機種定義 (配列)", describeLayout(layoutResult)],
  ];
  // 知らないキーも、将来の確認用にそのまま表示する
  const known = new Set(["name", "proto", "fw", "keys", "rows", "cols", "layers"]);
  for (const k of Object.keys(rawInfo)) {
    if (!known.has(k)) rows.push([k, rawInfo[k]]);
  }
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    els.info.append(dt, dd);
  }
}

// マスの下に添える注釈(名前など)
function capNote(code) {
  if (code === 0x0000) return "何もしない";
  if (code === 0x0001) return "透過";
  const k = findKeycode(code);
  if (!k) return "(一覧にない値)";
  if (k.cap) return k.cap; // 修飾キー付きは「Shift+A」のように短く
  // レイヤー切り替えは、表示名が長いので、MO(1) のような名前を出す
  if (k.group === "layer") return k.warn ? k.name + "(範囲外)" : k.name;
  // ふつうのキーは、F11 や ← のような読みやすい表示名を出す(修飾キー付きと同じ表示にそろえる)
  return k.label;
}

// ---- キーの絵(マスの大きさと並べ方) ----

// 1u(キー1つぶん)の大きさ。機種の幅と画面の幅から、40〜80px の間で決める
const UNIT_MIN = 40;
const UNIT_MAX = 80;
// いまの大きさと、それに合わせた表示の形(小さいときは、番号を隠し、1行にまとめる)
const stage = { u: 0, pad: 2, two: true, showIdx: true, mainSize: 17 };

function setStageMetrics(u) {
  stage.u = u;
  stage.pad = Math.max(2, Math.round(u * 0.045));
  stage.two = u >= 56; // 2段(上に小さく修飾キー、下に大きくキー名)
  stage.showIdx = u >= 64; // 左上の index
  stage.mainSize = u >= 64 ? 17 : (u >= 50 ? 14 : 12);
}

function computeUnit() {
  const w = els.keymap.clientWidth;
  const lw = model && model.layout ? model.layout.width : 0;
  if (!w || !lw) return UNIT_MAX;
  return Math.max(UNIT_MIN, Math.min(UNIT_MAX, Math.floor(w / lw)));
}

function setStageSize(box) {
  box.style.width = model.layout.width * stage.u + "px";
  box.style.height = model.layout.height * stage.u + "px";
}

function setCapGeometry(cap, p) {
  cap.style.left = p.x * stage.u + stage.pad + "px";
  cap.style.top = p.y * stage.u + stage.pad + "px";
  cap.style.width = p.w * stage.u - 2 * stage.pad + "px";
  cap.style.height = p.h * stage.u - 2 * stage.pad + "px";
}

// 文字がマスの幅に収まる大きさ(最大 maxPx、最小 9px)。半角は 0.6 文字ぶん、それ以外は 1 文字ぶんとして数える
function fitFontSize(text, maxPx, capWidth) {
  let units = 0;
  for (const ch of text) units += ch.charCodeAt(0) < 0x250 ? 0.6 : 1;
  if (units === 0) return maxPx;
  return Math.max(9, Math.min(maxPx, Math.floor((capWidth - 8) / units)));
}

// マス1つの中身(index・短い名前)を作り直す。最初の表示と、SET のあとの更新の両方で使う
// 16進は出さない(マスにカーソルを載せたときの title と、読み上げの文にだけ入れる)
function fillCap(cap, layerIndex, index, code) {
  const face = capFace(code, !stage.two);
  cap.replaceChildren();
  cap.classList.toggle("none", face.kind === "none");
  cap.classList.toggle("trans", face.kind === "trans");
  if (stage.showIdx) {
    const idx = document.createElement("span");
    idx.className = "idx";
    idx.setAttribute("aria-hidden", "true");
    idx.textContent = String(index);
    cap.append(idx);
  }
  if (face.small !== "") {
    const small = document.createElement("span");
    small.className = "small";
    small.textContent = face.small;
    cap.append(small);
  }
  const main = document.createElement("span");
  main.className = "main";
  const p = model.layout.layout[index];
  main.style.fontSize = fitFontSize(face.main, face.kind === "normal" ? stage.mainSize : 12, p.w * stage.u - 2 * stage.pad) + "px";
  main.textContent = face.main;
  cap.append(main);
  cap.dataset.title = hex4(code) + "  " + capNote(code);
  cap.title = cap.dataset.title;
  cap.dataset.label = "レイヤー " + layerIndex + " キー " + index + ": " + capNote(code);
  cap.setAttribute("aria-label", cap.dataset.label);
}

function renderLayer(layerIndex, codes, info) {
  const section = document.createElement("div");
  section.className = "layer";
  section.hidden = layerIndex !== model.current; // 絵に出すのは、いま選んでいるレイヤーだけ
  model.sections[layerIndex] = section;

  // 機種定義(resolveLayout の結果)の位置と幅で、マスを並べる。位置がない index(null)には、マスを作らない
  const wrap = document.createElement("div");
  wrap.className = "stage-wrap";
  const box = document.createElement("div");
  box.className = "stage";
  setStageSize(box);

  model.caps[layerIndex] = [];
  model.stages[layerIndex] = box;
  codes.forEach((code, index) => {
    const p = model.layout.layout[index];
    if (!p) {
      model.caps[layerIndex].push(null);
      return;
    }
    const cap = document.createElement("button");
    cap.type = "button";
    cap.className = "cap";
    cap.setAttribute("aria-pressed", "false");
    cap.addEventListener("click", () => selectKey(layerIndex, index));
    setCapGeometry(cap, p);
    fillCap(cap, layerIndex, index, code);
    box.appendChild(cap);
    model.caps[layerIndex].push(cap);
  });

  wrap.appendChild(box);
  section.appendChild(wrap);
  els.keymap.appendChild(section);
}

// 画面の幅が変わったとき、マスの大きさと表示の形を合わせ直す
let relayoutQueued = false;
function relayoutStage() {
  if (!model || model.caps.length === 0 || relayoutQueued) return;
  relayoutQueued = true;
  requestAnimationFrame(() => {
    relayoutQueued = false;
    if (!model) return;
    const u = computeUnit();
    if (u === stage.u) return;
    setStageMetrics(u);
    model.caps.forEach((row, l) => {
      setStageSize(model.stages[l]);
      row.forEach((cap, i) => {
        if (!cap) return;
        setCapGeometry(cap, model.layout.layout[i]);
        fillCap(cap, l, i, model.codes[l][i]);
      });
    });
    refreshDirtyMarks();
  });
}

// INFO → 全レイヤーの DUMP を順に読んで表示する
async function loadAll() {
  busy = true;
  updateButtons();
  clearError();
  clearResults();
  setStatus("busy", "読み込み中…");
  try {
    const rawInfoResp = await request("INFO");
    const rawInfo = parseInfoData(rawInfoResp.data);
    const info = normalizeInfo(rawInfo);
    // 機種定義(キーの位置と幅、既定のレイヤー名)を探して、マスの並びに使う
    const custom = findCustomLayout(info.name);
    const layoutResult = resolveLayout(info, findDeviceDef(info.name), custom);
    renderInfo(info, rawInfo, layoutResult);
    // レイヤー切り替え(MO(n) / TG(n) / TO(n))の一覧を、このデバイスのレイヤー数に合わせて作り直す
    setDeviceLayers(info.layers);
    renderPicker();

    const warnings = [];
    if (info.proto !== 1) {
      warnings.push("このツールは proto=1 用です。デバイスは proto=" + info.proto + " なので、正しく表示できない可能性があります。");
    }
    if (info.rows * info.cols !== info.keys && layoutResult.source === "grid") {
      warnings.push("rows × cols (" + info.rows * info.cols + ") が keys (" + info.keys + ") と一致しないため、1行に並べて表示します。");
    }

    warnings.push(...layoutResult.warnings);

    model = { info, codes: [], caps: [], stages: [], sections: [], tabs: null, current: 0, layout: layoutResult, custom, selected: null };
    els.keymapPanel.hidden = false;
    setStageMetrics(computeUnit());
    for (let layer = 0; layer < info.layers; layer++) {
      const resp = await request("DUMP " + layer);
      const codes = parseDumpData(resp.data, info.keys);
      model.codes[layer] = codes;
      renderLayer(layer, codes, info);
    }
    buildTabs();
    // 最初の読み込みでは、今の内容を「保存済み」とみなす。再読み込みでは、前の基準を保つ
    if (!baselineFits(model.codes)) baseline = copyCodes(model.codes);
    refreshDirtyMarks();
    els.editPanel.hidden = false;

    setStatus("on", "接続中 (" + info.name + ")");
    if (warnings.length > 0) showError(warnings.join("\n"), true);
  } catch (e) {
    if (transport === null) return; // 切断が原因のときは onClosed 側で表示済み
    model = null; // 途中までしか読めていないキーマップは、編集させない
    els.editPanel.hidden = true;
    setStatus("err", e instanceof SyncBrokenError ? "応答なし" : "読み込み失敗");
    showError(describeError(e));
  } finally {
    busy = false;
    updateButtons();
  }
}

/* ---- キーの編集 ---- */

function showEditMessage(kind, text) {
  els.editMsg.className = "edit-msg " + kind; // kind: ok / fail / info
  els.editMsg.textContent = text;
  els.editMsg.hidden = false;
}

function clearEditMessage() {
  els.editMsg.hidden = true;
  els.editMsg.textContent = "";
}

// 選ぶ欄の状態(種類のタブと、カテゴリ)
let pickKind = "key"; // "key" | "layer"
let pickCat = "basic";

// 選ぶ欄(種類のタブ、カテゴリ、キーのボタンの一覧)を作り直す
//   名前の検索に文字があるときは、カテゴリに関係なく、当てはまるキーをすべて出す
function renderPicker() {
  const usable = canOperate();
  const searching = pickKind === "key" && els.kcSearch.value.trim() !== "";
  for (const [btn, kind] of [[els.kindKey, "key"], [els.kindLayer, "layer"]]) {
    btn.classList.toggle("active", pickKind === kind);
    btn.setAttribute("aria-pressed", pickKind === kind ? "true" : "false");
  }
  els.pickKey.hidden = pickKind !== "key";
  els.kcCats.replaceChildren();
  for (const c of KEY_CATEGORIES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cat";
    btn.dataset.cat = c.id;
    btn.textContent = c.title;
    const on = !searching && pickCat === c.id;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.disabled = !usable;
    els.kcCats.appendChild(btn);
  }
  let list;
  if (pickKind === "layer") list = layerKeycodes();
  else if (searching) list = searchKeycodes(els.kcSearch.value);
  else list = KEYCODES.filter((k) => keyCategory(k) === pickCat);
  els.kcGrid.replaceChildren();
  if (list.length === 0) {
    const p = document.createElement("p");
    p.className = "kgrid-empty";
    p.textContent = pickKind === "layer" ? "接続すると、ここに出ます。" : "当てはまるキーがありません。";
    els.kcGrid.appendChild(p);
  }
  for (const k of list) {
    const face = capFace(k.code, false);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "kb";
    btn.dataset.code = String(k.code);
    btn.title = k.label + (k.warn ? "(" + k.warn + ")" : "");
    btn.disabled = !usable;
    if (face.small !== "") {
      const small = document.createElement("span");
      small.className = "small";
      small.textContent = face.small;
      btn.appendChild(small);
    }
    const main = document.createElement("span");
    main.className = "main";
    main.textContent = face.main;
    btn.appendChild(main);
    els.kcGrid.appendChild(btn);
  }
  markPicked();
}

// 入力欄の keycode と同じボタンに、印を付ける
function markPicked() {
  const p = parseKeycodeText(els.kcHex.value);
  const code = p.ok ? p.code : null;
  els.kcGrid.querySelectorAll(".kb").forEach((b) => {
    const on = code !== null && Number(b.dataset.code) === code;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

// 選んだマスの keycode に合わせて、種類のタブとカテゴリを切り替える(名前の検索は空にする)
function syncPickerTo(code) {
  els.kcSearch.value = "";
  if (decodeLayerKey(code)) {
    pickKind = "layer";
  } else {
    pickKind = "key";
    let k = KEYCODE_BY_CODE.get(code);
    if (!k && code >= 0x0100 && code <= 0x1fff) k = KEYCODE_BY_CODE.get(code & 0x00ff); // 修飾キー付きは、中のキーのカテゴリ
    if (k) pickCat = keyCategory(k);
  }
  renderPicker();
}

// 入力欄の内容を読み取って、下に「→ 0x0004 KC_A(A)」のように見せる
function updatePreview() {
  const text = els.kcHex.value;
  els.kcPreview.className = "kc-preview";
  if (text.trim() === "") {
    els.kcPreview.textContent = "";
    els.kcAfter.textContent = "—";
    markPicked();
    return;
  }
  const p = parseKeycodeText(text);
  if (!p.ok) {
    els.kcPreview.textContent = p.reason;
    els.kcPreview.classList.add("bad");
    els.kcAfter.textContent = "—";
    markPicked();
    return;
  }
  const k = findKeycode(p.code);
  els.kcPreview.textContent = "→ " + keycodeHex(p.code) + (k
    ? "  " + k.name + "(" + k.label + ")" + (k.warn ? "  ⚠ " + k.warn : "")
    : "  一覧にない値です。デバイスが対応していなければ、エラーになります");
  els.kcAfter.textContent = k ? k.label : "一覧にない値 " + keycodeHex(p.code);
  markPicked();
}

/* ---- レイヤーのタブ ---- */

function buildTabs() {
  els.layerTabs.querySelectorAll(".tab").forEach((t) => t.remove());
  model.tabs = model.codes.map((_, l) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab";
    const num = document.createElement("span");
    num.className = "tab-num";
    num.textContent = String(l);
    const name = document.createElement("span");
    name.className = "tab-name";
    const dot = document.createElement("span");
    dot.className = "tab-dot";
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", "未保存の変更あり");
    btn.append(num, name, dot);
    btn.addEventListener("click", () => setCurrentLayer(l));
    els.layerTabs.appendChild(btn);
    return { btn, name, dot };
  });
  updateTabs();
}

// 名前と「空」と ● を更新する。名前は機種定義の既定の名前。名前がなくて、中身がすべて「透過」なら「空」
function updateTabs() {
  if (!model || !model.tabs) return;
  const fit = baselineFits(model.codes);
  model.tabs.forEach((t, l) => {
    const codes = model.codes[l];
    const empty = codes.every((c) => c === 0x0001);
    const label = model.layout.layerNames[l] || (empty ? "空" : "");
    const changed = fit && codes.some((c, i) => c !== baseline[l][i]);
    const active = l === model.current;
    t.name.textContent = label;
    t.dot.hidden = !changed;
    t.btn.classList.toggle("active", active);
    t.btn.setAttribute("aria-pressed", active ? "true" : "false");
    t.btn.setAttribute("aria-label", "レイヤー " + l + (label ? " " + label : "") + (changed ? "(未保存の変更あり)" : ""));
  });
}

// 選んでいるキーを、選んでいない状態に戻す(レイヤーを替えるときに使う)
function deselectKey() {
  if (!model) return;
  model.selected = null;
  model.caps.forEach((row) => row.forEach((cap) => {
    if (!cap) return;
    cap.classList.remove("selected", "set-failed");
    cap.setAttribute("aria-pressed", "false");
  }));
  els.kcHex.value = "";
  updateCard();
  updatePreview();
  clearEditMessage();
  updateEditControls();
}

// 左のカード(選んだキー)を、いまの選びに合わせる
function updateCard() {
  const sel = model ? model.selected : null;
  els.cardBody.hidden = sel === null;
  els.editTitle.textContent = sel === null ? "キーを選んでください" : "キー " + sel.index;
  if (sel === null) return;
  const code = model.codes[sel.layer][sel.index];
  // 絵(マスと同じ2段。小さいときの1行にはしない)
  const face = capFace(code, false);
  els.cardCap.replaceChildren();
  els.cardCap.classList.toggle("none", face.kind === "none");
  els.cardCap.classList.toggle("trans", face.kind === "trans");
  if (face.small !== "") {
    const small = document.createElement("span");
    small.className = "small";
    small.textContent = face.small;
    els.cardCap.append(small);
  }
  const main = document.createElement("span");
  main.className = "main";
  main.textContent = face.main;
  els.cardCap.append(main);
  // 名前(16進は出さない。一覧にない値だけ16進)
  const k = findKeycode(code);
  els.cardName.textContent = k ? k.label : "一覧にない値 " + keycodeHex(code);
}

function setCurrentLayer(layer) {
  if (!model || layer === model.current) return;
  deselectKey(); // 別のレイヤーのキーを選んだままにしない
  model.current = layer;
  model.sections.forEach((sec, l) => { sec.hidden = l !== layer; });
  updateTabs();
}

// マスをクリックして選ぶ
function selectKey(layer, index) {
  if (!model || busy || transport === null) return;
  if (model.selected && model.selected.layer === layer && model.selected.index === index) {
    deselectKey(); // 選んでいるマスをもう一度押すと、選びを外す
    return;
  }
  model.selected = { layer, index };
  model.caps.forEach((row, l) => row.forEach((cap, i) => {
    if (!cap) return;
    const on = l === layer && i === index;
    cap.classList.toggle("selected", on);
    cap.classList.remove("set-failed");
    cap.setAttribute("aria-pressed", on ? "true" : "false");
  }));
  els.kcHex.value = hex4(model.codes[layer][index]);
  syncPickerTo(model.codes[layer][index]);
  updateCard();
  updatePreview();
  clearEditMessage();
  updateEditControls();
}

// 1キーの現在の値を、デバイスから読み直す
async function readKey(layer, index) {
  const resp = await request("GET " + layer + " " + index);
  return parseDumpData(resp.data, 1)[0];
}

function keyLabel(code) {
  const k = findKeycode(code);
  return keycodeHex(code) + (k ? "(" + k.name + ")" : "");
}

// 選んだマスに、入力欄の keycode を SET で送る(RAMだけ。Flash は変わらない)
async function applyEdit() {
  if (!model || !model.selected || busy || transport === null) return;
  const { layer, index } = model.selected;
  const where = "レイヤー " + layer + " / キー " + index;
  const cap = model.caps[layer][index];

  const parsed = parseKeycodeText(els.kcHex.value);
  if (!parsed.ok) {
    showEditMessage("fail", parsed.reason);
    return;
  }
  const code = parsed.code;
  if (code === model.codes[layer][index]) {
    showEditMessage("info", where + " は、すでに " + keyLabel(code) + " です(何も送っていません)。");
    return;
  }

  busy = true;
  updateButtons();
  clearEditMessage();
  clearSaveMessage();
  cap.classList.remove("set-failed");
  try {
    await request("SET " + layer + " " + index + " " + hex4(code));
    model.codes[layer][index] = code;
    fillCap(cap, layer, index, code);
    refreshDirtyMarks();
    showEditMessage("ok", where + " を " + keyLabel(code) + " に変更しました。まだ保存していません(「保存する」を押すまで、USBを抜き差しすると元に戻ります)。");
  } catch (e) {
    if (transport === null) return; // 切断が原因のときは onClosed 側で表示済み
    await handleSetError(e, layer, index, code, cap);
  } finally {
    busy = false;
    updateButtons();
  }
}

async function handleSetError(e, layer, index, code, cap) {
  const where = "レイヤー " + layer + " / キー " + index;
  if (e instanceof ProtocolError && e.code !== "BADRESP") {
    cap.classList.add("set-failed");
    const detail = "ERR " + e.code + (e.message ? " " + e.message : "");
    if (e.code === "BADARG") {
      showEditMessage("fail", where + " は変更できませんでした。デバイスが " + keycodeHex(code) + " に対応していません(" + detail + ")。キーマップは変わっていません。");
    } else if (e.code === "RANGE") {
      showEditMessage("fail", where + " は変更できませんでした。デバイスが、レイヤーまたはキー番号を範囲外だと言っています(" + detail + ")。ツールとデバイスの設定が食い違っているので、「…」メニューの「再読み込み」で読み直してください。");
    } else {
      showEditMessage("fail", where + " は変更できませんでした。デバイスがエラーを返しました(" + detail + ")。");
    }
    return;
  }
  if (e instanceof TimeoutError) {
    // 変更が届いたかどうか分からない。遅れた応答が届くのを待ってから、そのキーだけ読み直す
    showEditMessage("info", where + ": 応答が時間内に来ませんでした。変更されたか分からないので、遅れた応答を待って、値を読み直します…");
    try {
      const actual = await readKey(layer, index);
      if (transport === null) return;
      model.codes[layer][index] = actual;
      fillCap(cap, layer, index, actual);
      refreshDirtyMarks();
      if (actual === code) {
        showEditMessage("ok", where + ": 応答は遅れましたが、" + keyLabel(actual) + " に変更されていました。まだ保存していません(「保存する」を押すまで、USBを抜き差しすると元に戻ります)。");
      } else {
        cap.classList.add("set-failed");
        showEditMessage("fail", where + ": 変更は反映されていませんでした。今の値は " + keyLabel(actual) + " です。");
      }
    } catch (e2) {
      if (transport === null) return;
      cap.classList.add("set-failed");
      showEditMessage("fail", where + ": 値を読み直せませんでした。" + describeError(e2));
    }
    return;
  }
  cap.classList.add("set-failed");
  showEditMessage("fail", where + ": " + describeError(e));
}

/* ---- 保存・読み直し・初期化(未保存の変更の管理) ---- */

function copyCodes(codes) {
  return codes.map((row) => row.slice());
}

// 基準(baseline)が、今のキーマップと同じ形(レイヤー数・キー数)なら true
function baselineFits(codes) {
  return baseline !== null && baseline.length === codes.length &&
    baseline.every((row, l) => row.length === codes[l].length);
}

// 保存済みとみなしている内容と違うキーの数
function changedCount() {
  if (!model || !baselineFits(model.codes)) return 0;
  let n = 0;
  model.codes.forEach((row, l) => row.forEach((code, i) => {
    if (code !== baseline[l][i]) n++;
  }));
  return n;
}

// 変更したマスの印(●)と、「未保存の変更: N キー」の表示を更新する
function refreshDirtyMarks() {
  updateTabs();
  updateCard();
  if (!model || !baselineFits(model.codes)) {
    els.dirtyBadge.textContent = "";
    return;
  }
  const n = changedCount();
  model.caps.forEach((row, l) => row.forEach((cap, i) => {
    if (!cap) return;
    const changed = model.codes[l][i] !== baseline[l][i];
    cap.classList.toggle("changed", changed);
    cap.title = (cap.dataset.title || "") + (changed ? "  ・未保存の変更" : "");
    cap.setAttribute("aria-label", (cap.dataset.label || "") + (changed ? "(未保存の変更)" : ""));
  }));
  els.dirtyBadge.textContent = n > 0 ? "● 未保存の変更 " + n : "";
}

function showSaveMessage(kind, text) {
  els.saveMsg.className = "edit-msg " + kind; // kind: ok / fail / info
  els.saveMsg.textContent = text;
  els.saveMsg.hidden = false;
}

function clearSaveMessage() {
  els.saveMsg.hidden = true;
  els.saveMsg.textContent = "";
}

// 全レイヤーを DUMP で読み直す(LOAD / RESET のあと、画面を合わせるために使う)
async function readAllCodes() {
  const codes = [];
  for (let layer = 0; layer < model.info.layers; layer++) {
    const resp = await request("DUMP " + layer);
    codes[layer] = parseDumpData(resp.data, model.info.keys);
  }
  return codes;
}

// 読み直した内容を画面に反映する
function applyCodes(codes) {
  model.codes = codes;
  codes.forEach((row, l) => row.forEach((code, i) => {
    const cap = model.caps[l][i];
    if (!cap) return;
    fillCap(cap, l, i, code);
    cap.classList.remove("set-failed");
  }));
  if (model.selected) {
    els.kcHex.value = hex4(codes[model.selected.layer][model.selected.index]);
    updatePreview();
  }
  refreshDirtyMarks();
}

// タイムアウトのあと、遅れて届いた応答の行を待って返す(待っても来なければ SyncBrokenError)
async function waitLateResponse(t) {
  lateCapture = { line: null };
  try {
    await t.whenReady();
    return lateCapture.line;
  } finally {
    lateCapture = null;
  }
}

// SAVE / LOAD / RESET を送る。タイムアウトしても、遅れて届いた応答を見て結果を判断する。
// 成功したら { late } を返す(late: 応答が遅れた)。ERR なら ProtocolError、応答が来なければ SyncBrokenError を投げる
async function sendStateCommand(command) {
  const t = transport;
  try {
    await request(command);
    return { late: false };
  } catch (e) {
    if (!(e instanceof TimeoutError)) throw e;
    showSaveMessage("info", command + " の応答が時間内に来ませんでした。結果が分からないので、遅れた応答を待っています…");
    const line = await waitLateResponse(t);
    if (line === null) throw new ProtocolError("BADRESP", "遅れた応答を読み取れませんでした");
    parseResponse(line); // ERR ならここで ProtocolError になる
    return { late: true };
  }
}

function showSaveError(cmd, e) {
  const name = { SAVE: "保存", LOAD: "読み直し", RESET: "初期化" }[cmd];
  let msg;
  if (e instanceof ProtocolError && e.code !== "BADRESP") {
    const detail = "ERR " + e.code + (e.message ? " " + e.message : "");
    if (e.code === "FLASH" && cmd === "SAVE") {
      msg = "保存に失敗しました(" + detail + ")。Flash の内容が壊れた可能性があり、次に電源を入れたとき初期キーマップに戻ることがあります。" +
        "今のキーマップはキーボードの RAM に残っていて、そのまま使えます。原因を確認してから、もう一度「保存する」を試してください(自動では再試行しません)。";
    } else if (e.code === "FLASH" && cmd === "LOAD") {
      msg = "読み直せませんでした(" + detail + ")。Flash に有効な保存データがありません。キーボードの内容は変わっていません。";
    } else if (e.code === "BADCMD") {
      msg = "このファームは " + cmd + " に対応していません(" + detail + ")。";
    } else {
      msg = name + "できませんでした。デバイスがエラーを返しました(" + detail + ")。";
    }
  } else if (e instanceof SyncBrokenError) {
    msg = cmd === "SAVE"
      ? "保存できたかどうか分かりません。デバイスから応答がありません。「…」メニューの「切断する」で接続し直して、キーマップを確認し、必要ならもう一度保存してください。"
      : name + "の結果が分かりません。デバイスから応答がありません。「…」メニューの「切断する」で接続し直してください。";
  } else {
    msg = name + "に失敗しました。" + describeError(e) +
      (cmd === "SAVE" ? "" : "\nキーボードの今の内容は「…」メニューの「再読み込み」で確認できます。");
  }
  showSaveMessage("fail", msg);
}

// 今のキーマップを Flash に保存する(1クリックにつき SAVE は1回だけ。自動で繰り返さない)
async function doSave() {
  if (!canOperate()) return;
  if (changedCount() === 0 && !window.confirm(
    "変更はありません(保存済みと同じ内容のはずです)。\nそれでも Flash に書き込みますか?\n\nFlash は書き換え回数に限りがあるので、必要なときだけ保存してください。")) return;
  busy = true;
  updateButtons();
  clearSaveMessage();
  clearEditMessage();
  try {
    const r = await sendStateCommand("SAVE");
    baseline = copyCodes(model.codes);
    refreshDirtyMarks();
    showSaveMessage("ok", (r.late ? "応答は遅れましたが、" : "") + "保存しました。電源を入れ直しても、この内容で起動します。");
  } catch (e) {
    if (transport === null) return; // 切断が原因のときは onClosed 側で表示済み
    showSaveError("SAVE", e);
  } finally {
    busy = false;
    updateButtons();
  }
}

// Flash に保存した内容を読み直す(未保存の変更は破棄される)
async function doLoad() {
  if (!canOperate()) return;
  const n = changedCount();
  if (n > 0 && !window.confirm("未保存の変更が " + n + " キーあります。\n読み直すと、これらの変更は破棄されます。続けますか?")) return;
  busy = true;
  updateButtons();
  clearSaveMessage();
  clearEditMessage();
  try {
    await sendStateCommand("LOAD");
    const codes = await readAllCodes();
    applyCodes(codes);
    baseline = copyCodes(codes);
    refreshDirtyMarks();
    showSaveMessage("ok", "保存済みの内容を読み込みました。");
  } catch (e) {
    if (transport === null) return;
    showSaveError("LOAD", e);
  } finally {
    busy = false;
    updateButtons();
  }
}

// 初期キーマップに戻す(キーボードの RAM だけ。Flash は「保存する」を押すまで変わらない)
async function doReset() {
  if (!canOperate()) return;
  busy = true;
  updateButtons();
  clearSaveMessage();
  clearEditMessage();
  try {
    await sendStateCommand("RESET");
    const codes = await readAllCodes();
    applyCodes(codes);
    showSaveMessage("ok", "初期キーマップに戻しました。まだ保存していません。" +
      (changedCount() > 0 ? "保存済みの内容とは違います。元に戻すには「読み直す」を押してください。" : ""));
  } catch (e) {
    if (transport === null) return;
    showSaveError("RESET", e);
  } finally {
    busy = false;
    updateButtons();
  }
}

function describeError(e) {
  if (e instanceof ProtocolError) {
    if (e.code === "BADRESP") return "応答を読み取れませんでした: " + e.message;
    return "デバイスがエラーを返しました: ERR " + e.code + (e.message ? " " + e.message : "");
  }
  if (e instanceof SyncBrokenError) {
    return "デバイスから応答がありません(遅れて届く応答も約 " + LATE_GRACE_MS / 1000 + " 秒待ちましたが、来ませんでした)。\n" +
      "「…」メニューの「切断する」を押して、もう一度接続してください。";
  }
  if (e instanceof TimeoutError) {
    return e.message + "\n遅れて届く応答を最大約 " + LATE_GRACE_MS / 1000 + " 秒待ちます。そのあとで「…」メニューの「再読み込み」を押してください。\n" +
      "何度も続く場合は、デバイスのファームが USBシリアルのコマンドに対応しているか、debug 出力が有効になっていないか確認してください。";
  }
  return e.message || String(e);
}

function onTransportClosed(err) {
  transport = null;
  busy = false;
  baseline = null;
  lateCapture = null;
  clearResults();
  if (err) {
    setStatus("err", "切断されました");
    showError("接続が切れました: " + (err.message || err));
    log("bad", "! 切断: " + (err.message || err));
  } else {
    setStatus("off", "未接続");
    log("dbg", "(切断しました)");
  }
  updateButtons();
}

// タイムアウトのあと、遅れて応答が届いた。捨てたことをログに残す
function onTransportLate(line) {
  log("bad", "! 遅れて届いた応答を破棄しました: " + line);
  if (lateCapture) lateCapture.line = line; // SAVE などの結果の判断に使う
}

// タイムアウトのあと、待っても応答が届かなかった。接続し直しが必要
function onTransportBroken() {
  log("bad", "! 応答が途絶えました。接続し直してください");
  setStatus("err", "応答なし");
  showError(describeError(new SyncBrokenError("")));
  updateButtons();
}

async function connect() {
  clearError();
  let port;
  try {
    port = await navigator.serial.requestPort();
  } catch (e) {
    if (e && e.name === "NotFoundError") return; // 選択ダイアログを閉じただけ
    showError("ポートを選べませんでした: " + (e.message || e));
    return;
  }

  baseline = null; // 新しい接続では、最初に読み込んだ内容を「保存済み」とみなす
  busy = true;
  updateButtons();
  setStatus("busy", "接続中…");

  const t = new SerialLineTransport(port, {
    onDebug: (line) => log("dbg", line),
    onStray: (line) => log("bad", "? 予期しない行: " + line),
    onLate: onTransportLate,
    onBroken: onTransportBroken,
    onClosed: onTransportClosed,
  });
  try {
    await t.open();
  } catch (e) {
    busy = false;
    setStatus("err", "接続失敗");
    showError(
      "ポートを開けませんでした: " + (e.message || e) +
      "\n他のソフト(picocom など)が同じポートを使っていないか確認してください。"
    );
    updateButtons();
    return;
  }

  transport = t;
  currentPort = port;
  log("dbg", "(接続しました)");
  await loadAll();
}

async function disconnect() {
  if (!transport) return;
  const n = changedCount();
  if (n > 0 && !window.confirm("未保存の変更が " + n + " キーあります。\n切断してもキーボードには残りますが、保存はされません。また、このツールでは「未保存」かどうか分からなくなります。切断しますか?")) return;
  await transport.close();
}

/* ---- 配列を読み込む(KLE の JSON ファイル) ---- */

const LAYOUT_FILE_MAX = 1024 * 1024; // 1MB まで

// 「…」メニューの「配列を読み込む…」: ファイルを選ぶ窓を開く
function askLayoutFile() {
  if (!canOperate()) return;
  els.layoutFile.value = ""; // 同じファイルをもう一度選んでも、change が出るように
  els.layoutFile.click();
}

// 選んだファイルを読んで、このデバイスに合えば使う(合わなければ、何も変えない)
async function onLayoutFileChosen() {
  const file = els.layoutFile.files && els.layoutFile.files[0];
  if (!file || !canOperate()) return;
  clearError();
  const info = model.info;
  let kle;
  try {
    if (file.size > LAYOUT_FILE_MAX) throw new Error("ファイルが大きすぎます(1MB まで)");
    kle = JSON.parse(await file.text());
  } catch (e) {
    showError("配列を読み込めませんでした(" + file.name + "): " + (e instanceof SyntaxError ? "JSON として読めません" : e.message));
    return;
  }
  const checked = checkKle(kle, info);
  if (!checked.ok) {
    showError("配列を使えませんでした(" + file.name + "): " + checked.reason);
    return;
  }
  const { stored } = saveCustomLayout(info.name, kle, file.name);
  await loadAll(); // 並びを作り直す(キーボードの内容と、未保存の変更はそのまま)
  if (model === null) return; // 読み込みに失敗したときは、そちらのエラーを出したまま
  if (stored) {
    showSaveMessage("ok", "配列を読み込みました。次回の接続からも使います。");
  } else {
    showSaveMessage("info", "配列を読み込みました。このページを閉じるまで使えます。\n(localStorageへ保存ができませんでした。次回開く時はもう一度配列を読み込んでください。ブラウザの設定を確認してください。)");
  }
}

// 「読み込んだ配列を消す」
async function clearCustomLayout() {
  if (!canOperate() || model.custom === null) return;
  removeCustomLayout(model.info.name);
  await loadAll();
  if (model !== null) showSaveMessage("ok", "読み込んだ配列を消しました。");
}

/* ---- 上の1行: 「…」メニューと、確認の小窓 ---- */

let detailOpen = false;

function setMenuOpen(open) {
  els.menu.hidden = !open;
  els.btnMenu.setAttribute("aria-expanded", open ? "true" : "false");
}

// メニューと確認の小窓を、どちらも閉じる
function closePopups() {
  setMenuOpen(false);
  els.resetConfirm.hidden = true;
}

// 「デバイス情報・通信ログ」を開く・閉じる
function setDetailOpen(open) {
  detailOpen = open;
  els.detail.hidden = !open;
  els.menuDetail.setAttribute("aria-expanded", open ? "true" : "false");
  els.menuDetail.textContent = open ? "デバイス情報・通信ログを閉じる" : "デバイス情報・通信ログ";
  if (open) els.detail.scrollIntoView({ block: "start" });
}

// 「初期のキーマップに戻す…」: 確認の小窓を出す(RESET を送るのは「戻す」を押したとき)
function askReset() {
  if (!canOperate()) return;
  const n = changedCount();
  els.resetConfirmText.textContent = "「保存する」を押すまでは、キーボードの保存内容は変わりません。" +
    (n > 0 ? "\n未保存の変更 " + n + " キーは、破棄されます。" : "");
  els.resetConfirm.hidden = false;
  els.resetCancel.focus();
}

function initTopBar() {
  els.btnMenu.addEventListener("click", () => {
    const wasOpen = !els.menu.hidden;
    closePopups();
    setMenuOpen(!wasOpen);
  });
  els.menu.addEventListener("click", (ev) => {
    if (ev.target.closest("button")) setMenuOpen(false); // 項目を押したら、メニューは閉じる
  });
  els.menuReset.addEventListener("click", askReset);
  els.menuDetail.addEventListener("click", () => setDetailOpen(!detailOpen));
  els.menuLayout.addEventListener("click", askLayoutFile);
  els.menuLayoutClear.addEventListener("click", clearCustomLayout);
  els.layoutFile.addEventListener("change", onLayoutFileChosen);
  els.resetCancel.addEventListener("click", () => {
    els.resetConfirm.hidden = true;
    els.btnMenu.focus();
  });
  els.resetOk.addEventListener("click", () => {
    els.resetConfirm.hidden = true;
    doReset();
  });
  // 外側を押す、または Esc で閉じる
  document.addEventListener("click", (ev) => {
    if (!ev.target.closest("#menu, #reset-confirm, #btn-menu")) closePopups();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && (!els.menu.hidden || !els.resetConfirm.hidden)) {
      closePopups();
      els.btnMenu.focus();
    }
  });
}

/* ------------------------------------------------------------------ */
/* 起動                                                                 */
/* ------------------------------------------------------------------ */

function init() {
  initTopBar();
  if (!("serial" in navigator)) {
    els.connect.disabled = true;
    setStatus("err", "このブラウザは非対応です");
    showError(
      "WebSerial に対応していません。Chrome または Edge で開いてください。\n" +
      "(ファイルを直接開いて動かない場合は、フォルダで `python3 -m http.server` を実行し、http://localhost:8000/ を開いてください)"
    );
    return;
  }
  window.addEventListener("resize", relayoutStage);
  els.connect.addEventListener("click", connect);
  els.reload.addEventListener("click", loadAll);
  els.disconnect.addEventListener("click", disconnect);
  // 編集欄
  renderPicker();
  els.kcSearch.addEventListener("input", renderPicker);
  els.kindKey.addEventListener("click", () => { pickKind = "key"; renderPicker(); });
  els.kindLayer.addEventListener("click", () => { pickKind = "layer"; renderPicker(); });
  els.kcCats.addEventListener("click", (ev) => {
    const b = ev.target.closest(".cat");
    if (!b || b.disabled) return;
    pickCat = b.dataset.cat;
    els.kcSearch.value = "";
    renderPicker();
  });
  els.kcGrid.addEventListener("click", (ev) => {
    const b = ev.target.closest(".kb");
    if (!b || b.disabled) return;
    els.kcHex.value = keycodeHex(Number(b.dataset.code));
    updatePreview();
  });
  els.kcHex.addEventListener("input", updatePreview);
  els.kcHex.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      applyEdit();
    }
  });
  els.btnSet.addEventListener("click", applyEdit);
  els.btnDeselect.addEventListener("click", deselectKey);
  // 保存・読み直し・初期化
  els.btnSave.addEventListener("click", doSave);
  els.btnLoad.addEventListener("click", doLoad);
  // 未保存の変更があるまま、ページを閉じたり移動したりしようとしたときの警告
  window.addEventListener("beforeunload", (ev) => {
    if (transport !== null && changedCount() > 0) {
      ev.preventDefault();
      ev.returnValue = "";
    }
  });
  // ケーブルを抜いたとき。読み取りループ側でも検知するが、念のため両方で受ける
  navigator.serial.addEventListener("disconnect", (event) => {
    if (transport && event.target === currentPort) {
      transport.close();
    }
  });
  setStatus("off", "未接続");
  updateButtons();
}

init();
