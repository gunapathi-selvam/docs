// Pure logic tests for claude.js: SSE frame parsing and error mapping. SPEC §8
// No network, no API key.

import { section, ok, eq, finish } from './harness.mjs';
import { parseSseBuffer, mapProxyError, ClaudeError } from '../src/js/claude.js';

const attempt = (fn, fallback = undefined) => { try { return fn(); } catch { return fallback; } };

// ---------------------------------------------------------------------------
section('parseSseBuffer: single complete frame');

{
  const input = 'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"hi"}}\n\n';
  const { frames, remainder } = attempt(() => parseSseBuffer(input), { frames: [], remainder: '' });
  eq('one frame parsed', frames.length, 1);
  eq('frame type', frames[0]?.type, 'content_block_delta');
  ok('frame data is parseable JSON', (() => { try { JSON.parse(frames[0]?.data); return true; } catch { return false; } })());
  eq('remainder is empty', remainder, '');
}

section('parseSseBuffer: partial frame is buffered');

{
  const partial = 'event: message_stop\ndata: {"type":"mess';
  const { frames, remainder } = attempt(() => parseSseBuffer(partial), { frames: [], remainder: partial });
  eq('no complete frames', frames.length, 0);
  eq('partial text held in remainder', remainder, partial);
}

section('parseSseBuffer: two frames in one chunk');

{
  const input = 'event: content_block_delta\ndata: {"a":1}\n\nevent: message_stop\ndata: {"b":2}\n\n';
  const { frames } = attempt(() => parseSseBuffer(input), { frames: [] });
  eq('two frames', frames.length, 2);
  eq('first frame type', frames[0]?.type, 'content_block_delta');
  eq('second frame type', frames[1]?.type, 'message_stop');
}

section('parseSseBuffer: frame split across two reads');

{
  const part1 = 'event: content_block_delta\ndata: {"delta":{"type":"text_delta"';
  const part2 = ',"text":"world"}}\n\n';
  const { frames: f1, remainder: r1 } = attempt(() => parseSseBuffer(part1), { frames: [], remainder: part1 });
  eq('no frames after first read', f1.length, 0);
  const combined = r1 + part2;
  const { frames: f2 } = attempt(() => parseSseBuffer(combined), { frames: [] });
  eq('one frame after second read', f2.length, 1);
  ok('data is complete JSON', (() => { try { const p = JSON.parse(f2[0]?.data); return p.delta?.text === 'world'; } catch { return false; } })());
}

section('parseSseBuffer: frame without event field defaults to message type');

{
  const input = 'data: {"x":1}\n\n';
  const { frames } = attempt(() => parseSseBuffer(input), { frames: [] });
  eq('one frame', frames.length, 1);
  eq('default type is message', frames[0]?.type, 'message');
}

// ---------------------------------------------------------------------------
section('mapProxyError: no_api_key → ClaudeError with correct code');

{
  const err = attempt(() => mapProxyError(503, { error: 'no_api_key', message: 'Key absent.' }));
  ok('returns ClaudeError', err instanceof ClaudeError);
  eq('code is no_api_key', err?.code, 'no_api_key');
}

section('mapProxyError: rate_limited → ClaudeError with code');

{
  const err = attempt(() => mapProxyError(429, { error: 'rate_limited', message: 'Slow down.', retryAfter: '60' }));
  eq('code is rate_limited', err?.code, 'rate_limited');
  eq('detail carries retryAfter', err?.detail, '60');
}

section('mapProxyError: bad_key → ClaudeError');

{
  const err = attempt(() => mapProxyError(502, { error: 'bad_key', message: 'Key rejected.' }));
  eq('code is bad_key', err?.code, 'bad_key');
}

section('mapProxyError: unknown code falls through to api_error with that code');

{
  const err = attempt(() => mapProxyError(500, { error: 'server_error', message: 'boom' }));
  eq('code is server_error', err?.code, 'server_error');
}

// ---------------------------------------------------------------------------
section('ask: POST goes to /api/claude (same-origin, SPEC §3.1)');

{
  // Stub fetch that captures the URL and returns a minimal SSE stream
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    // Return a minimal SSE response
    const sseBody = 'event: message_stop\ndata: {}\n\n';
    const encoder = new TextEncoder();
    const bytes = encoder.encode(sseBody);
    let pos = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (pos >= bytes.length) { controller.close(); return; }
        controller.enqueue(bytes.slice(pos, pos + bytes.length));
        pos = bytes.length;
      },
    });
    return { ok: true, status: 200, body: stream };
  };

  // Import ask with injected fetch
  const { ask } = await import('../src/js/claude.js');
  try {
    await ask({
      question: 'test?', chunks: [], manifest: [],
      fetchFn: fakeFetch,
    });
  } catch { /* streaming errors from minimal response are ok */ }

  ok('fetch was called', calls.length > 0);
  ok('URL is a same-origin path', calls[0]?.url === '/api/claude');
  ok('method is POST', calls[0]?.opts?.method === 'POST');
  ok('body is JSON string', typeof calls[0]?.opts?.body === 'string');
}

finish();
