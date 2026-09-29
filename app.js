// tinykeemap 最小版 (読み取り専用)
// 仕様: docs/protocol.md (Draft v1, proto=1)
//
// 構成(上から順に、下の層は上の層を知らない):
//   1. SerialLineTransport … WebSerial で「1行送る / 1行受け取る」だけ(USBの都合はここに閉じ込める)
//   2. protocol            … 1行の文字列 ⇔ INFO / DUMP の結果 の変換
//   3. 画面                … ボタン・表・ログの表示

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

class SerialLineTransport {
  // callbacks: { onDebug(line), onStray(line), onClosed(errorOrNull) }
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
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      clearTimeout(w.timer);
      w.resolve(line);
    } else {
      this.cb.onStray(line); // 待っていないのに届いた行
    }
  }

  _notifyClosed(err) {
    if (this.closedNotified) return;
    this.closedNotified = true;
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

  // 次の1行(デバッグ行を除く)を待つ
  readLine(timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.waiter) {
        reject(new Error("内部エラー: 同時に2つの応答は待てません"));
        return;
      }
      const timer = setTimeout(() => {
        this.waiter = null;
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
/* 2. プロトコル (INFO / DUMP)                                          */
/* ------------------------------------------------------------------ */

class ProtocolError extends Error {
  // code: "BADCMD" など。応答が壊れているときは "BADRESP"
  constructor(code, message) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

const DEFAULT_TIMEOUT_MS = 1000; // protocol.md §3: 通常1秒(SAVE のみ2秒以上。今回は使わない)

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
  log: document.getElementById("log"),
};

let transport = null; // 接続中の SerialLineTransport
let busy = false; // 読み込み中は次の操作を受け付けない
let currentPort = null;

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
  els.connect.disabled = connected || busy;
  els.reload.disabled = !connected || busy;
  els.disconnect.disabled = !connected;
}

function clearResults() {
  els.infoPanel.hidden = true;
  els.keymapPanel.hidden = true;
  els.info.replaceChildren();
  els.keymap.replaceChildren();
}

// コマンドを1つ送り、応答が返るまで待つ(リクエスト/レスポンス方式)
async function request(command, timeoutMs) {
  if (!transport) throw new Error("接続されていません");
  const t = transport;
  log("tx", "> " + command);
  await t.writeLine(command);
  let line;
  try {
    line = await t.readLine(timeoutMs || DEFAULT_TIMEOUT_MS);
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

  codes.forEach((code, index) => {
    const cap = document.createElement("div");
    cap.className = "cap";
    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = String(index);
    const c = document.createElement("span");
    c.className = "code";
    c.textContent = hex4(code);
    const note = document.createElement("span");
    note.className = "note";
    if (code === 0x0000) {
      cap.classList.add("none");
      note.textContent = "何もしない";
    } else if (code === 0x0001) {
      cap.classList.add("trans");
      note.textContent = "透過";
    }
    cap.append(idx, c, note);
    grid.appendChild(cap);
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

    els.keymapPanel.hidden = false;
    for (let layer = 0; layer < info.layers; layer++) {
      const resp = await request("DUMP " + layer);
      const codes = parseDumpData(resp.data, info.keys);
      renderLayer(layer, codes, info);
    }

    setStatus("on", "接続中 (" + info.name + ")");
    if (warnings.length > 0) showError(warnings.join("\n"), true);
  } catch (e) {
    if (transport === null) return; // 切断が原因のときは onClosed 側で表示済み
    setStatus("err", "読み込み失敗");
    showError(describeError(e));
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
  if (e instanceof TimeoutError) {
    return e.message + "\nデバイスのファームが USBシリアルのコマンドに対応しているか、debug 出力が有効になっていないか確認してください。";
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
