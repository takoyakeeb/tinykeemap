// tinykeemap: keycode の名前の表(表示と入力の補助用)
//
// ・ここにある名前(KC_A など)は、画面に表示したり、入力しやすくしたりするためだけに使う。
//   デバイスとの通信(docs/protocol.md)では、名前は使わず、16進の値だけを送る。
//   なので、名前が間違っていても通信は壊れない。
// ・値と名前は、QMK の基本キーコードに合わせてある(下位8bitは USB HID の Usage ID)。
// ・この表にあるのは、0x0000 / 0x0001 / 0x0004〜0x00A4 / 0x00E0〜0x00E7(修飾キー単体)。
//   ファームが対応を増やしたら、ここにも足す
//   (修飾キー付き・レイヤー切り替えは docs/protocol.md で値を決めてある。ファームの対応が済んでから足す)。
// ・表にない値でも、16進で入力すればデバイスへ送れる。対応していなければ、デバイスが ERR BADARG を返す。

"use strict";

// 一覧に出す順番とグループ名
const KEYCODE_GROUPS = [
  { id: "special", title: "特殊" },
  { id: "letters", title: "英字" },
  { id: "numbers", title: "数字" },
  { id: "basic", title: "基本キー" },
  { id: "modifier", title: "修飾キー" },
  { id: "symbols", title: "記号" },
  { id: "function", title: "ファンクション" },
  { id: "navigation", title: "移動・編集" },
  { id: "keypad", title: "テンキー" },
  { id: "system", title: "システム・メディア" },
  { id: "international", title: "日本語・国際キー" },
  { id: "other", title: "その他" },
];

