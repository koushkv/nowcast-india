// The browser U-Net (public/js/ai.js) must reproduce PyTorch's output for the exported model.
// Run after `python test/py/test_train.py` has written test/tmp-ai/.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModel, forward, trustWeights } from '../public/js/ai.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'tmp-ai');
const fetchImpl = async (url) => {
  const name = String(url).split('/').pop().split('?')[0];
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) return new Response('missing', { status: 404 });
  return new Response(fs.readFileSync(p), { status: 200 });
};
const { model, metrics } = await loadModel('https://example.invalid/ai', fetchImpl);
assert.ok(model, 'model loads');
const xin = new Float32Array(fs.readFileSync(path.join(dir, 'fixture-in.bin')).buffer.slice(0));
const yref = new Float32Array(fs.readFileSync(path.join(dir, 'fixture-out.bin')).buffer.slice(0));
const t0 = performance.now();
const y = forward(model, { c: 7, h: 64, w: 64, d: xin });
const ms = performance.now() - t0;
let maxErr = 0;
for (let i = 0; i < yref.length; i++) maxErr = Math.max(maxErr, Math.abs(y.d[i] - yref[i]));
console.log(`JS forward on 64x64: ${ms.toFixed(0)} ms, max |JS - PyTorch| = ${maxErr.toExponential(2)}`);
assert.equal(y.d.length, yref.length);
assert.ok(maxErr < 1e-4, 'JavaScript output matches PyTorch');
// full-size window timing
const big = { c: 7, h: 128, w: 128, d: new Float32Array(7 * 128 * 128).map(() => Math.random() * 0.3) };
const t1 = performance.now();
forward(model, big);
console.log(`JS forward on 128x128: ${(performance.now() - t1).toFixed(0)} ms`);
const tw = trustWeights(metrics);
console.log('trust per lead:', tw && tw.map((v) => v.toFixed(2)).join(' '));
console.log('AI parity test passed');
