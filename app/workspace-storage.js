export const schemes = { system: "跟随系统", light: "浅色", dark: "深色" };
export const accents = { indigo: "靛蓝", jade: "松绿", amber: "赭橙" };
export const densities = { compact: "紧凑", standard: "标准", large: "大字" };
export const editorLabels = {
  "zh-en": "中文在上",
  "en-zh": "英文在上",
  zh: "仅中文",
  en: "仅英文",
};

export const defaultPreferences = {
  scheme: "system",
  accent: "indigo",
  density: "standard",
  editorDensity: "standard",
  editorLabel: "zh-en",
  accordion: true,
  suggestions: true,
};

export const defaultWorkspace = {
  favorites: [],
  entries: [],
  notes: [],
  format: "nai",
  view: "pills",
  preferences: defaultPreferences,
};

const storeName = "workspace";
const stateKey = "current";
const backupKind = "tag-atlas-backup";
const isText = (value) => typeof value === "string" && value.trim().length > 0;
const isFormat = (value) => value === "nai" || value === "sd";
const isView = (value) => value === "pills" || value === "table";

/**
 * 校验顶层提示词和组内词条。相同英文名可以重复，每个实例的 ID 必须唯一。
 * @param {unknown} entries 提示词草稿或笔记中的词条列表。
 * @returns {boolean} 是否符合编辑器的数据结构。
 */
function validEntries(entries) {
  if (!Array.isArray(entries)) return false;
  const ids = new Set();
  return entries.every((entry) => {
    if (!entry || !isText(entry.id) || ids.has(entry.id) || !Number.isFinite(entry.weight)) return false;
    ids.add(entry.id);
    if (entry.type === "tag") return isText(entry.name) && typeof entry.cn === "string";
    return entry.type === "group" && typeof entry.name === "string" &&
      Array.isArray(entry.items) && entry.items.length > 0 && entry.items.every((term) => {
        if (!term || term.type !== "tag" || !isText(term.id) || ids.has(term.id) ||
            !isText(term.name) || typeof term.cn !== "string" || !Number.isFinite(term.weight)) return false;
        ids.add(term.id);
        return true;
      });
  });
}

function legacyWorkspace() {
  const saved = {};
  // 四项旧数据单独读取，损坏的一项不会阻止其余数据迁移。
  for (const field of ["favorites", "prompt", "view", "preferences"]) {
    try {
      const value = localStorage.getItem(`tag-atlas-${field}`);
      saved[field] = field === "view" ? value : JSON.parse(value);
    } catch {
      // 浏览器阻止旧存储读取，或旧值不是有效的 JSON。
    }
  }
  const { favorites, prompt, view, preferences } = saved;
  const hasDraft = prompt?.version === 1 && validEntries(prompt.entries);
  return {
    ...defaultWorkspace,
    favorites: Array.isArray(favorites) ? [...new Set(favorites.filter(isText))] : [],
    entries: hasDraft ? prompt.entries : [],
    format: hasDraft && isFormat(prompt.format) ? prompt.format : defaultWorkspace.format,
    view: isView(view) ? view : defaultWorkspace.view,
    preferences: {
      ...defaultPreferences,
      scheme: Object.hasOwn(schemes, preferences?.scheme) ? preferences.scheme : defaultPreferences.scheme,
      accent: Object.hasOwn(accents, preferences?.accent) ? preferences.accent : defaultPreferences.accent,
      density: Object.hasOwn(densities, preferences?.density) ? preferences.density : defaultPreferences.density,
      accordion: preferences?.accordion !== false,
      suggestions: preferences?.suggestions !== false,
    },
  };
}

/**
 * 读取或更新工作区。读和写处在同一个事务，多标签页修改不同字段时会保留各自的更新。
 * @param {IDBDatabase} database 当前页面的数据库连接。
 * @param {object} patch 待保存的字段；空对象只读已有数据，必要时迁移。
 * @returns {Promise<object>} 事务提交后的工作区快照。
 */
export async function saveWorkspace(database, patch) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const request = store.get(stateKey);
    let data;
    request.onsuccess = () => {
      const existing = request.result;
      data = { ...(existing ?? legacyWorkspace()), ...patch };
      data.preferences = { ...defaultPreferences, ...data.preferences };
      if (!existing || Object.keys(patch).length > 0) store.put(data, stateKey);
    };
    transaction.oncomplete = () => resolve(data);
    transaction.onabort = () => reject(transaction.error);
  });
}

/**
 * 打开本机工作区数据库，首次使用时在事务内迁移旧版浏览器数据。
 * @returns {Promise<{database: IDBDatabase, data: object}>} 连接和个人数据。
 */
export async function openWorkspace() {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open("tag-atlas", 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.onversionchange = () => database.close();
  try {
    return { database, data: await saveWorkspace(database, {}) };
  } catch (error) {
    database.close();
    throw error;
  }
}

/**
 * 生成可通过设置页恢复的个人数据备份。
 * @param {object} data 当前工作区快照。
 * @returns {string} 带版本号的 JSON 文本。
 */
export function serializeBackup(data) {
  return JSON.stringify({ kind: backupKind, version: 1, data }, null, 2);
}

/**
 * 预先校验整个备份，防止部分写入或损坏当前工作区。
 * @param {string} text 待恢复的 JSON 文本。
 * @returns {object} 可整体写入的个人数据。
 */
export function parseBackup(text) {
  const backup = JSON.parse(text);
  if (backup?.kind !== backupKind || backup.version !== 1 || !backup.data) {
    throw new Error("请选择词屿导出的 JSON 备份");
  }
  const { favorites, entries, notes, format, view, preferences } = backup.data;
  if (
    !Array.isArray(favorites) || !favorites.every(isText) ||
    !validEntries(entries) || !isFormat(format) || !isView(view) ||
    !Array.isArray(notes) || !notes.every((note) =>
      note && isText(note.id) && isText(note.title) && isFormat(note.format) &&
      validEntries(note.entries) && note.entries.length > 0) ||
    new Set(notes.map((note) => note.id)).size !== notes.length ||
    !preferences || !Object.hasOwn(schemes, preferences.scheme) ||
    !Object.hasOwn(accents, preferences.accent) ||
    !Object.hasOwn(densities, preferences.density) ||
    !Object.hasOwn(densities, preferences.editorDensity) ||
    (preferences.editorLabel !== undefined && !Object.hasOwn(editorLabels, preferences.editorLabel)) ||
    typeof preferences.accordion !== "boolean" || typeof preferences.suggestions !== "boolean"
  ) throw new Error("备份数据不完整或格式错误");
  return {
    favorites: [...new Set(favorites)],
    entries, notes, format, view,
    preferences: {
      scheme: preferences.scheme,
      accent: preferences.accent,
      density: preferences.density,
      editorDensity: preferences.editorDensity,
      editorLabel: preferences.editorLabel ?? defaultPreferences.editorLabel,
      accordion: preferences.accordion,
      suggestions: preferences.suggestions,
    },
  };
}
