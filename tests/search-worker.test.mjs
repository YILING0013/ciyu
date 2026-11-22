import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';

const sourceCommit = 'a'.repeat(40);
const statuses = ['normal', 'sensitive', 'nsfw'];

function fixture() {
  const rows = [...statuses, 'withdrawn', 'unchanged', 'character'].map((name, i) => [name, 0, `原译${name}`, 100 - i]);
  rows.find(row => row[0] === 'withdrawn')[2] = null;
  const classification = {source_commit:sourceCommit, taxonomy:{}, records:Object.fromEntries(
    [...statuses, 'withdrawn', 'unchanged', 'character'].map(name => [name, [statuses.includes(name) ? name : name === 'character' ? 'sensitive' : 'normal', name === 'character' ? [] : ['object/item']]]))};
  const translations = {source_commit:sourceCommit, schema_version:2, review_status:'ai_draft', human_reviewed:false,
    records:Object.fromEntries(statuses.map(name => [name, `纠正译文${name}`]))};
  return {rows, classification, translations};
}

/**
 * 运行实际搜索线程模块，以确定性同源响应覆盖其加载和消息接口。
 * @param {object} t 测试上下文，负责恢复全局对象。
 * @param {object} data 分类、纠错及原始词条夹具。
 * @param {Function} changeManifest 可选清单故障注入。
 * @returns {Promise<object>} 消息发送与接收接口。
 */
async function startWorker(t, data, changeManifest = () => {}) {
  const saved = {self:globalThis.self, fetch:globalThis.fetch};
  t.after(() => Object.assign(globalThis, saved));
  const bodies = new Map();
  const requests = [];
  /**
   * 在同一浏览器会话中发布下一份测试快照。
   * @param {object} next 新分类、纠错及词条。
   * @returns {object} 对应网页清单。
   */
  function publish(next) {
    const manifest = {commit:sourceCommit, total:next.rows.length, chunks:['chunk.json']};
    for (const kind of ['classification', 'translations']) {
      const bytes = Buffer.from(JSON.stringify(next[kind]));
      const digest = createHash('sha256').update(bytes).digest('hex');
      const file = `${kind}-${digest}.json`;
      bodies.set(`/data/${file}`, bytes);
      manifest[kind] = {file, sha256:digest, count:Object.keys(next[kind].records).length};
    }
    bodies.set('/data/chunk.json', Buffer.from(JSON.stringify(next.rows)));
    return manifest;
  }
  const manifest = publish(data);
  changeManifest(manifest);
  const queued = [], waiting = [];
  globalThis.self = {location:{href:'https://atlas.test/search-worker.js'}, postMessage(message) {
    const index = waiting.findIndex(item => item.type === message.type);
    if (index >= 0) waiting.splice(index, 1)[0].resolve(message); else queued.push(message);
  }};
  globalThis.fetch = async url => {
    requests.push(new URL(url).pathname);
    const bytes = bodies.get(new URL(url).pathname);
    return new Response(bytes || 'missing', {status:bytes ? 200 : 404});
  };
  await import(`../dist/search-worker.js?case=${crypto.randomUUID()}`);
  const receive = type => {
    const index = queued.findIndex(item => item.type === type);
    return index >= 0 ? Promise.resolve(queued.splice(index, 1)[0])
      : new Promise(resolve => waiting.push({type, resolve}));
  };
  const send = data => self.onmessage({data});
  send({type:'init', manifest});
  return {receive, send, publish, requests, async request(data, type = 'results') {
    send({type:type === 'results' ? 'query' : 'suggest', q:'', category:'all', content:'normal',
      topics:[], sort:'popular', section:'browse', favorites:[], page:1, size:24, id:1, ...data});
    return receive(type);
  }};
}

test('effective translations drive results, suggestions and favorites without changing partitions', {timeout:10000}, async t => {
  const data = fixture();
  const worker = await startWorker(t, data);
  await worker.receive('ready');
  const all = await worker.request({});
  assert.deepEqual(all.rows.map(row => row[0]), ['normal', 'withdrawn', 'unchanged']);
  assert.equal(all.rows[0][2], '纠正译文normal');
  assert.equal(all.rows[0][6], true);
  assert.deepEqual(all.rows.slice(1).map(row => [row[2], row[6]]), [[null, false], ['原译unchanged', false]]);
  for (const responseType of ['results', 'suggestions']) {
    const matched = await worker.request({q:'纠正译文'}, responseType);
    assert.deepEqual(matched.rows.map(row => row[0]), ['normal']);
    assert.equal(matched.rows[0][2], '纠正译文normal');
    assert.equal((await worker.request({q:'原译normal'}, responseType)).rows.length, 0);
    assert.equal((await worker.request({q:'纠正译文', topics:['missing/topic']}, responseType)).rows.length, 0);
    assert.equal((await worker.request({q:'纠正译文', category:'5'}, responseType)).rows.length, 0);
    for (const status of statuses) {
      const result = await worker.request({q:'纠正译文', content:status, section:'favorites', favorites:statuses}, responseType);
      assert.deepEqual(result.rows.map(row => row[0]), [status]);
      assert.equal(result.rows[0][4], status);
      assert.equal(result.rows[0][6], true);
    }
  }
  assert.deepEqual((await worker.request({content:'unclassified'})).rows, []);
  assert.deepEqual((await worker.request({q:'原译withdrawn'})).rows, []);
});

