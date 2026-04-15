/**
 * lib/embedder.js  –  Smart Bookmark
 *
 * Transformer-powered embedder using @xenova/transformers (all-MiniLM-L6-v2).
 * The model (~25 MB quantised) is downloaded once on first scan and cached
 * in the browser's Cache API — no setup required.
 */

import { pipeline, env } from './transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache  = true;
// MV3 service workers do not support URL.createObjectURL.
// Disable the ONNX proxy worker and multi-threading to avoid the error.
env.backends.onnx.wasm.proxy      = false;
env.backends.onnx.wasm.numThreads = 1;

let _pipe = null;

export async function initEmbedder() {
  if (_pipe) return;
  _pipe = await pipeline(
    'feature-extraction',
    'Xenova/all-MiniLM-L6-v2',
    { quantized: true }
  );
}

export async function generateEmbedding(text) {
  if (!_pipe) await initEmbedder();
  const out = await _pipe(
    text.substring(0, 512),
    { pooling: 'mean', normalize: true }
  );
  return Array.from(out.data);
}

export const SEMANTIC_MODE = true;
