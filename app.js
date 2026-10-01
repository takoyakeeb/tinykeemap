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
  reload: document.getElementById("btn-reload"),
  disconnect: document.getElementById("btn-disconnect"),
  status: document.getElementById("status"),
  error: document.getElementById("error"),
  infoPanel: document.getElementById("info-panel"),
  info: document.getElementById("info"),
  keymapPanel: document.getElementById("keymap-panel"),
  keymap: document.getElementById("keymap"),
  editPanel: document.getElementById("edit-panel"),
  editTarget: document.getElementById("edit-target"),
  kcSearch: document.getElementById("kc-search"),
  kcList: document.getElementById("kc-list"),
  kcHex: document.getElementById("kc-hex"),
  kcPreview: document.getElementById("kc-preview"),
  btnSet: document.getElementById("btn-set"),
  editMsg: document.getElementById("edit-msg"),
  btnSave: document.getElementById("btn-save"),
  btnLoad: document.getElementById("btn-load"),
  btnReset: document.getElementById("btn-reset"),
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
  els.btnLoad.disabled = !usable;
  els.btnReset.disabled = !usable;
}

function updateEditControls() {
  const usable = canOperate();
  els.kcSearch.disabled = !usable;
  els.kcList.disabled = !usable;
  els.kcHex.disabled = !usable;
  els.btnSet.disabled = !(usable && model.selected !== null);
}

