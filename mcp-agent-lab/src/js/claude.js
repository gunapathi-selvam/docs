// Browser client for /api/claude. Assembles SSE stream, maps typed errors.
// No @anthropic-ai/sdk here — this is browser JS that calls the Node proxy.
// SPEC §6.6

// ---------------------------------------------------------------- error classes

export class ClaudeError extends Error {
  constructor(kind, status, message) {
    super(message);
    this.name = 'ClaudeError';
    this.kind = kind;
    this.status = status;
  }
}

export class BadRequestError extends ClaudeError {
  constructor(message) { super('bad_request', 400, message); this.name = 'BadRequestError'; }
}

export class AuthenticationError extends ClaudeError {
  constructor(message) { super('authentication', 401, message); this.name = 'AuthenticationError'; }
}

export class RateLimitError extends ClaudeError {
  constructor(message) { super('rate_limit', 429, message); this.name = 'RateLimitError'; }
}

export class NoKeyError extends ClaudeError {
  constructor(message, fixtures) {
    super('no_key', 503, message);
    this.name = 'NoKeyError';
    this.fixtures = fixtures ?? [];
    this.replay = true;
  }
}

// Map a { kind, status, message } body from the proxy to a typed error class.
function mapError(body) {
  switch (body.kind) {
    case 'bad_request': return new BadRequestError(body.message);
    case 'authentication': return new AuthenticationError(body.message);
    case 'rate_limit': return new RateLimitError(body.message);
    case 'no_key': return new NoKeyError(body.message, body.fixtures);
    default: return new ClaudeError(body.kind ?? 'api_error', body.status ?? 0, body.message ?? 'Unknown error');
  }
}

// ---------------------------------------------------------------- client

export function createClaudeClient(options) {
  const base = options?.base ?? '';

  // POST to /api/claude with stream:true. Assembles the SSE into a complete
  // response object and returns it. onChunk(rawEvent) is optional — called
  // for each parsed SSE event so callers can emit incremental UI updates.
  async function send(requestBody, onChunk) {
    const res = await fetch(`${base}/api/claude`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...requestBody, stream: true }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({ kind: 'api_error', status: res.status, message: res.statusText }));
      throw mapError(data);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Assembled response fields.
    let message = null;
    const contentBlocks = [];

    const processEvent = (event) => {
      if (onChunk) onChunk(event);
      switch (event.type) {
        case 'message_start':
          message = { ...event.message, content: [] };
          break;
        case 'content_block_start':
          contentBlocks[event.index] = { ...event.content_block };
          break;
        case 'content_block_delta': {
          const blk = contentBlocks[event.index];
          if (!blk) break;
          const d = event.delta;
          if (d.type === 'text_delta') blk.text = (blk.text ?? '') + d.text;
          else if (d.type === 'thinking_delta') blk.thinking = (blk.thinking ?? '') + d.thinking;
          else if (d.type === 'input_json_delta') blk._partial = (blk._partial ?? '') + d.partial_json;
          break;
        }
        case 'content_block_stop': {
          const blk = contentBlocks[event.index];
          if (!blk) break;
          if (blk.type === 'tool_use' && blk._partial) {
            try { blk.input = JSON.parse(blk._partial); } catch { blk.input = {}; }
            delete blk._partial;
          }
          if (message) message.content.push(blk);
          break;
        }
        case 'message_delta':
          if (message && event.delta) {
            if (event.delta.stop_reason != null) message.stop_reason = event.delta.stop_reason;
            if (event.delta.stop_sequence !== undefined) message.stop_sequence = event.delta.stop_sequence;
            if (event.delta.stop_details !== undefined) message.stop_details = event.delta.stop_details;
          }
          if (message && event.usage) {
            message.usage = { ...(message.usage ?? {}), ...event.usage };
          }
          break;
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') break;
        try { processEvent(JSON.parse(data)); } catch { /* ignore malformed events */ }
      }
    }

    if (!message) throw new ClaudeError('api_error', 0, 'No message_start received in SSE stream');
    return message;
  }

  // POST to /api/claude with stream:false. Returns the parsed response directly.
  async function sendSync(requestBody) {
    const res = await fetch(`${base}/api/claude`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...requestBody, stream: false }),
    });
    const data = await res.json().catch(() => ({ kind: 'api_error', status: res.status, message: res.statusText }));
    if (!res.ok) throw mapError(data);
    return data;
  }

  return { send, sendSync };
}
