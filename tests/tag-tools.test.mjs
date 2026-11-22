import test from 'node:test';
import assert from 'node:assert/strict';
import { danbooruUrl, translateTags } from '../app/tag-tools.js';

test('Danbooru links resolve to a fixed post endpoint', () => {
  assert.equal(danbooruUrl('42'), 'https://danbooru.donmai.us/posts/42.json');
  assert.equal(danbooruUrl('https://danbooru.donmai.us/posts/42?tags=sky'), danbooruUrl('42'));
  assert.throws(() => danbooruUrl('https://example.com/posts/42'), /作品链接/);
  assert.throws(() => danbooruUrl('https://danbooru.donmai.us/posts'), /作品链接/);
});

test('translation preserves input order and rejects incomplete or failed responses', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const signal = new AbortController().signal;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://index-translate.bilibili.com/v1/chat/completions');
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'Index-Translate-35B-A3B');
    assert.equal(payload.chat_template_kwargs.enable_thinking, false);
    return Response.json({ choices: [{ message: { content: '```json\n{"1":"微笑","0":"蓝发"}\n```' } }] });
  };
  assert.deepEqual(await translateTags(['blue_hair', 'smile'], 'zh', signal), ['蓝发', '微笑']);
  globalThis.fetch = async () => Response.json({ choices: [{ message: { content: '{"0":"蓝发"}' } }] });
  await assert.rejects(translateTags(['blue_hair','smile'], 'zh', signal), /缺少词条/);
  globalThis.fetch = async () => new Response('rate limited', { status: 429 });
  await assert.rejects(translateTags(['blue_hair'], 'zh', signal), /过于频繁/);
});
