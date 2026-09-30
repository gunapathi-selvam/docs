// Recorded transcripts for replay mode and pipeline tests. Hand-written to the
// shapes documented in SPEC §8.3. Five scenarios: single-tool, parallel-tools,
// tool-error, refusal, iteration-cap. SPEC §8.3, §13

// ---------------------------------------------------------------- single-tool
// One tool_use, one tool_result, end_turn. The happy path.

export const SINGLE_TOOL = {
  responses: [
    {
      type: 'message',
      id: 'msg_fixture_01',
      role: 'assistant',
      model: 'claude-opus-5-5',
      stop_reason: 'tool_use',
      stop_sequence: null,
      stop_details: null,
      content: [
        {
          type: 'thinking',
          thinking: 'The user wants to know the current time. I should call current_time.',
        },
        {
          type: 'tool_use',
          id: 'tu_single_01',
          name: 'current_time',
          input: {},
        },
      ],
      usage: {
        input_tokens: 120,
        output_tokens: 40,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 120,
      },
    },
    {
      type: 'message',
      id: 'msg_fixture_02',
      role: 'assistant',
      model: 'claude-opus-5-5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      stop_details: null,
      content: [
        {
          type: 'text',
          text: 'The current time is 2026-09-30T12:00:00Z (Wednesday, 30 September 2026, 12:00 UTC).',
        },
      ],
      usage: {
        input_tokens: 200,
        output_tokens: 35,
        cache_read_input_tokens: 120,
        cache_creation_input_tokens: 0,
      },
    },
  ],
  toolResults: [
    {
      content: [{ type: 'text', text: '2026-09-30T12:00:00Z (Wednesday, 30 September 2026, 12:00 UTC)' }],
      isError: false,
    },
  ],
};

// ---------------------------------------------------------------- parallel-tools
// Two tool_use blocks in one assistant message. The §6.4 assertion.
// pipeline.test.mjs asserts that exactly ONE user message is appended with
// exactly TWO tool_result blocks. This test FAILS if results are split.

export const PARALLEL_TOOLS = {
  responses: [
    {
      type: 'message',
      id: 'msg_fixture_03',
      role: 'assistant',
      model: 'claude-opus-5-5',
      stop_reason: 'tool_use',
      stop_sequence: null,
      stop_details: null,
      content: [
        {
          type: 'thinking',
          thinking: 'I can call current_time and list_directory in parallel.',
        },
        {
          type: 'tool_use',
          id: 'tu_parallel_01',
          name: 'current_time',
          input: {},
        },
        {
          type: 'tool_use',
          id: 'tu_parallel_02',
          name: 'list_directory',
          input: { path: '.' },
        },
      ],
      usage: {
        input_tokens: 130,
        output_tokens: 60,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 130,
      },
    },
    {
      type: 'message',
      id: 'msg_fixture_04',
      role: 'assistant',
      model: 'claude-opus-5-5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      stop_details: null,
      content: [
        {
          type: 'text',
          text: 'The time is 12:00 UTC and the root directory contains the project files.',
        },
      ],
      usage: {
        input_tokens: 350,
        output_tokens: 25,
        cache_read_input_tokens: 130,
        cache_creation_input_tokens: 0,
      },
    },
  ],
  toolResults: [
    {
      content: [{ type: 'text', text: '2026-09-30T12:00:00Z' }],
      isError: false,
    },
    {
      content: [{ type: 'text', text: 'mcp dir\nsrc dir\ntests dir\nspec dir' }],
      isError: false,
    },
  ],
};

// ---------------------------------------------------------------- tool-error
// A sandbox refusal returned as is_error: true. Model recovers and answers.

export const TOOL_ERROR = {
  responses: [
    {
      type: 'message',
      id: 'msg_fixture_05',
      role: 'assistant',
      model: 'claude-opus-5-5',
      stop_reason: 'tool_use',
      stop_sequence: null,
      stop_details: null,
      content: [
        {
          type: 'tool_use',
          id: 'tu_error_01',
          name: 'read_text_file',
          input: { path: '../../etc/passwd' },
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 100,
      },
    },
    {
      type: 'message',
      id: 'msg_fixture_06',
      role: 'assistant',
      model: 'claude-opus-5-5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      stop_details: null,
      content: [
        {
          type: 'text',
          text: 'I cannot read that file — it is outside the sandboxed directory.',
        },
      ],
      usage: {
        input_tokens: 180,
        output_tokens: 20,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 0,
      },
    },
  ],
  toolResults: [
    {
      content: [{ type: 'text', text: 'Path traversal (..) not allowed' }],
      isError: true,
    },
  ],
};

// ---------------------------------------------------------------- refusal
// stop_reason: 'refusal' with a populated stop_details.category.

export const REFUSAL = {
  responses: [
    {
      type: 'message',
      id: 'msg_fixture_07',
      role: 'assistant',
      model: 'claude-opus-5-5',
      stop_reason: 'refusal',
      stop_sequence: null,
      stop_details: { type: 'refusal', category: 'harmful' },
      content: [],
      usage: {
        input_tokens: 80,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 80,
      },
    },
  ],
  toolResults: [],
};

// ---------------------------------------------------------------- iteration-cap
// Model calls the same tool repeatedly. Use with { caps: { maxIterations: 3 } }
// to trip the cap on turn 3. Four tool_use responses provided; only three
// should be consumed before the cap fires.

const LOOP_RESPONSE = (id) => ({
  type: 'message',
  id: `msg_fixture_cap_${id}`,
  role: 'assistant',
  model: 'claude-opus-5-5',
  stop_reason: 'tool_use',
  stop_sequence: null,
  stop_details: null,
  content: [
    {
      type: 'tool_use',
      id: `tu_cap_${id}`,
      name: 'current_time',
      input: {},
    },
  ],
  usage: {
    input_tokens: 100 + id * 50,
    output_tokens: 15,
    cache_read_input_tokens: id > 0 ? 100 : 0,
    cache_creation_input_tokens: id > 0 ? 0 : 100,
  },
});

export const ITERATION_CAP = {
  responses: [
    LOOP_RESPONSE(0),
    LOOP_RESPONSE(1),
    LOOP_RESPONSE(2),
    LOOP_RESPONSE(3),
  ],
  toolResults: [
    { content: [{ type: 'text', text: '2026-09-30T12:00:00Z' }], isError: false },
    { content: [{ type: 'text', text: '2026-09-30T12:00:01Z' }], isError: false },
    { content: [{ type: 'text', text: '2026-09-30T12:00:02Z' }], isError: false },
    { content: [{ type: 'text', text: '2026-09-30T12:00:03Z' }], isError: false },
  ],
};