test('live updates swap translations and partitions together, retry failures and allow rollback', {timeout:10000}, async t => {
  const original = fixture();
  const worker = await startWorker(t, original);
  await worker.receive('ready');
  await worker.request({page:2, size:2});
  const updated = structuredClone(original);
  updated.classification.records.withdrawn[0] = 'sensitive';
  updated.translations.records.normal = '新版普通译文';
  // 新数据尚未验证时，查询仍可完整使用上一版。
  const nextManifest = worker.publish(updated);
  worker.send({type:'init', manifest:nextManifest});
  assert.equal((await worker.request({q:'纠正译文normal'})).rows[0][2], '纠正译文normal');
  const next = await worker.receive('ready');
  assert.equal(next.facets.normal.total, 2);
  assert.deepEqual((await worker.request({})).rows.map(row => row[0]), ['normal', 'unchanged']);
  assert.equal((await worker.request({q:'新版普通'}, 'suggestions')).rows[0][2], '新版普通译文');
  worker.send({type:'lookup', id:'fresh', texts:['新版普通译文']});
  assert.equal((await worker.receive('lookup')).rows[0][0], 'normal');
  assert.equal(worker.requests.filter(path => path === '/data/chunk.json').length, 1);

  const broken = worker.publish(original);
  broken.translations.sha256 = '0'.repeat(64);
  worker.send({type:'init', manifest:broken});
  assert.ok((await worker.receive('update-error')).message);
  assert.equal((await worker.request({q:'新版普通'})).rows[0][2], '新版普通译文');
  assert.equal((await worker.request({section:'favorites', favorites:['withdrawn']})).rows.length, 0);

  worker.send({type:'init', manifest:worker.publish(original)});
  await worker.receive('ready');
  assert.equal((await worker.request({q:'纠正译文normal'})).rows[0][2], '纠正译文normal');
  assert.equal((await worker.request({q:'新版普通'})).rows.length, 0);
  assert.equal((await worker.request({page:2, size:2})).rows[0][0], 'unchanged');
});

test('invalid correction snapshots stop all results and suggestions', {timeout:20000}, async t => {
  const cases = [
    ['missing snapshot', () => {}, manifest => delete manifest.translations],
    ['fingerprint mismatch', () => {}, manifest => manifest.translations.sha256 = '0'.repeat(64)],
    ['count mismatch', () => {}, manifest => manifest.translations.count++],
    ['source mismatch', data => data.translations.source_commit = 'b'.repeat(40)],
    ['human approval claim', data => data.translations.human_reviewed = true],
    ['pending candidate', data => data.translations.records.normal = {decision:'needs_review'}],
    ['invalid draft status', data => data.translations.review_status = 'approved'],
    ['unchanged translation', data => data.translations.records.normal = '原译normal'],
    ['missing source tag', data => data.rows = data.rows.filter(row => row[0] !== 'normal')],
    ['unclassified correction', data => delete data.classification.records.normal],
    ['unclassified non-correction', data => delete data.classification.records.character],
    ['archived state', data => data.classification.records.character[0] = 'unknown'],
  ];
  for (const [name, alter, alterManifest] of cases) {
    await t.test(name, {timeout:5000}, async t => {
      const data = fixture(); alter(data);
      const worker = await startWorker(t, data, alterManifest);
      assert.ok((await worker.receive('error')).message);
      const suggestions = await worker.request({q:'纠正译文'}, 'suggestions');
      assert.deepEqual(suggestions.rows, []);
      assert.equal(suggestions.pending, true);
    });
  }
});

test('published data has a classification for every tag and only effective corrections', () => {
  const base = new URL('../dist/data/', import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', base)));
  const load = kind => {
    const pointer = manifest[kind];
    const bytes = fs.readFileSync(new URL(pointer.file, base));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), pointer.sha256);
    const snapshot = JSON.parse(bytes);
    assert.equal(snapshot.source_commit, manifest.commit);
    assert.equal(Object.keys(snapshot.records).length, pointer.count);
    return snapshot;
  };
  const { records: classes } = load('classification');
  const corrections = load('translations');
  assert.equal(corrections.schema_version, 2);
  assert.equal(corrections.human_reviewed, false);
  const tags = new Map(manifest.chunks.flatMap(file => JSON.parse(fs.readFileSync(new URL(file, base))))
    .map(([name, , cn]) => [name, cn]));
  assert.equal(tags.size, manifest.total);
  assert.equal(Object.keys(classes).length, tags.size);
  for (const [name, [status]] of Object.entries(classes)) {
    assert.ok(tags.has(name));
    assert.ok(statuses.includes(status));
  }
  for (const [name, cn] of Object.entries(corrections.records)) {
    assert.ok(tags.has(name));
    assert.ok(typeof cn === 'string' && cn.trim() && cn !== tags.get(name));
  }
});