function clearResults() {
  els.infoPanel.hidden = true;
  els.keymapPanel.hidden = true;
  els.editPanel.hidden = true;
  els.info.replaceChildren();
  els.keymap.replaceChildren();
  model = null;
  setDeviceLayers(0); // 接続していない間は、レイヤー数が分からない
  populateKeycodeList(els.kcSearch.value);
  els.editTarget.textContent = "(なし)";
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

function renderInfo(info, rawInfo) {
  els.info.replaceChildren();
  const rows = [
    ["機種名 (name)", info.name],
    ["プロトコル (proto)", String(info.proto)],
    ["ファーム (fw)", info.fw],
    ["キー数 (keys)", String(info.keys)],
    ["行 × 列 (rows × cols)", info.rows + " × " + info.cols],
    ["レイヤー数 (layers)", String(info.layers)],
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
  els.infoPanel.hidden = false;
}

// マスの下に添える注釈(名前など)
function capNote(code) {
  if (code === 0x0000) return "何もしない";
  if (code === 0x0001) return "透過";
  const k = findKeycode(code);
  if (!k) return "(一覧にない値)";
  return k.warn ? k.name + "(範囲外)" : k.name;
}

// マス1つの中身(index・keycode・注釈)を作り直す。最初の表示と、SET のあとの更新の両方で使う
function fillCap(cap, layerIndex, index, code) {
  cap.replaceChildren();
  cap.classList.toggle("none", code === 0x0000);
  cap.classList.toggle("trans", code === 0x0001);
  const idx = document.createElement("span");
  idx.className = "idx";
  idx.textContent = String(index);
  const c = document.createElement("span");
  c.className = "code";
  c.textContent = hex4(code);
  const note = document.createElement("span");
  note.className = "note";
  note.textContent = capNote(code);
  cap.append(idx, c, note);
  cap.dataset.label = "レイヤー " + layerIndex + " キー " + index + ": " + hex4(code) + " " + capNote(code);
  cap.setAttribute("aria-label", cap.dataset.label);
}

function renderLayer(layerIndex, codes, info) {
  // index = row * cols + col (protocol.md §2)。rows × cols が keys と合わないときは1行に並べる
  const shapeOk = info.rows * info.cols === info.keys;
  const cols = shapeOk ? info.cols : info.keys;

  const section = document.createElement("div");
  section.className = "layer";
  const h = document.createElement("h3");
  h.textContent = "レイヤー " + layerIndex;
  section.appendChild(h);

  const grid = document.createElement("div");
  grid.className = "grid";
  grid.style.gridTemplateColumns = "repeat(" + cols + ", minmax(78px, 1fr))";

  model.caps[layerIndex] = [];
  codes.forEach((code, index) => {
    const cap = document.createElement("button");
    cap.type = "button";
    cap.className = "cap";
    cap.setAttribute("aria-pressed", "false");
    cap.addEventListener("click", () => selectKey(layerIndex, index));
    fillCap(cap, layerIndex, index, code);
    grid.appendChild(cap);
    model.caps[layerIndex].push(cap);
  });

  section.appendChild(grid);
  els.keymap.appendChild(section);
  return shapeOk;
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
    renderInfo(info, rawInfo);
    // レイヤー切り替え(MO(n))の一覧を、このデバイスのレイヤー数に合わせて作り直す
    setDeviceLayers(info.layers);
    populateKeycodeList(els.kcSearch.value);

    const warnings = [];
    if (info.proto !== 1) {
      warnings.push("このツールは proto=1 用です。デバイスは proto=" + info.proto + " なので、正しく表示できない可能性があります。");
    }
    if (info.rows * info.cols !== info.keys) {
      warnings.push("rows × cols (" + info.rows * info.cols + ") が keys (" + info.keys + ") と一致しないため、1行に並べて表示します。");
    }

    model = { info, codes: [], caps: [], selected: null };
    els.keymapPanel.hidden = false;
    for (let layer = 0; layer < info.layers; layer++) {
      const resp = await request("DUMP " + layer);
      const codes = parseDumpData(resp.data, info.keys);
      model.codes[layer] = codes;
      renderLayer(layer, codes, info);
    }
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

// keycode の一覧を作る(絞り込み文字に合うものだけ、グループごとに)
function populateKeycodeList(filterText) {
  const keep = els.kcList.value;
  els.kcList.replaceChildren();
  const hits = searchKeycodes(filterText);
  for (const g of KEYCODE_GROUPS) {
    const items = hits.filter((k) => k.group === g.id);
    if (items.length === 0) continue;
    const og = document.createElement("optgroup");
    og.label = g.title;
    for (const k of items) {
      const o = document.createElement("option");
      o.value = String(k.code);
      o.textContent = keycodeHex(k.code) + "  " + k.name + "  " + k.label;
      og.appendChild(o);
    }
    els.kcList.appendChild(og);
  }
  if (hits.length === 0) {
    const o = document.createElement("option");
    o.disabled = true;
    o.textContent = "(当てはまるものがありません)";
    els.kcList.appendChild(o);
  }
  if (keep !== "") els.kcList.value = keep; // 絞り込み後にも残っていれば、選択を保つ
}

// 入力欄の内容を読み取って、下に「→ 0x0004 KC_A(A)」のように見せる
function updatePreview() {
  const text = els.kcHex.value;
  els.kcPreview.className = "kc-preview";
  if (text.trim() === "") {
    els.kcPreview.textContent = "";
    return;
  }
  const p = parseKeycodeText(text);
  if (!p.ok) {
    els.kcPreview.textContent = p.reason;
    els.kcPreview.classList.add("bad");
    return;
  }
  const k = findKeycode(p.code);
  els.kcPreview.textContent = "→ " + keycodeHex(p.code) + (k
    ? "  " + k.name + "(" + k.label + ")" + (k.warn ? "  ⚠ " + k.warn : "")
    : "  一覧にない値です。デバイスが対応していなければ、エラーになります");
  if (k) els.kcList.value = String(p.code);
  else els.kcList.selectedIndex = -1;
}

// マスをクリックして選ぶ
function selectKey(layer, index) {
  if (!model || busy || transport === null) return;
  model.selected = { layer, index };
  model.caps.forEach((row, l) => row.forEach((cap, i) => {
    const on = l === layer && i === index;
    cap.classList.toggle("selected", on);
    cap.classList.remove("set-failed");
    cap.setAttribute("aria-pressed", on ? "true" : "false");
  }));
  els.editTarget.textContent = "レイヤー " + layer + " / キー " + index;
  els.kcHex.value = hex4(model.codes[layer][index]);
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
      showEditMessage("fail", where + " は変更できませんでした。デバイスが、レイヤーまたはキー番号を範囲外だと言っています(" + detail + ")。ツールとデバイスの設定が食い違っているので、「再読み込み」で読み直してください。");
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
  if (!model || !baselineFits(model.codes)) {
    els.dirtyBadge.textContent = "";
    els.dirtyBadge.className = "dirty-badge";
    els.btnSave.classList.remove("dirty");
    return;
  }
  const n = changedCount();
  model.caps.forEach((row, l) => row.forEach((cap, i) => {
    const changed = model.codes[l][i] !== baseline[l][i];
    cap.classList.toggle("changed", changed);
    cap.setAttribute("aria-label", (cap.dataset.label || "") + (changed ? "(未保存の変更)" : ""));
  }));
  els.dirtyBadge.textContent = n > 0 ? "未保存の変更: " + n + " キー" : "変更なし(保存済みと同じ)";
  els.dirtyBadge.className = "dirty-badge " + (n > 0 ? "dirty" : "clean");
  els.btnSave.classList.toggle("dirty", n > 0);
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
    fillCap(model.caps[l][i], l, i, code);
    model.caps[l][i].classList.remove("set-failed");
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
      ? "保存できたかどうか分かりません。デバイスから応答がありません。「切断する」で接続し直して、キーマップを確認し、必要ならもう一度保存してください。"
      : name + "の結果が分かりません。デバイスから応答がありません。「切断する」で接続し直してください。";
  } else {
    msg = name + "に失敗しました。" + describeError(e) +
      (cmd === "SAVE" ? "" : "\nキーボードの今の内容は「再読み込み」で確認できます。");
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
  const n = changedCount();
  if (n > 0 && !window.confirm("未保存の変更が " + n + " キーあります。\n初期キーマップに戻すと、これらの変更は破棄されます(Flash は「保存する」を押すまで変わりません)。続けますか?")) return;
  busy = true;
  updateButtons();
  clearSaveMessage();
  clearEditMessage();
  try {
    await sendStateCommand("RESET");
    const codes = await readAllCodes();
    applyCodes(codes);
    showSaveMessage("ok", "初期キーマップに戻しました。まだ保存していません。" +
      (changedCount() > 0 ? "保存済みの内容とは違います。元に戻すには「読み直す(LOAD)」を押してください。" : ""));
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
      "「切断する」を押して、もう一度接続してください。";
  }
  if (e instanceof TimeoutError) {
    return e.message + "\n遅れて届く応答を最大約 " + LATE_GRACE_MS / 1000 + " 秒待ちます。そのあとで「再読み込み」を押してください。\n" +
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

/* ------------------------------------------------------------------ */
/* 起動                                                                 */
/* ------------------------------------------------------------------ */

function init() {
  if (!("serial" in navigator)) {
    els.connect.disabled = true;
    setStatus("err", "このブラウザは非対応です");
    showError(
      "WebSerial に対応していません。Chrome または Edge で開いてください。\n" +
      "(ファイルを直接開いて動かない場合は、フォルダで `python3 -m http.server` を実行し、http://localhost:8000/ を開いてください)"
    );
    return;
  }
  els.connect.addEventListener("click", connect);
  els.reload.addEventListener("click", loadAll);
  els.disconnect.addEventListener("click", disconnect);
  // 編集欄
  populateKeycodeList("");
  els.kcSearch.addEventListener("input", () => populateKeycodeList(els.kcSearch.value));
  els.kcList.addEventListener("change", () => {
    if (els.kcList.value === "") return;
    els.kcHex.value = keycodeHex(Number(els.kcList.value));
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
  // 保存・読み直し・初期化
  els.btnSave.addEventListener("click", doSave);
  els.btnLoad.addEventListener("click", doLoad);
  els.btnReset.addEventListener("click", doReset);
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