// [値, 名前, 別名(なければ空), 表示名, グループ]
const KEYCODE_ROWS = [
  [0x0000, "KC_NO", "XXXXXXX", "何もしない", "special"],
  [0x0001, "KC_TRANSPARENT", "KC_TRNS", "透過(下のレイヤーを使う)", "special"],
  [0x0004, "KC_A", "", "A", "letters"],
  [0x0005, "KC_B", "", "B", "letters"],
  [0x0006, "KC_C", "", "C", "letters"],
  [0x0007, "KC_D", "", "D", "letters"],
  [0x0008, "KC_E", "", "E", "letters"],
  [0x0009, "KC_F", "", "F", "letters"],
  [0x000A, "KC_G", "", "G", "letters"],
  [0x000B, "KC_H", "", "H", "letters"],
  [0x000C, "KC_I", "", "I", "letters"],
  [0x000D, "KC_J", "", "J", "letters"],
  [0x000E, "KC_K", "", "K", "letters"],
  [0x000F, "KC_L", "", "L", "letters"],
  [0x0010, "KC_M", "", "M", "letters"],
  [0x0011, "KC_N", "", "N", "letters"],
  [0x0012, "KC_O", "", "O", "letters"],
  [0x0013, "KC_P", "", "P", "letters"],
  [0x0014, "KC_Q", "", "Q", "letters"],
  [0x0015, "KC_R", "", "R", "letters"],
  [0x0016, "KC_S", "", "S", "letters"],
  [0x0017, "KC_T", "", "T", "letters"],
  [0x0018, "KC_U", "", "U", "letters"],
  [0x0019, "KC_V", "", "V", "letters"],
  [0x001A, "KC_W", "", "W", "letters"],
  [0x001B, "KC_X", "", "X", "letters"],
  [0x001C, "KC_Y", "", "Y", "letters"],
  [0x001D, "KC_Z", "", "Z", "letters"],
  [0x001E, "KC_1", "", "1", "numbers"],
  [0x001F, "KC_2", "", "2", "numbers"],
  [0x0020, "KC_3", "", "3", "numbers"],
  [0x0021, "KC_4", "", "4", "numbers"],
  [0x0022, "KC_5", "", "5", "numbers"],
  [0x0023, "KC_6", "", "6", "numbers"],
  [0x0024, "KC_7", "", "7", "numbers"],
  [0x0025, "KC_8", "", "8", "numbers"],
  [0x0026, "KC_9", "", "9", "numbers"],
  [0x0027, "KC_0", "", "0", "numbers"],
  [0x0028, "KC_ENTER", "KC_ENT", "Enter", "basic"],
  [0x0029, "KC_ESCAPE", "KC_ESC", "Esc", "basic"],
  [0x002A, "KC_BACKSPACE", "KC_BSPC", "Backspace", "basic"],
  [0x002B, "KC_TAB", "", "Tab", "basic"],
  [0x002C, "KC_SPACE", "KC_SPC", "Space", "basic"],
  [0x002D, "KC_MINUS", "KC_MINS", "-", "symbols"],
  [0x002E, "KC_EQUAL", "KC_EQL", "=", "symbols"],
  [0x002F, "KC_LEFT_BRACKET", "KC_LBRC", "[", "symbols"],
  [0x0030, "KC_RIGHT_BRACKET", "KC_RBRC", "]", "symbols"],
  [0x0031, "KC_BACKSLASH", "KC_BSLS", "\\", "symbols"],
  [0x0032, "KC_NONUS_HASH", "KC_NUHS", "# (ISO)", "symbols"],
  [0x0033, "KC_SEMICOLON", "KC_SCLN", ";", "symbols"],
  [0x0034, "KC_QUOTE", "KC_QUOT", "'", "symbols"],
  [0x0035, "KC_GRAVE", "KC_GRV", "`", "symbols"],
  [0x0036, "KC_COMMA", "KC_COMM", ",", "symbols"],
  [0x0037, "KC_DOT", "", ".", "symbols"],
  [0x0038, "KC_SLASH", "KC_SLSH", "/", "symbols"],
  [0x0039, "KC_CAPS_LOCK", "KC_CAPS", "Caps Lock", "basic"],
  [0x003A, "KC_F1", "", "F1", "function"],
  [0x003B, "KC_F2", "", "F2", "function"],
  [0x003C, "KC_F3", "", "F3", "function"],
  [0x003D, "KC_F4", "", "F4", "function"],
  [0x003E, "KC_F5", "", "F5", "function"],
  [0x003F, "KC_F6", "", "F6", "function"],
  [0x0040, "KC_F7", "", "F7", "function"],
  [0x0041, "KC_F8", "", "F8", "function"],
  [0x0042, "KC_F9", "", "F9", "function"],
  [0x0043, "KC_F10", "", "F10", "function"],
  [0x0044, "KC_F11", "", "F11", "function"],
  [0x0045, "KC_F12", "", "F12", "function"],
  [0x0046, "KC_PRINT_SCREEN", "KC_PSCR", "Print Screen", "navigation"],
  [0x0047, "KC_SCROLL_LOCK", "KC_SCRL", "Scroll Lock", "navigation"],
  [0x0048, "KC_PAUSE", "KC_PAUS", "Pause", "navigation"],
  [0x0049, "KC_INSERT", "KC_INS", "Insert", "navigation"],
  [0x004A, "KC_HOME", "", "Home", "navigation"],
  [0x004B, "KC_PAGE_UP", "KC_PGUP", "Page Up", "navigation"],
  [0x004C, "KC_DELETE", "KC_DEL", "Delete", "navigation"],
  [0x004D, "KC_END", "", "End", "navigation"],
  [0x004E, "KC_PAGE_DOWN", "KC_PGDN", "Page Down", "navigation"],
  [0x004F, "KC_RIGHT", "KC_RGHT", "→", "navigation"],
  [0x0050, "KC_LEFT", "", "←", "navigation"],
  [0x0051, "KC_DOWN", "", "↓", "navigation"],
  [0x0052, "KC_UP", "", "↑", "navigation"],
  [0x0053, "KC_NUM_LOCK", "KC_NUM", "Num Lock", "keypad"],
  [0x0054, "KC_KP_SLASH", "KC_PSLS", "テンキー /", "keypad"],
  [0x0055, "KC_KP_ASTERISK", "KC_PAST", "テンキー *", "keypad"],
  [0x0056, "KC_KP_MINUS", "KC_PMNS", "テンキー -", "keypad"],
  [0x0057, "KC_KP_PLUS", "KC_PPLS", "テンキー +", "keypad"],
  [0x0058, "KC_KP_ENTER", "KC_PENT", "テンキー Enter", "keypad"],
  [0x0059, "KC_KP_1", "KC_P1", "テンキー 1", "keypad"],
  [0x005A, "KC_KP_2", "KC_P2", "テンキー 2", "keypad"],
  [0x005B, "KC_KP_3", "KC_P3", "テンキー 3", "keypad"],
  [0x005C, "KC_KP_4", "KC_P4", "テンキー 4", "keypad"],
  [0x005D, "KC_KP_5", "KC_P5", "テンキー 5", "keypad"],
  [0x005E, "KC_KP_6", "KC_P6", "テンキー 6", "keypad"],
  [0x005F, "KC_KP_7", "KC_P7", "テンキー 7", "keypad"],
  [0x0060, "KC_KP_8", "KC_P8", "テンキー 8", "keypad"],
  [0x0061, "KC_KP_9", "KC_P9", "テンキー 9", "keypad"],
  [0x0062, "KC_KP_0", "KC_P0", "テンキー 0", "keypad"],
  [0x0063, "KC_KP_DOT", "KC_PDOT", "テンキー .", "keypad"],
  [0x0064, "KC_NONUS_BACKSLASH", "KC_NUBS", "\\ (ISO)", "symbols"],
  [0x0065, "KC_APPLICATION", "KC_APP", "Application(右クリックメニュー)", "system"],
  [0x0066, "KC_KB_POWER", "", "Power", "system"],
  [0x0067, "KC_KP_EQUAL", "KC_PEQL", "テンキー =", "keypad"],
  [0x0068, "KC_F13", "", "F13", "function"],
  [0x0069, "KC_F14", "", "F14", "function"],
  [0x006A, "KC_F15", "", "F15", "function"],
  [0x006B, "KC_F16", "", "F16", "function"],
  [0x006C, "KC_F17", "", "F17", "function"],
  [0x006D, "KC_F18", "", "F18", "function"],
  [0x006E, "KC_F19", "", "F19", "function"],
  [0x006F, "KC_F20", "", "F20", "function"],
  [0x0070, "KC_F21", "", "F21", "function"],
  [0x0071, "KC_F22", "", "F22", "function"],
  [0x0072, "KC_F23", "", "F23", "function"],
  [0x0073, "KC_F24", "", "F24", "function"],
  [0x0074, "KC_EXECUTE", "KC_EXEC", "Execute", "system"],
  [0x0075, "KC_HELP", "", "Help", "system"],
  [0x0076, "KC_MENU", "", "Menu", "system"],
  [0x0077, "KC_SELECT", "KC_SLCT", "Select", "system"],
  [0x0078, "KC_STOP", "", "Stop", "system"],
  [0x0079, "KC_AGAIN", "KC_AGIN", "Again", "system"],
  [0x007A, "KC_UNDO", "", "Undo", "system"],
  [0x007B, "KC_CUT", "", "Cut", "system"],
  [0x007C, "KC_COPY", "", "Copy", "system"],
  [0x007D, "KC_PASTE", "KC_PSTE", "Paste", "system"],
  [0x007E, "KC_FIND", "", "Find", "system"],
  [0x007F, "KC_KB_MUTE", "", "Mute", "system"],
  [0x0080, "KC_KB_VOLUME_UP", "", "Volume Up", "system"],
  [0x0081, "KC_KB_VOLUME_DOWN", "", "Volume Down", "system"],
  [0x0082, "KC_LOCKING_CAPS_LOCK", "KC_LCAP", "Locking Caps Lock", "system"],
  [0x0083, "KC_LOCKING_NUM_LOCK", "KC_LNUM", "Locking Num Lock", "system"],
  [0x0084, "KC_LOCKING_SCROLL_LOCK", "KC_LSCR", "Locking Scroll Lock", "system"],
  [0x0085, "KC_KP_COMMA", "KC_PCMM", "テンキー ,", "keypad"],
  [0x0086, "KC_KP_EQUAL_AS400", "", "テンキー = (AS/400)", "keypad"],
  [0x0087, "KC_INTERNATIONAL_1", "KC_INT1", "ろ (Ro)", "international"],
  [0x0088, "KC_INTERNATIONAL_2", "KC_INT2", "カタカナ/ひらがな/ローマ字", "international"],
  [0x0089, "KC_INTERNATIONAL_3", "KC_INT3", "円記号 ¥", "international"],
  [0x008A, "KC_INTERNATIONAL_4", "KC_INT4", "変換", "international"],
  [0x008B, "KC_INTERNATIONAL_5", "KC_INT5", "無変換", "international"],
  [0x008C, "KC_INTERNATIONAL_6", "KC_INT6", "PC-98 テンキーの ,", "international"],
  [0x008D, "KC_INTERNATIONAL_7", "KC_INT7", "International 7", "international"],
  [0x008E, "KC_INTERNATIONAL_8", "KC_INT8", "International 8", "international"],
  [0x008F, "KC_INTERNATIONAL_9", "KC_INT9", "International 9", "international"],
  [0x0090, "KC_LANGUAGE_1", "KC_LNG1", "Hangul/English 切り替え", "international"],
  [0x0091, "KC_LANGUAGE_2", "KC_LNG2", "Hanja 変換", "international"],
  [0x0092, "KC_LANGUAGE_3", "KC_LNG3", "カタカナ", "international"],
  [0x0093, "KC_LANGUAGE_4", "KC_LNG4", "ひらがな", "international"],
  [0x0094, "KC_LANGUAGE_5", "KC_LNG5", "半角/全角", "international"],
  [0x0095, "KC_LANGUAGE_6", "KC_LNG6", "Language 6", "international"],
  [0x0096, "KC_LANGUAGE_7", "KC_LNG7", "Language 7", "international"],
  [0x0097, "KC_LANGUAGE_8", "KC_LNG8", "Language 8", "international"],
  [0x0098, "KC_LANGUAGE_9", "KC_LNG9", "Language 9", "international"],
  [0x0099, "KC_ALTERNATE_ERASE", "KC_ERAS", "Alternate Erase", "other"],
  [0x009A, "KC_SYSTEM_REQUEST", "KC_SYRQ", "SysReq", "other"],
  [0x009B, "KC_CANCEL", "KC_CNCL", "Cancel", "other"],
  [0x009C, "KC_CLEAR", "KC_CLR", "Clear", "other"],
  [0x009D, "KC_PRIOR", "KC_PRIR", "Prior", "other"],
  [0x009E, "KC_RETURN", "KC_RETN", "Return", "other"],
  [0x009F, "KC_SEPARATOR", "KC_SEPR", "Separator", "other"],
  [0x00A0, "KC_OUT", "", "Out", "other"],
  [0x00A1, "KC_OPER", "", "Oper", "other"],
  [0x00A2, "KC_CLEAR_AGAIN", "KC_CLAG", "Clear/Again", "other"],
  [0x00A3, "KC_CRSEL", "KC_CRSL", "CrSel", "other"],
  [0x00A4, "KC_EXSEL", "KC_EXSL", "ExSel", "other"],
  [0x00E0, "KC_LEFT_CTRL", "KC_LCTL", "左 Ctrl", "modifier"],
  [0x00E1, "KC_LEFT_SHIFT", "KC_LSFT", "左 Shift", "modifier"],
  [0x00E2, "KC_LEFT_ALT", "KC_LALT", "左 Alt", "modifier"],
  [0x00E3, "KC_LEFT_GUI", "KC_LGUI", "左 GUI(Windows / Super キー)", "modifier"],
  [0x00E4, "KC_RIGHT_CTRL", "KC_RCTL", "右 Ctrl", "modifier"],
  [0x00E5, "KC_RIGHT_SHIFT", "KC_RSFT", "右 Shift", "modifier"],
  [0x00E6, "KC_RIGHT_ALT", "KC_RALT", "右 Alt", "modifier"],
  [0x00E7, "KC_RIGHT_GUI", "KC_RGUI", "右 GUI", "modifier"],
];

