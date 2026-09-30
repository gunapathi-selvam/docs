// Transformers.js lifecycle, WebGPU with wasm fallback.
// The only module that touches the model. SPEC §5

// The SDK and model are loaded dynamically on first use so a missing
// node_modules does not prevent the static server from starting (SPEC §3.2).

export const EMBEDDER_ID = 'Xenova/all-MiniLM-L6-v2@q8|d384|mean|l2';
export const EMBED_DIM = 384;
export const EMBED_MAX_TOKENS = 256;

// Transformers.js version loaded from jsDelivr on first use (SPEC §14).
export const TRANSFORMERS_VERSION = '3.7.5';

/**
 * Detect whether WebGPU is available in the current environment.
 * Returns 'webgpu' or 'wasm'. SPEC §5.3
 */
export function detectBackend() {
  if (typeof navigator !== 'undefined' && navigator.gpu) return 'webgpu';
  return 'wasm';
}

/**
 * Initialise the embedding pipeline. Resolves to an embedder object.
 *
 * One pipeline instance per session; constructing it downloads and compiles
 * the model. SPEC §5.2
 *
 * @param {{ onProgress?: fn, backend?: 'webgpu'|'wasm' }} opts
 * @returns {{ backend: string, dim: number, embed: fn, dispose: fn }}
 * SPEC §5.2
 */
export async function createEmbedder({ onProgress, backend } = {}) {
  const chosenBackend = backend ?? detectBackend();

  // Transformers.js is loaded from jsDelivr CDN at runtime. A missing
  // node_modules never prevents this because it is a dynamic import of a URL.
  const CDN_URL = `https://cdn.jsdelivr.net/npm/@xenova/transformers@${TRANSFORMERS_VERSION}/dist/transformers.min.js`;

  let pipeline;
  try {
    ({ pipeline } = await import(CDN_URL));
  } catch (err) {
    throw new Error(`Failed to load Transformers.js from CDN (${CDN_URL}): ${err?.message}`);
  }

  const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
  const DTYPE = 'q8';

  let embedFn;
  let actualBackend = chosenBackend;

  // Attempt WebGPU first; fall back to wasm. The try/catch wraps a warm-up
  // inference so a driver failure at first inference is also caught. SPEC §5.3
  if (chosenBackend === 'webgpu') {
    try {
      embedFn = await pipeline('feature-extraction', MODEL_ID, {
        dtype: DTYPE,
        device: 'webgpu',
        progress_callback: onProgress,
      });
      // Warm-up inference to catch WebGPU failures before the first real call.
      await embedFn('warm-up', { pooling: 'mean', normalize: true });
    } catch (gpuErr) {
      onProgress?.({
        status: 'fallback',
        message: `WebGPU failed (${gpuErr?.message ?? gpuErr}), falling back to wasm.`,
      });
      actualBackend = 'wasm';
      embedFn = null;
    }
  }

  if (!embedFn) {
    try {
      embedFn = await pipeline('feature-extraction', MODEL_ID, {
        dtype: DTYPE,
        device: 'wasm',
        progress_callback: onProgress,
      });
    } catch (err) {
      throw new Error(`Failed to load embedding model on wasm: ${err?.message}`);
    }
  }

  /**
   * Embed an array of texts in batches of 32. Returns a flat Float32Array of
   * n×EMBED_DIM, plus a count of chunks that exceeded EMBED_MAX_TOKENS. SPEC §5.2
   *
   * @param {string[]} texts
   * @returns {Promise<{vectors: Float32Array, truncated: number}>}
   */
  async function embed(texts) {
    const BATCH_SIZE = 32;
    const all = new Float32Array(texts.length * EMBED_DIM);
    let truncated = 0;
    let normChecked = false;

    for (let start = 0; start < texts.length; start += BATCH_SIZE) {
      const batch = texts.slice(start, start + BATCH_SIZE);
      const out = await embedFn(batch, { pooling: 'mean', normalize: true });

      // out.data is a flat Float32Array of batch.length × EMBED_DIM
      const data = out.data ?? out;
      all.set(data, start * EMBED_DIM);

      // Verify normalisation on the first vector of the first batch. SPEC §5.4
      if (!normChecked && data.length >= EMBED_DIM) {
        let norm = 0;
        for (let i = 0; i < EMBED_DIM; i++) norm += data[i] * data[i];
        norm = Math.sqrt(norm);
        if (Math.abs(norm - 1) > 1e-3) {
          throw new Error(`Embedding model did not normalise output (norm=${norm.toFixed(4)}). Expected 1 ± 0.001.`);
        }
        normChecked = true;
      }

      // Count truncated by comparing estimated token count vs model window.
      for (const t of batch) {
        // estimateTokens is not imported here; use the same heuristic inline.
        if (Math.ceil(t.length / 4) > EMBED_MAX_TOKENS) truncated++;
      }

      onProgress?.({ status: 'embedding', progress: Math.min(1, (start + batch.length) / texts.length) });
    }

    return { vectors: all, truncated };
  }

  return {
    backend: actualBackend,
    dim: EMBED_DIM,
    embed,
    async dispose() {
      try { await embedFn?.dispose?.(); } catch { /* ignore */ }
    },
  };
}
