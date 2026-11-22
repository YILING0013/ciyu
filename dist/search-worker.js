import {matchesContent, contentStatuses} from './content-policy.js';
let annotations = Object.create(null);
let translations = Object.create(null);
// 全量搜索放在独立线程；页面只接收当前页，避免把几十万条数据放进 DOM。
let rows = [];
let normalized = [];
let exactRows = new Map();
let ready = false;
let cachedKey = '';
let cachedMatches = [];
let lastQuery = null;
let lastSuggest = null;
let loading = false;
let sourceRows = [];
let sourceKey = '';
const normalize = value => value.normalize('NFKC').toLowerCase().replace(/\s+/g, '_');
const franchiseSampleSize = 3;

self.onmessage = ({data}) => {
  if (data.type === 'init') load(data.manifest);
  if (data.type === 'query') {
    lastQuery = data;
    if (ready) query(data);
  }
  if (data.type === 'suggest') {
    lastSuggest = data;
    suggest(data);
  }
  if (data.type === 'lookup') {
    self.postMessage({type:'lookup', id:data.id, rows:data.texts.map(text => {
      const row = exactRows.get(normalize(text.trim()));
      return row ? displayRow(row) : null;
    })});
  }
};

/**
 * 读取同源快照并核对指纹与源版本。
 * @param {object} pointer 清单中的文件、指纹和记录数。
 * @param {string} label 用于错误提示的快照名称。
 * @param {string} sourceCommit 固定词库提交。
 * @returns {Promise<object>} 已验证的快照。
 */