test('partition facets count parent tags once and parent queries include their children', async t => {
  const data = fixture();
  data.classification.records.normal[1] = ['appearance/hair_color', 'appearance/hair_length'];
  data.classification.records.withdrawn[1] = ['appearance/hair_color'];
  data.classification.records.sensitive[1] = ['clothing/swimwear'];
  const worker = await startWorker(t, data);
  const {facets} = await worker.receive('ready');
  assert.equal(facets.normal.total, 3);
  assert.equal(facets.normal.topics.appearance, 2);
  assert.equal(facets.normal.topics['appearance/hair_color'], 2);
  assert.equal(facets.normal.topics['appearance/hair_length'], 1);
  assert.equal(facets.normal.topics.clothing, undefined);
  assert.equal(facets.sensitive.topics.clothing, 1);
  assert.equal(facets.unclassified, undefined);
  assert.deepEqual((await worker.request({topics:['appearance']})).rows.map(row => row[0]), ['normal','withdrawn']);
  assert.deepEqual((await worker.request({topics:['appearance/hair_length']})).rows.map(row => row[0]), ['normal']);
  assert.deepEqual((await worker.request({q:'纠正', topics:['appearance']}, 'suggestions')).rows.map(row => row[0]), ['normal']);
});

test('franchise samples keep at most three of the most referenced tags per status', async t => {
  const data = fixture();
  const works = Array.from({length:105}, (_, i) => [`work_${i}`, 3, null, 500 - i]);
  for (const [name] of works) data.classification.records[name] = ['normal', ['franchise/series']];
  data.classification.records.work_7[1].push('franchise/short');
  data.classification.records.sensitive[1].push('franchise/series');
  data.rows.unshift(...works);
  const worker = await startWorker(t, data);
  const {facets, franchiseReferences, franchiseSampleSize} = await worker.receive('ready');
  assert.equal(franchiseSampleSize, 3);
  assert.equal(facets.normal.topics['franchise/series'], 105);
  assert.deepEqual(franchiseReferences.normal['franchise/series'], works.slice(0, 3).map(row => row[3]));
  assert.deepEqual(franchiseReferences.normal['franchise/short'], [493]);
  assert.deepEqual(franchiseReferences.sensitive['franchise/series'], [99]);
  assert.equal(franchiseReferences.normal['object/item'], undefined);
});

test('global search ignores categories but respects every enabled status', async t => {
  const worker = await startWorker(t, fixture());
  await worker.receive('ready');
  for (const responseType of ['results','suggestions']) {
    const result = await worker.request({q:'纠正译文', scope:'all', content:'normal', topics:['missing/topic'], section:'favorites', favorites:[]}, responseType);
    assert.deepEqual(result.rows.map(row => row[4]), ['normal']);
    const mixed = await worker.request({q:'纠正译文', scope:'all', content:['normal', 'nsfw']}, responseType);
    assert.deepEqual(mixed.rows.map(row => row[4]), ['normal', 'nsfw']);
    assert.equal((await worker.request({q:'纠正译文', scope:'all', content:[]}, responseType)).rows.length, 0);
    assert.equal((await worker.request({q:'character', scope:'all'}, responseType)).rows.length, 0);
    assert.equal((await worker.request({q:'character', scope:'current'}, responseType)).rows.length, 0);
    assert.deepEqual((await worker.request({q:'character', content:['unknown', 'unclassified']}, responseType)).rows, []);
  }
  const pending = await worker.request({content:['unknown', 'unclassified']});
  assert.deepEqual(pending.rows, []);
  const mixed = await worker.request({content:['normal', 'sensitive'], topics:['object']});
  assert.deepEqual(mixed.rows.map(row => row[4]), ['normal', 'sensitive', 'normal', 'normal']);
  assert.deepEqual((await worker.request({scope:'all'})).rows.map(row => row[4]), ['normal','normal','normal']);
  const first = await worker.request({size:2});
  const second = await worker.request({page:2, size:2});
  assert.deepEqual([...first.rows,...second.rows].map(row => row[0]), ['normal','withdrawn','unchanged']);
});

test('tool lookup matches exact names and corrected Chinese without changing browse partitions', {timeout:10000}, async t => {
  const worker = await startWorker(t, fixture());
  await worker.receive('ready');
  worker.send({type:'lookup', id:'tools', texts:['NORMAL','纠正译文sensitive','character','norm','missing']});
  const matched = await worker.receive('lookup');
  assert.equal(matched.id, 'tools');
  assert.deepEqual(matched.rows.map(row => row?.[0] || null), ['normal','sensitive','character',null,null]);
  assert.equal(matched.rows[1][2], '纠正译文sensitive');
  assert.deepEqual((await worker.request({})).rows.map(row => row[0]), ['normal','withdrawn','unchanged']);
});
