import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {matchesContent} from '../dist/content-policy.js';

test('missing and invalid annotations never enter normal mode', () => {
  for (const annotation of [undefined, null, [], ['invalid', []], ['unknown', []], ['sensitive', []], ['nsfw', []]]) {
    assert.equal(matchesContent(annotation), false);
  }
  assert.equal(matchesContent(undefined, 'unclassified'), false);
  assert.equal(matchesContent(['normal', []], 'all'), false);
});

test('all generated records occur in exactly their own partition; topics require all selected values', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../dist/data/manifest.json', import.meta.url)));
  const snapshot = JSON.parse(fs.readFileSync(new URL(`../dist/data/${manifest.classification.file}`, import.meta.url)));
  assert.equal(Object.keys(snapshot.records).length, manifest.classification.count);
  for (const annotation of Object.values(snapshot.records)) {
    const matches = ['normal','sensitive','nsfw'].filter(status => matchesContent(annotation, status));
    assert.deepEqual(matches, [annotation[0]]);
    assert.equal(matchesContent(annotation, annotation[0], annotation[1]), true);
    assert.equal(matchesContent(annotation, annotation[0], [...annotation[1], 'missing/topic']), false);
  }
});
