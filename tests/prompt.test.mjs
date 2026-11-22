import test from 'node:test';
import assert from 'node:assert/strict';
import {serializePrompt, mergePrompts, ungroupPrompt, movePrompt} from '../app/prompt.js';

const tags = [
  {id:'a', type:'tag', name:'blue_hair', cn:'蓝发', weight:1.2},
  {id:'b', type:'tag', name:'smile', cn:'微笑', weight:1.2},
  {id:'c', type:'tag', name:'outdoors', cn:'户外', weight:1},
];

test('numeric formats support neutral, zero, negative and escaped SD tag names', () => {
  const entries = [...tags, {id:'d', type:'tag', name:'name_(series)', weight:0}, {id:'e', type:'tag', name:'hat', weight:-.5}];
  assert.equal(serializePrompt(entries, 'nai'), '1.2::blue_hair::, 1.2::smile::, outdoors, 0::name_(series)::, -0.5::hat::');
  assert.equal(serializePrompt(entries, 'sd'), '(blue_hair:1.2), (smile:1.2), outdoors, (name_\\(series\\):0), (hat:-0.5)');
});

test('merging, moving and dissolving preserve order and effective member weights', () => {
  let merged = mergePrompts(tags, ['a','b'], 'group');
  assert.equal(serializePrompt(merged, 'nai'), '1.2::blue_hair, smile::, outdoors');
  merged = merged.map(entry => entry.id === 'group' ? {...entry, weight:1.5} : entry);
  assert.equal(serializePrompt(merged, 'sd'), '(blue_hair, smile:1.8), outdoors');
  merged = movePrompt(merged, 'group', 1);
  assert.equal(serializePrompt(merged, 'nai'), 'outdoors, 1.8::blue_hair, smile::');
  const split = ungroupPrompt(merged, 'group');
  assert.deepEqual(split.map(entry => [entry.id, entry.weight]), [['c',1],['a',1.8],['b',1.8]]);
  assert.deepEqual(tags.map(entry => entry.weight), [1.2,1.2,1]);
});

test('merging groups flattens effective weights without nested NovelAI emphasis', () => {
  const first = mergePrompts(tags, ['a','c'], 'first');
  first[0].weight = 2;
  const second = mergePrompts(first, ['first','b'], 'second');
  assert.deepEqual(second[0].items.map(entry => [entry.name, entry.weight]), [['blue_hair',2.4],['outdoors',2],['smile',1.2]]);
  assert.equal(serializePrompt(second, 'nai'), '2.4::blue_hair::, 2::outdoors::, 1.2::smile::');
  assert.equal(serializePrompt(second, 'sd'), '(blue_hair:2.4), (outdoors:2), (smile:1.2)');
  assert.equal(mergePrompts(tags, ['a'], 'noop'), tags);
});

test('drop inserts around targets in both directions and merges at target position', async () => {
  const {dropPrompt} = await import('../app/prompt.js');
  assert.deepEqual(dropPrompt(tags, 'a', 'c', 'after', 'g').map(x => x.id), ['b','c','a']);
  assert.deepEqual(dropPrompt(tags, 'a', 'c', 'before', 'g').map(x => x.id), ['b','a','c']);
  assert.deepEqual(dropPrompt(tags, 'c', 'a', 'before', 'g').map(x => x.id), ['c','a','b']);
  const merged = dropPrompt(tags, 'a', 'c', 'merge', 'g');
  assert.deepEqual(merged.map(x => x.id), ['b','g']);
  assert.deepEqual(merged[1].items.map(x => x.id), ['c','a']);
  merged[1].name = '场景';
  merged[1].weight = 2;
  const nested = dropPrompt(merged, 'b', 'g', 'merge', 'unused');
  assert.equal(nested[0].name, '场景');
  assert.deepEqual(nested[0].items.map(x => [x.id,x.weight]), [['c',2],['a',2.4],['b',1.2]]);
  assert.equal(dropPrompt(tags, 'a', 'a', 'merge', 'g'), tags);
});