async function loadSnapshot(pointer, label, sourceCommit) {
  if (!pointer) throw new Error(`缺少${label}快照，已停止展示`);
  const response = await fetch(new URL(`data/${pointer.file}`, self.location.href), {signal:AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error(`${label}快照加载失败，已停止展示`);
  const bytes = await response.arrayBuffer();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  if (digest !== pointer.sha256) throw new Error(`${label}快照指纹不匹配`);
  const snapshot = JSON.parse(new TextDecoder().decode(bytes));
  if (snapshot.source_commit !== sourceCommit) throw new Error(`${label}与词库版本不一致`);
  if (!snapshot.records || Array.isArray(snapshot.records) || typeof snapshot.records !== 'object'
      || Object.keys(snapshot.records).length !== pointer.count) throw new Error(`${label}快照记录数不一致`);
  return snapshot;
}

/**
 * 在后台构建完整新索引，验证成功后一次替换；失败继续使用原索引。
 * @param {object} manifest 同源网页数据清单。
 * @returns {Promise<void>} 通过 ready、error 或 update-error 消息报告结果。
 */
async function load(manifest) {
  if (loading) return;
  loading = true;
  const refreshing = ready;
  let loaded = 0;
  let cursor = 0;
  try {
    const classification = await loadSnapshot(manifest.classification, '分类', manifest.commit);
    const nextAnnotations = Object.assign(Object.create(null), classification.records);
    const corrections = await loadSnapshot(manifest.translations, '译文纠错', manifest.commit);
    if (corrections.schema_version !== 2 || corrections.review_status !== 'ai_draft'
        || corrections.human_reviewed !== false) throw new Error('译文纠错状态无效');
    for (const [name, value] of Object.entries(corrections.records)) {
      if (!Object.hasOwn(nextAnnotations, name) || typeof value !== 'string' || !value.trim()) {
        throw new Error('译文纠错记录无效');
      }
    }
    const nextTranslations = Object.assign(Object.create(null), corrections.records);
    const nextSourceKey = JSON.stringify([manifest.commit, manifest.chunks]);
    let nextSourceRows = sourceRows;
    if (nextSourceKey !== sourceKey) {
      const chunks = new Array(manifest.chunks.length);
      // 分类更新复用原始分片；四个并发请求只用于首次加载或源版本变化。
      const downloads = await Promise.allSettled(Array.from({length:4}, async () => {
        while (cursor < manifest.chunks.length) {
          const index = cursor++;
          const response = await fetch(new URL(`data/${manifest.chunks[index]}`, self.location.href), {signal:AbortSignal.timeout(30000)});
          if (!response.ok) throw new Error(`数据分块 ${index + 1} 加载失败（${response.status}）`);
          chunks[index] = await response.json();
          loaded += chunks[index].length;
          self.postMessage({type:'progress', loaded, total:manifest.total});
        }
      }));
      // 等当前批次全部结束后再允许重试，避免旧下载覆盖新一轮的进度。
      const failed = downloads.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      nextSourceRows = chunks.flat();
    }
    if (nextSourceRows.length !== manifest.total) throw new Error('网页词库总数与清单不一致');
    const remaining = new Set(Object.keys(nextAnnotations));
    const nextRows = nextSourceRows.map(row => {
      const annotation = nextAnnotations[row[0]];
      if (!remaining.delete(row[0]) || !Array.isArray(annotation)
          || !contentStatuses.includes(annotation[0]) || !Array.isArray(annotation[1])) {
        throw new Error('网页词库包含重复或无有效分类的词条');
      }
      const correction = nextTranslations[row[0]];
      if (correction === undefined) return row;
      if (correction === row[2]) throw new Error('纠错译文与原译相同');
      return [row[0], row[1], correction, row[3]];
    });
    if (remaining.size) throw new Error('网页词库缺少分类对应的标签');
    const nextNormalized = nextRows.map(row => `${normalize(row[0])}\n${normalize(row[2] || '')}`);
    // 导入使用精确匹配，不拿模糊搜索的首项当作译文；英文键优先于中文同名。
    const nextExactRows = new Map();
    for (const row of nextRows) {
      if (row[2] && !nextExactRows.has(normalize(row[2]))) nextExactRows.set(normalize(row[2]), row);
    }
    for (const row of nextRows) nextExactRows.set(normalize(row[0]), row);
    // 父类按词条去重计数，避免同一词条的多个子类被重复相加。
    const facets = Object.fromEntries(contentStatuses.map(status => [status, {total:0, topics:{}}]));
    const franchiseReferences = Object.fromEntries(contentStatuses.map(status => [status, {}]));
    for (const row of nextRows) {
      const [status, topics] = nextAnnotations[row[0]];
      facets[status].total++;
      for (const topic of new Set(topics.flatMap(value => [value, value.split('/')[0]]))) {
        facets[status].topics[topic] = (facets[status].topics[topic] || 0) + 1;
        if (topic.startsWith('franchise/')) {
          // 原始分片已按引用量降序导出，每个状态的前三项足以计算合并后的前三项。
          const counts = franchiseReferences[status][topic] ??= [];
          if (counts.length < franchiseSampleSize) counts.push(row[3]);
        }
      }
    }
    annotations = nextAnnotations;
    translations = nextTranslations;
    rows = nextRows;
    normalized = nextNormalized;
    exactRows = nextExactRows;
    sourceRows = nextSourceRows;
    sourceKey = nextSourceKey;
    cachedKey = '';
    cachedMatches = [];
    ready = true;
    self.postMessage({type:'ready', taxonomy:classification.taxonomy, facets, franchiseReferences, franchiseSampleSize});
    // 更新后由页面重发当前筛选的第一页，不能追加上一版的分页响应。
    if (!refreshing && lastQuery) query(lastQuery);
    if (!refreshing && lastSuggest) suggest(lastSuggest);
  } catch (error) {
    self.postMessage({type:refreshing ? 'update-error' : 'error', message:error.message});
  } finally {
    loading = false;
  }
}

/**
 * 将生效译文、分类与校对标记一起交给展示层，查询和联想使用同一结构。
 * @param {Array} row 生效词条；英文名、上游类别和引用量不变。
 * @returns {Array} 附内容分区、主题及校对标记的词条。
 */
function displayRow(row) {
  return [...row, ...annotations[row[0]], Object.hasOwn(translations, row[0])];
}

function query(data) {
  const {q, category, sort, favorites, section, page, size, id, content, topics = [], scope = 'current'} = data;
  const key = JSON.stringify([q, category, sort, favorites, section, content, topics, scope]);
  const needle = normalize(q.trim());
  const globalSearch = scope === 'all' && !!needle;
  const activeTopics = globalSearch ? [] : topics;
  const tokens = q.trim().normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean);
  if (cachedKey !== key) {
    const favoriteSet = new Set(favorites);
    cachedMatches = [];
    for (let i = 0; i < rows.length; i++) {
      if (!matchesContent(annotations[rows[i][0]], content, activeTopics)) continue;
      if (!globalSearch && category !== 'all' && rows[i][1] !== Number(category)) continue;
      if (!globalSearch && section === 'favorites' && !favoriteSet.has(rows[i][0])) continue;
      if (needle && !normalized[i].includes(needle) && !tokens.every(token => normalized[i].includes(token))) continue;
      cachedMatches.push(i);
    }
    if (sort === 'name') cachedMatches.sort((a,b) => rows[a][0].localeCompare(rows[b][0], 'en'));
    if (sort === 'least') cachedMatches.sort((a,b) => rows[a][3] - rows[b][3] || a - b);
    if (sort === 'relevance' && needle) {
      const score = i => {
        const name = normalize(rows[i][0]);
        const cn = normalize(rows[i][2] || '');
        return name === needle || cn === needle ? 0 : name.startsWith(needle) || cn.startsWith(needle) ? 1 : 2;
      };
      cachedMatches.sort((a,b) => score(a) - score(b) || a - b);
    }
    cachedKey = key;
  }
  const safePage = Math.max(1, Math.min(page, Math.ceil(cachedMatches.length / size) || 1));
  self.postMessage({type:'results', id, total:cachedMatches.length, page:safePage, rows:cachedMatches.slice((safePage - 1) * size, safePage * size).map(i => displayRow(rows[i]))});
}

function suggest(data) {
  const needle = normalize(data.q.trim());
  if (!needle || !ready) {
    self.postMessage({type:'suggestions', id:data.id, rows:[], pending:!ready});
    return;
  }
  const exact = [], prefix = [], contains = [];
  const globalSearch = data.scope === 'all';
  const activeTopics = globalSearch ? [] : data.topics || [];
  for (let i = 0; i < rows.length; i++) {
    if (!matchesContent(annotations[rows[i][0]], data.content, activeTopics)) continue;
    if (!globalSearch && data.section === 'favorites' && !(data.favorites || []).includes(rows[i][0])) continue;
    if (!globalSearch && data.category !== 'all' && rows[i][1] !== Number(data.category)) continue;
    const name = normalize(rows[i][0]);
    const cn = normalize(rows[i][2] || '');
    if (name === needle || cn === needle) exact.push(rows[i]);
    else if (name.startsWith(needle) || cn.startsWith(needle)) { if (prefix.length < 8) prefix.push(rows[i]); }
    else if (contains.length < 8 && normalized[i].includes(needle)) contains.push(rows[i]);
  }
  self.postMessage({type:'suggestions', id:data.id, rows:[...exact, ...prefix, ...contains].slice(0,8).map(displayRow)});
}
