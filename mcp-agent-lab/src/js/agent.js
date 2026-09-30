// The agent loop. Transports are injected so the loop is testable with
// fixtures and no network. SPEC §6
//
// buildRequest, buildToolResultMessage and CAPS are pure and asserted directly
// by the suite; runLoop is driven through injected transports against the
// recorded fixtures in tests/fixtures.mjs.

// ---------------------------------------------------------------- caps

export const CAPS = {
  maxIterations: 12,
  maxToolCalls: 40,
  tokenBudget: 200000,
  wallClockMs: 120000,
  callTimeoutMs: 5000,
};

// ---------------------------------------------------------------- pure helpers

// Build a single API request body. model is set server-side, never here.
// tool_choice is always 'auto' (forced tool use is removed on this model).
// SPEC §6.1
export function buildRequest(messages, tools, options) {
  const opts = options ?? {};
  const req = {
    messages,
    tools,
    tool_choice: { type: opts.toolChoiceType === 'none' ? 'none' : 'auto' },
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: opts.effort ?? 'medium' },
    max_tokens: opts.streaming !== false ? 64000 : 16000,
    stream: opts.streaming !== false,
  };
  if (opts.system) req.system = opts.system;
  return req;
}

// Return ALL tool_result blocks in exactly ONE user message. §6.4
// There is no code path that returns more than one message object.
export function buildToolResultMessage(results) {
  return {
    role: 'user',
    content: results.map((r) => ({
      type: 'tool_result',
      tool_use_id: r.tool_use_id,
      content: r.content,
      is_error: r.is_error ?? false,
    })),
  };
}

// ---------------------------------------------------------------- the loop