const KEYCODES = KEYCODE_ROWS.map(([code, name, alias, label, group]) => ({ code, name, alias, label, group }));
const KEYCODE_BY_CODE = new Map(KEYCODES.map((k) => [k.code, k]));
const KEYCODE_BY_NAME = new Map();
for (const k of KEYCODES) {
  KEYCODE_BY_NAME.set(k.name.toUpperCase(), k);
  if (k.alias) KEYCODE_BY_NAME.set(k.alias.toUpperCase(), k);
}

// 値から表の項目を探す(なければ null)
function findKeycode(code) {
  return KEYCODE_BY_CODE.get(code) || null;
}

// "0x0004" の形(0x + 大文字16進4桁)
function keycodeHex(code) {
  return "0x" + code.toString(16).toUpperCase().padStart(4, "0");
}

// 入力欄の文字を keycode にする。16進(0x1D / 0x001d)か、名前・別名(KC_A / kc_ent)を受け付ける
function parseKeycodeText(text) {
  const s = String(text).trim();
  if (s === "") return { ok: false, reason: "keycode を入力してください" };
  if (/^0x[0-9a-f]{1,4}$/i.test(s)) return { ok: true, code: parseInt(s, 16) };
  const hit = KEYCODE_BY_NAME.get(s.toUpperCase());
  if (hit) return { ok: true, code: hit.code };
  return { ok: false, reason: "「" + s + "」は読み取れません。0x0004 のような16進か、KC_A のような名前で入力してください" };
}

// 一覧の絞り込み。空白で区切った言葉が、すべて(値・名前・別名・表示名のどれかに)含まれる項目を返す
function searchKeycodes(text) {
  const words = String(text).toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return KEYCODES;
  return KEYCODES.filter((k) => {
    const hay = (keycodeHex(k.code) + " " + k.name + " " + k.alias + " " + k.label).toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
