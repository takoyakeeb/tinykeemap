// tinykeemap (キーマップの表示と、1キーずつの変更)
// 仕様: docs/protocol.md (Draft v1, proto=1)
// keycode の名前の表・入力の解釈は keycodes.js(先に読み込む)
//
// 構成(上から順に、下の層は上の層を知らない):
//   1. SerialLineTransport … WebSerial で「1行送る / 1行受け取る」だけ(USBの都合はここに閉じ込める)
//   2. protocol … 1行の文字列 ⇔ INFO / DUMP / SET の結果 の変換
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
/* 2. プロトコル (INFO / GET / SET / DUMP)                                */
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
  log: document.getElementById("log"),
};

let transport = null; // 接続中の SerialLineTransport
let busy = false; // 読み込み中は次の操作を受け付けない
let currentPort = null;
// 画面に出しているキーマップ。{ info, codes[layer][index], caps[layer][index](マスの部品), selected: {layer, index} | null }
let model = null;

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
}

// 編集欄は、キーマップを表示していて、通信中でも応答なしでもないときだけ使える
function updateEditControls() {
  const usable = transport !== null && !busy && model !== null && transport.syncState !== "broken";
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
  els.editTarget.textContent = "(なし)";
  els.kcHex.value = "";
  updatePreview();
  clearEditMessage();
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
  return k ? k.name : "(一覧にない値)";
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
  cap.setAttribute("aria-label", "レイヤー " + layerIndex + " キー " + index + ": " + hex4(code) + " " + capNote(code));
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
    ? "  " + k.name + "(" + k.label + ")"
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
  cap.classList.remove("set-failed");
  try {
    await request("SET " + layer + " " + index + " " + hex4(code));
    model.codes[layer][index] = code;
    fillCap(cap, layer, index, code);
    showEditMessage("ok", where + " を " + keyLabel(code) + " に変更しました。まだ保存していないので、USBを抜き差しすると元に戻ります。");
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
      if (actual === code) {
        showEditMessage("ok", where + ": 応答は遅れましたが、" + keyLabel(actual) + " に変更されていました。まだ保存していないので、USBを抜き差しすると元に戻ります。");
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
