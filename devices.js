// tinykeemap: 機種定義(キーの位置と幅、既定のレイヤー名)
//
// ・機種ごとに、キーの配置を KLE(keyboard-layout-editor.com)の JSON の形で書く(kle)。
//   KLE の「Download JSON」で保存した内容を、そのまま貼り付けられる。
// ・機種は、INFO の name で探す(大文字小文字は区別しない)。定義がない機種は、行×列の格子で表示する。
// ・キーの文字(KLE のキーの左上の文字)に「行,列」を書くと、index = 行 × 列数 + 列 に対応づける(VIA と同じ方式)。
//   文字がなければ、ファイルに書いてある順番を index とする(キー数が INFO の keys と同じときだけ)。
// ・読むのは、位置(x, y)と大きさ(w, h)だけ。色・文字の大きさなどは読み飛ばす。
// ・回転(r, rx, ry)は未対応(警告を出して、回転なしで並べる)。L字型のキーは、長方形として扱う。
// ・デバイスとの通信(docs/protocol.md)には、まったく関係しない。表示のためだけの定義。

"use strict";

const DEVICES = {
  takoyaki8: {
    layers: ["MAC", "EDIT"], // 既定のレイヤー名(L0, L1, …)。足りない分は名前なし
    kle: [
      ["0,0", "0,1", "0,2", "0,3"],
      ["1,0", "1,1", "1,2", "1,3"],
    ],
  },
};

// 機種名から定義を探す(なければ null)
function findDeviceDef(name) {
  const want = String(name).toLowerCase();
  for (const id of Object.keys(DEVICES)) {
    if (id.toLowerCase() === want) return DEVICES[id];
  }
  return null;
}

// KLE の JSON(JSON.parse したあとの配列)を読んで、キーの一覧にする
//   戻り値: { keys: [{ x, y, w, h, legend }], warnings: [文] }(単位は u。legend は左上の文字の1行目)
//   KLE の約束: 文字列1つがキー1つ。x は幅の分だけ進み、行が変わると y が1増える。
//   キーの前のオブジェクトで、x・y(いまの位置からの差)、w・h(次のキーだけ)を変える。d: true は飾り(キーではない)
function parseKle(kle) {
  const keys = [];
  const warnings = [];
  if (!Array.isArray(kle)) {
    return { keys, warnings: ["KLE の JSON として読めません(最も外側が配列ではありません)"] };
  }
  let y = 0;
  let rotationWarned = false;
  for (const row of kle) {
    if (!Array.isArray(row)) continue; // 先頭の情報(名前など)のオブジェクトは、読み飛ばす
    let x = 0;
    let w = 1;
    let h = 1;
    let decal = false;
    for (const item of row) {
      if (typeof item === "string") {
        if (!decal) keys.push({ x, y, w, h, legend: item.split("\n")[0].trim() });
        x += w;
        w = 1;
        h = 1;
        decal = false;
      } else if (item !== null && typeof item === "object") {
        const rotated = (item.r || 0) !== 0 || (item.rx || 0) !== 0 || (item.ry || 0) !== 0;
        if (rotated && !rotationWarned) {
          warnings.push("回転(r, rx, ry)は未対応です。回転なしで並べます");
          rotationWarned = true;
        }
        if (typeof item.x === "number") x += item.x;
        if (typeof item.y === "number") y += item.y;
        if (typeof item.w === "number" && item.w > 0) w = item.w;
        if (typeof item.h === "number" && item.h > 0) h = item.h;
        if (item.d === true) decal = true;
      }
    }
    y += 1;
  }
  return { keys, warnings };
}

// 行×列の格子(定義がないときの表示)。rows × cols が keys と合わないときは、1行に並べる
function gridLayout(info) {
  const shapeOk = info.rows * info.cols === info.keys;
  const cols = shapeOk ? info.cols : info.keys;
  const out = [];
  for (let i = 0; i < info.keys; i++) out.push({ x: i % cols, y: Math.floor(i / cols), w: 1, h: 1 });
  return out;
}

// KLE のキーの一覧を、index に対応づける
//   成功: { layout: [index 順。キーがない index は null], mode: "matrix" | "order" }
//   失敗: { reason: 文 }
function mapKeysToIndex(keys, info) {
  if (keys.length === 0) return { reason: "KLE にキーがありません" };
  const legendRe = /^(\d+)\s*,\s*(\d+)$/;
  const allLegends = keys.every((k) => legendRe.test(k.legend));
  if (allLegends) {
    const layout = new Array(info.keys).fill(null);
    for (const k of keys) {
      const m = legendRe.exec(k.legend);
      const r = Number(m[1]);
      const c = Number(m[2]);
      const index = r * info.cols + c;
      if (r >= info.rows || c >= info.cols || index >= info.keys) {
        return { reason: "キーの文字「" + k.legend + "」が、この機種の行×列(" + info.rows + " × " + info.cols + ")の範囲外です" };
      }
      if (layout[index] !== null) {
        return { reason: "キーの文字「" + k.legend + "」が重なっています" };
      }
      layout[index] = { x: k.x, y: k.y, w: k.w, h: k.h };
    }
    return { layout, mode: "matrix" };
  }
  if (keys.length === info.keys) {
    return { layout: keys.map((k) => ({ x: k.x, y: k.y, w: k.w, h: k.h })), mode: "order" };
  }
  return { reason: "KLE のキー数(" + keys.length + ")が、デバイスのキー数(" + info.keys + ")と合いません(キーの文字に「行,列」も書かれていません)" };
}

// 接続したデバイスの配列を決める。def は findDeviceDef の結果(なければ null)
//   戻り値: { source: "matrix" | "order" | "grid", layout: [{ x, y, w, h } | null], layerNames: [文字列],
//            width, height(全体の大きさ。u), warnings: [文] }
//   layout は index 順。null は、その index に対応するキーがない(画面には出さない)
function resolveLayout(info, def) {
  const warnings = [];
  const layerNames = [];
  for (let i = 0; i < info.layers; i++) {
    layerNames.push(def && def.layers && def.layers[i] ? def.layers[i] : "");
  }
  let source = "grid";
  let layout = null;
  if (def && def.kle) {
    const parsed = parseKle(def.kle);
    warnings.push(...parsed.warnings);
    const mapped = mapKeysToIndex(parsed.keys, info);
    if (mapped.layout) {
      layout = mapped.layout;
      source = mapped.mode;
    } else {
      warnings.push("機種定義を使えないため、行×列の格子で表示します: " + mapped.reason);
    }
  }
  if (layout === null) layout = gridLayout(info);
  let width = 0;
  let height = 0;
  for (const p of layout) {
    if (p === null) continue;
    width = Math.max(width, p.x + p.w);
    height = Math.max(height, p.y + p.h);
  }
  return { source, layout, layerNames, width, height, warnings };
}

// 「デバイス情報」に出す文
function describeLayout(result) {
  const names = result.layerNames.filter((n) => n !== "");
  const nameText = names.length > 0 ? "。レイヤー名: " + names.join(", ") : "";
  if (result.source === "matrix") return "内蔵(「行,列」の文字で対応づけ" + nameText + ")";
  if (result.source === "order") return "内蔵(読む順番で対応づけ" + nameText + ")";
  return "なし(行 × 列の格子で表示" + nameText + ")";
}