// transports: { send(request) => Promise<response>, callTool(name, input) => Promise<{content, isError}> }
// onEvent: (event) => void — called for every timeline event as { type, turn, data }
// options: { prompt, system, tools, effort, toolChoiceType, caps }
export async function runLoop(transports, onEvent, options) {
  const caps = { ...CAPS, ...(options?.caps ?? {}) };
  const startTime = Date.now();
  const runId = `run_${startTime}`;
  const tools = options?.tools ?? [];
  let turn = 0;

  const emit = (type, data) => {
    onEvent({ type, turn, data: data ?? {}, runId, t: Date.now() - startTime });
  };

  emit('run_start', {
    mode: 'live',
    prompt: options?.prompt ?? '',
    effort: options?.effort ?? 'medium',
    caps,
    toolNames: tools.map((t) => t.name),
  });

  const messages = [{
    role: 'user',
    content: [{ type: 'text', text: options?.prompt ?? '' }],
  }];

  let iterations = 0;
  let totalToolCalls = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Wall-clock cap: fires as a flag so the loop can emit a proper event.
  let wallCapFired = false;
  const wallTimer = setTimeout(() => { wallCapFired = true; }, caps.wallClockMs);

  try {
    while (true) {
      // -- cap checks before sending --

      if (wallCapFired) {
        emit('cap', { cap: 'wallClockMs', value: caps.wallClockMs, iterations, toolCalls: totalToolCalls, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, message: `Loop stopped after ${caps.wallClockMs}ms wall-clock cap.` });
        emit('run_end', { completed: false, reason: 'cap:wallClockMs', iterations, toolCalls: totalToolCalls, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, wallMs: Date.now() - startTime });
        return;
      }

      if (iterations >= caps.maxIterations) {
        emit('cap', { cap: 'maxIterations', value: caps.maxIterations, iterations, toolCalls: totalToolCalls, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, message: `Loop stopped at ${caps.maxIterations}-turn cap. Answer below is incomplete.` });
        emit('run_end', { completed: false, reason: 'cap:maxIterations', iterations, toolCalls: totalToolCalls, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, wallMs: Date.now() - startTime });
        return;
      }

      if (totalInputTokens + totalOutputTokens >= caps.tokenBudget) {
        emit('cap', { cap: 'tokenBudget', value: caps.tokenBudget, iterations, toolCalls: totalToolCalls, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, message: `Loop stopped at ${caps.tokenBudget}-token budget cap.` });
        emit('run_end', { completed: false, reason: 'cap:tokenBudget', iterations, toolCalls: totalToolCalls, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, wallMs: Date.now() - startTime });
        return;
      }

      // -- send request --
      const request = buildRequest(messages, tools, {
        system: options?.system,
        effort: options?.effort ?? 'medium',
        toolChoiceType: options?.toolChoiceType,
      });

      emit('request', { messageCount: messages.length, toolListHash: tools.map((t) => t.name).sort().join(',') });

      let response;
      try {
        response = await transports.send(request);
      } catch (err) {
        emit('error', { kind: 'transport', status: 0, message: err.message });
        emit('run_end', { completed: false, reason: 'error', iterations, toolCalls: totalToolCalls, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, wallMs: Date.now() - startTime });
        return;
      }

      iterations++;
      turn = iterations;

      // -- track usage --
      if (response.usage) {
        const u = response.usage;
        totalInputTokens += u.input_tokens ?? 0;
        totalOutputTokens += u.output_tokens ?? 0;
        emit('usage', { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0, cache_read_input_tokens: u.cache_read_input_tokens ?? 0, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0, totalInputTokens, totalOutputTokens });
      }

      // -- emit content blocks --
      const toolUses = [];
      for (const block of response.content ?? []) {
        if (block.type === 'thinking') {
          emit('thinking', { text: block.thinking ?? '' });
        } else if (block.type === 'text') {
          emit('text', { text: block.text ?? '', final: response.stop_reason !== 'tool_use' });
        } else if (block.type === 'tool_use') {
          toolUses.push(block);
          emit('tool_use', { id: block.id, name: block.name, input: block.input, raw: block });
        }
      }

      // -- stop event --
      const stopReason = response.stop_reason;
      emit('stop', { stop_reason: stopReason, stop_details: stopReason === 'refusal' ? (response.stop_details ?? null) : null });

      // -- handle non-tool_use stop reasons --
      if (stopReason === 'max_tokens') {
        emit('cap', { cap: 'max_tokens', value: request.max_tokens, iterations, toolCalls: totalToolCalls, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, message: 'Response truncated at max_tokens; tool arguments may be incomplete.' });
        emit('run_end', { completed: false, reason: 'cap:max_tokens', iterations, toolCalls: totalToolCalls, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, wallMs: Date.now() - startTime });
        return;
      }

      if (stopReason !== 'tool_use') {
        emit('run_end', { completed: true, reason: stopReason, iterations, toolCalls: totalToolCalls, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, wallMs: Date.now() - startTime });
        return;
      }

      // -- check tool-call cap before executing --
      if (totalToolCalls + toolUses.length > caps.maxToolCalls) {
        emit('cap', { cap: 'maxToolCalls', value: caps.maxToolCalls, iterations, toolCalls: totalToolCalls, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, message: `Loop stopped at ${caps.maxToolCalls} total tool-call cap.` });
        emit('run_end', { completed: false, reason: 'cap:maxToolCalls', iterations, toolCalls: totalToolCalls, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, wallMs: Date.now() - startTime });
        return;
      }

      // -- execute all tool calls in parallel; all results in ONE user message (SPEC §6.4) --
      const results = await Promise.all(toolUses.map(async (toolUse) => {
        const callStart = Date.now();
        let result;
        try {
          result = await Promise.race([
            transports.callTool(toolUse.name, toolUse.input),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${caps.callTimeoutMs}ms`)), caps.callTimeoutMs)),
          ]);
        } catch (err) {
          result = { content: [{ type: 'text', text: err.message }], isError: true };
        }
        const durationMs = Date.now() - callStart;
        emit('tool_result', { tool_use_id: toolUse.id, content: result.content, is_error: result.isError ?? false, durationMs });
        return { tool_use_id: toolUse.id, content: result.content, is_error: result.isError ?? false };
      }));

      totalToolCalls += toolUses.length;

      // Append full assistant content (including thinking blocks) and ONE user message.
      messages.push({ role: 'assistant', content: response.content });
      messages.push(buildToolResultMessage(results));
    }
  } finally {
    clearTimeout(wallTimer);
  }
}
