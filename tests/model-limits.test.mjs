import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_CONTEXT_SIZE,
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_CONTEXT_SIZE,
  MAX_OUTPUT_TOKENS_LIMIT,
  contextCharBudget,
  fitHistoryToContext,
  getContextSize,
  getMaxOutputTokens,
} from '../lib/model-limits.mjs';

test('konteks default tidak lagi 2048 dan mengikuti katalog', () => {
  assert.equal(getContextSize(), DEFAULT_CONTEXT_SIZE);
  assert.ok(DEFAULT_CONTEXT_SIZE >= 4096);
  assert.equal(getContextSize({ contextLength: 8192 }), 8192);
});

test('LLM_CONTEXT_SIZE menaikkan konteks dan dibatasi MAX_CONTEXT_SIZE', () => {
  assert.equal(getContextSize({ contextLength: 4096 }, { LLM_CONTEXT_SIZE: '8192' }), 8192);
  assert.equal(getContextSize({ contextLength: 4096 }, { LLM_CONTEXT_SIZE: '999999' }), MAX_CONTEXT_SIZE);
  assert.equal(getContextSize({ contextLength: 4096 }, { LLM_CONTEXT_SIZE: 'abc' }), DEFAULT_CONTEXT_SIZE);
});

test('output default jauh di atas 1024', () => {
  assert.equal(getMaxOutputTokens(), DEFAULT_MAX_OUTPUT_TOKENS);
  assert.ok(DEFAULT_MAX_OUTPUT_TOKENS > 1024);
  assert.ok(MAX_OUTPUT_TOKENS_LIMIT >= 8192);
});

test('output dibatasi ruang konteks dan env', () => {
  assert.equal(
    getMaxOutputTokens({ env: { LLM_MAX_OUTPUT_TOKENS: '8000' }, contextSize: 16384 }),
    8000
  );
  assert.equal(
    getMaxOutputTokens({ env: { LLM_MAX_OUTPUT_TOKENS: '8000' }, contextSize: 2048 }),
    1536
  );
  assert.equal(
    getMaxOutputTokens({ env: { LLM_MAX_OUTPUT_TOKENS: '999999' }, contextSize: 16384 }),
    MAX_OUTPUT_TOKENS_LIMIT
  );
  // Konteks kecil tetap menyisakan ruang jawaban minimum
  assert.equal(getMaxOutputTokens({ env: { LLM_MAX_OUTPUT_TOKENS: '999999' }, contextSize: 256 }), 256);
});

test('model besar dibatasi konteksnya, env eksplisit tetap menang', () => {
  assert.equal(getContextSize({ contextLength: 8192, sizeMb: 807 }), 4096);
  assert.equal(getContextSize({ contextLength: 8192, sizeMb: 379 }), 8192);
  assert.equal(getContextSize({ contextLength: 8192, sizeMb: 807 }, { LLM_CONTEXT_SIZE: '8192' }), 8192);
});

test('fitHistoryToContext mempertahankan system + giliran terbaru', () => {
  const history = [
    { type: 'system', text: 'S' },
    { type: 'user', text: 'a'.repeat(5000) },
    { type: 'model', response: ['b'.repeat(5000)] },
    { type: 'user', text: 'pertanyaan terbaru' },
  ];
  const { history: fitted, dropped } = fitHistoryToContext({
    systemPrompt: 'S',
    history,
    userPrompt: 'sekarang',
    contextSize: 2048,
    reservedTokens: 1024,
  });
  assert.equal(fitted[0].type, 'system');
  assert.ok(fitted.length < history.length);
  assert.ok(dropped >= 1);
  assert.equal(fitted.at(-1).text, 'pertanyaan terbaru');
  assert.ok(fitted.length >= 2);
});

test('fitHistoryToContext tidak memangkas riwayat pendek', () => {
  const history = [
    { type: 'system', text: 'S' },
    { type: 'user', text: 'hai' },
    { type: 'model', response: ['halo'] },
  ];
  const result = fitHistoryToContext({
    systemPrompt: 'S',
    history,
    userPrompt: 'lagi',
    contextSize: 8192,
    reservedTokens: 4096,
  });
  assert.equal(result.dropped, 0);
  assert.equal(result.history.length, history.length);
});

test('anggaran karakter tumbuh seiring konteks', () => {
  assert.ok(contextCharBudget(8192) > contextCharBudget(2048));
});
