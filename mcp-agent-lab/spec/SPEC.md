# MCP Agent Lab — Technical Specification

**Version** 1.0 · **Date** 2026-09-30 · **Status** Draft (unimplemented)

Third in the series after [galaxy-spiral](../../galaxy-spiral/spec/SPEC.md) and
[webgpu-particles](../../webgpu-particles/spec/SPEC.md). Galaxy Spiral made a
real-time pipeline observable by drawing a landmark skeleton over the camera
feed, so a user could diagnose the system by looking at it. This project applies
the same instinct to an agent loop, which is otherwise entirely opaque: a
request goes out, some time passes, an answer comes back, and nothing in between
is visible. **The visualiser is the lesson.**

---

## 1. Purpose and scope

### 1.1 What this project is

Two halves that meet at a Node process.

1. **A real MCP server** (`mcp/server.mjs`) speaking Model Context Protocol
   over stdio, exposing four genuinely useful local tools: read a file under a
   sandboxed root, list a directory, search file contents, and get the current
   time. Written by hand against the protocol — **no MCP SDK** — so the wire
   format is visible and learnable. Reading `mcp/server.mjs` should teach you
   what a `tools/call` looks like on the wire.
2. **A browser UI** that drives an agent loop against Claude with those tools
   bridged in, and renders every step as an inspectable timeline: the request,
   the thinking summary, each `tool_use` block with its arguments, each
   `tool_result`, and the final text. Every node expands to the raw JSON that
   crossed the wire.

### 1.2 What it deliberately is not

- **Not a chat app.** There is one prompt box and one run. Conversation history
  across runs, threads, and persistence are out of scope. The subject is a
  single loop rendered completely, not a product.
- **Not an MCP SDK consumer.** The point is the wire format. Importing an SDK
  would hide exactly the thing being taught. The cost is that this server
  implements a subset of the protocol, and that subset is spelled out in §3.
- **Not a general MCP client.** It bridges one server, spawned by `server.js`,
  with a configured root. Connecting to arbitrary third-party MCP servers is a
  backlog item with its own trust problems.
- **Not a key-holding browser app.** See §2.2. The browser never sees
  `ANTHROPIC_API_KEY` and never calls `api.anthropic.com`.

### 1.3 Learning goals

| Goal | Where it appears |
|---|---|
| JSON-RPC over stdio, by hand | §3.1–§3.4 |
| MCP tool schema vs. Claude tool definition | §5 |
| The agent loop and its termination conditions | §6 |
| Why all `tool_result` blocks go in one message | §6.4 |
| Prompt caching in a loop, and what invalidates it | §6.6 |
| Sandboxing a filesystem tool, including symlinks | §4.2 |
| Not building an open relay to a paid API | §4.1 |
| Append-only event models, and why replay is free | §7, §8 |

---

## 2. Architecture

### 2.1 Processes

```
  browser (no secrets)                Node: server.js                 network
  ────────────────────                ───────────────                 ───────
  index.html                          static files
  src/js/main.js ───── GET ──────────▶  resolveSafe()  (§4.2 prefix guard)
       │
       ├── src/js/claude.js
       │      POST /api/claude ──────▶  allowlist (§4.1)
       │      ◀──── SSE ─────────────   new Anthropic()  ──── HTTPS ───▶ Claude API
       │                                reads ANTHROPIC_API_KEY
       │                                from process.env only
       │
       └── src/js/mcpClient.js
              POST /api/mcp ─────────▶  stdio bridge
              ◀──── JSON-RPC ────────   │
                                        ▼
                                   mcp/server.mjs  (child process, spawned once)
                                        │  JSON-RPC 2.0, newline-delimited
                                        ▼
                                   mcp/tools.mjs   sandboxed to MCP_ROOT (§4.2)
```

| Module | Responsibility |
|---|---|
| `server.js` | Static files, `/api/claude`, `/api/mcp`, MCP subprocess lifecycle |
| `mcp/server.mjs` | JSON-RPC framing, `initialize`, `tools/list`, `tools/call` |
| `mcp/tools.mjs` | The four tool implementations and their schemas; path sandbox |
| `src/js/main.js` | Orchestrator: wiring, run start, replay toggle, readouts |
| `src/js/agent.js` | The loop. Pure with respect to I/O — transports injected |
| `src/js/claude.js` | Browser client for `/api/claude`, SSE assembly, error mapping |
| `src/js/mcpClient.js` | Browser client for `/api/mcp`, MCP→Claude schema mapping |
| `src/js/timeline.js` | Append-only event model plus DOM rendering |

### 2.2 Trust boundaries

There are exactly two, and they are the reason `server.js` is not a static
server.

**Boundary 1 — the API key.** `ANTHROPIC_API_KEY` is read from
`process.env` inside `server.js` and never leaves it. The browser has no code
path to `api.anthropic.com`. A key in browser JavaScript is readable by anyone
who opens the network tab, survives in bundles and in caches, and cannot be
scoped or revoked per page. There is no correct way to put it there.

The Node side uses the official SDK: `new Anthropic()` with **no arguments**.
The constructor picks up `ANTHROPIC_API_KEY` itself. Passing the key explicitly
adds a place for it to be logged, and shadows the SDK's own credential
resolution order.

**Boundary 2 — stdio.** A browser cannot speak stdio to a subprocess. The MCP
server is a child process owned by `server.js`; `/api/mcp` is a request-response
bridge onto its stdin/stdout. The subprocess is spawned **once** at first use,
not per request — spawning a Node process per tool call costs ~40 ms of startup
and throws away the `initialize` handshake every time.

---

## 3. The MCP server

### 3.1 Transport and framing

**stdio, newline-delimited JSON.** One JSON-RPC 2.0 message per line,
terminated by `\n`. No `Content-Length` header.

This is worth stating explicitly because the neighbouring protocol — Language
Server Protocol — uses `Content-Length`-prefixed framing, and the two are
routinely confused. MCP's stdio transport does not. A message is a line.

Two consequences:

- **A message may not contain a raw newline.** `JSON.stringify` never emits an
  unescaped `\n` inside a string, so producing valid frames is automatic. The
  risk is on the *reading* side: a naive `split('\n')` on a stream chunk will
  split a message that arrived in two TCP reads. `decodeFrames(buffer)` must
  return the trailing partial line as a remainder and carry it into the next
  chunk. `unit.test.mjs` asserts this by feeding a message one byte at a time.
- **stdout is the protocol channel and nothing else.** A stray
  `console.log` in the server writes a non-JSON line into the stream and breaks
  the client's parser. All server diagnostics go to **stderr**, which
  `server.js` forwards to its own stderr prefixed with `[mcp]`. This is the
  single most common way a hand-written MCP server fails, and the failure looks
  like a parse error rather than like a stray log line.

### 3.2 `initialize`

Request:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": { "name": "mcp-agent-lab", "version": "1.0.0" }
  }
}
```

Response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-06-18",
    "capabilities": { "tools": { "listChanged": false } },
    "serverInfo": { "name": "mcp-agent-lab-fs", "version": "1.0.0" }
  }
}
```

Followed by a **notification** from the client — no `id`, and therefore no
reply:

```json
{ "jsonrpc": "2.0", "method": "notifications/initialized" }
```

The server must not answer a notification. A reply carrying `"id": null` to an
id-less request is a protocol violation and some clients treat it as a response
to an unrelated call. `handleMessage` returns `null` for any message without an
`id`, and `unit.test.mjs` asserts that.

The server refuses `tools/list` and `tools/call` before `initialize` has
completed, with error `-32002` (`Server not initialized`). This is a real state
machine, not decoration: a client that skips the handshake has not agreed a
protocol version, and answering it silently papers over a version mismatch that
will bite on the first shape change.

### 3.3 `tools/list`

Request: `{ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }`

Response:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      {
        "name": "current_time",
        "description": "Get the current date and time...",
        "inputSchema": {
          "type": "object",
          "properties": { "timezone": { "type": "string", "description": "IANA zone, e.g. Europe/London. Defaults to UTC." } },
          "required": [],
          "additionalProperties": false
        }
      }
    ]
  }
}
```

**The array is sorted by `name`, ascending, byte order.** Not cosmetic — see
§6.6. Insertion order is whatever the module happened to declare, and if that
order ever varies the Claude `tools` block changes bytes and every prompt cache
read becomes a miss. Deterministic order is a caching requirement, and the
cheapest possible way to guarantee it is to sort.

`listChanged: false` in the capabilities means the client may cache the list for
the lifetime of the connection. This server's tool set is static.

### 3.4 `tools/call`

Request:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "read_text_file",
    "arguments": { "path": "spec/SPEC.md", "max_bytes": 4096 }
  }
}
```

Success:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": {
    "content": [{ "type": "text", "text": "# MCP Agent Lab ..." }],
    "isError": false
  }
}
```

Tool-level failure — note this is a **`result`, not a JSON-RPC `error`**:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": {
    "content": [{ "type": "text", "text": "EISDIR: spec is a directory" }],
    "isError": true
  }
}
```

The distinction is load-bearing and is the second most common mistake in a
hand-written MCP server:

| Situation | Shape |
|---|---|
| Unknown method | JSON-RPC `error`, code `-32601` |
| Malformed params (wrong type, missing required) | JSON-RPC `error`, code `-32602` |
| Not initialised | JSON-RPC `error`, code `-32002` |
| Unparseable line | JSON-RPC `error`, code `-32700`, `id: null` |
| **The tool ran and failed** | `result` with `isError: true` |
| **Sandbox refusal** | `result` with `isError: true` |

A JSON-RPC `error` says *the request was wrong*. `isError: true` says *the
request was fine and the world said no*. A sandbox refusal is the latter: the
model asked a legitimate question and the answer is "not allowed". Reporting it
as `-32602` tells the model its request was malformed, and the model then
"fixes" the arguments and tries again — which is precisely the retry loop a
traversal guard should not encourage. §6.4 carries the same distinction into the
Claude conversation as `is_error: true`.

### 3.5 The four tools

All paths are **relative to `MCP_ROOT`** and validated by §4.2.

| Tool | Arguments | Returns | Notes |
|---|---|---|---|
| `read_text_file` | `path` (string, required), `max_bytes` (integer, 1…262144, default 65536) | File text, truncated at `max_bytes` with an explicit `[truncated]` marker | Refuses non-UTF8 with `isError`. A silent truncation would teach the model the file ended |
| `list_directory` | `path` (string, default `"."`), `include_hidden` (boolean, default `false`) | One line per entry: `name`, `dir`/`file`/`symlink`, size | Reports symlinks as `symlink` and does **not** follow them for the listing |
| `search_files` | `query` (string, required), `path` (string, default `"."`), `max_results` (integer, 1…200, default 40) | `relative/path:line: matching text` | Substring, case-insensitive, literal — not a regex. See below |
| `current_time` | `timezone` (string, optional IANA zone) | ISO 8601 plus a human form | Exists to give the loop one tool with no filesystem surface, so a parallel-call fixture can pair a cheap tool with an expensive one |

`search_files` takes a **literal substring, not a regex**, and that is a
deliberate narrowing. A model-supplied regex is an unbounded input to a
backtracking engine; `(a+)+$` against a long line is a denial of service with no
syntax error to catch. Literal substring search has no pathological input. If
regex search is ever added it needs a linear-time engine or a timeout, and that
is a backlog item, not a default.

`search_files` skips any file over 1 MiB and any directory named in
`SKIP_DIRS` (`node_modules`, `.git`, `dist`, `.cache`), and stops at
`max_results`. Without the stop, "search for `e`" reads the whole tree into one
`tool_result` and the next request blows the context window.

### 3.6 Standalone operation

`npm run mcp` runs `mcp/server.mjs` alone on stdio, which makes it usable from
any MCP client and — more usefully during development — pipeable:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | npm run --silent mcp
```

If that prints two JSON lines, the server is correct independently of the
browser, the proxy, and the API key. It is the first thing to try when the
timeline shows no tools.

---

## 4. Security

Two independent surfaces. Both are real; neither is a checkbox.

### 4.1 The `/api/claude` allowlist

`/api/claude` puts a paid API behind an unauthenticated local endpoint. If it
relays an arbitrary client body, it is an **open relay**: anything that can
reach `localhost:5173` — another browser tab, a malicious page via a
cross-origin form post, a script on the machine — can spend the key's budget on
arbitrary prompts, and the operator sees only a bill.

The proxy therefore **allowlists fields** rather than forwarding the body.

| Field | Handling |
|---|---|
| `messages` | Forwarded. Must be a non-empty array. Last entry must **not** have `role: "assistant"` — prefill is removed on this model and returns 400; rejecting locally gives a better message than the API's |
| `system` | Forwarded if a string or an array of text blocks |
| `tools` | Forwarded. Every entry must have a `name` that appears in the server's own `tools/list`. **A client cannot invent a tool** |
| `tool_choice` | Forwarded only if `{ type: "auto" }` or `{ type: "none" }`. `any` and `tool` are rejected with 400 and an explanation — see §6.1 |
| `max_tokens` | Clamped to `[1, 64000]` streaming, `[1, 16000]` non-streaming |
| `output_config.effort` | Forwarded if one of `low`/`medium`/`high`/`xhigh`/`max` |
| `thinking` | Forwarded only as `{ type: "adaptive", display: "summarized" }` or omitted |
| `stream` | Forwarded as a boolean; defaults true |
| **`model`** | **Never taken from the client.** Set server-side from `MODEL` (§12) |
| Anything else | **400**, naming the offending key |

Two decisions inside that table deserve their own justification.

**Unknown keys are a 400, not a silent drop.** Silently dropping means a
feature you added to the client quietly does nothing, and you debug the model
instead of the proxy. A named 400 is a two-second fix.

**`model` is not a client field.** Otherwise the endpoint is a cost oracle: a
caller picks the most expensive model available to the key. It is also the field
most likely to be pinned by an operator, so having it arrive from the browser is
backwards.

Additional hardening, all of it cheap:

- **Bind to `127.0.0.1` by default**, not `0.0.0.0`. An open relay on a café
  network is worse than one on a loopback interface.
- **Reject `Origin` headers other than the configured host** on both `/api`
  routes. A cross-origin `fetch` cannot read the response without CORS, but it
  can still *send* the request, and the spend happens on send.
- **Cap the request body at 1 MiB** and abort the stream past it, rather than
  buffering whatever arrives.
- **Never echo the key**, and never include `process.env` in an error body. The
  503 of §8 says the variable is unset; it does not say what else is in the
  environment.

### 4.2 MCP path sandboxing

The file tools must not escape `MCP_ROOT`. Three distinct attacks, and a prefix
check stops only two of them.

**Stage 1 — normalise and reject, before touching the filesystem.**
`normaliseRequestPath(raw)` is pure and rejects:

| Input | Reason |
|---|---|
| `""` | No target |
| Anything containing `\0` | A NUL byte truncates the path at the syscall boundary while passing a JavaScript string check |
| `/etc/passwd`, `C:\Windows`, `\\server\share` | Absolute and UNC paths. Joining an absolute path onto a root **discards the root** — `path.join('/srv/root', '/etc/passwd')` is `/srv/root/etc/passwd` but `path.resolve` gives `/etc/passwd`, and mixing the two is how this gets missed |
| `../../etc/passwd` | Traversal, caught by stage 2 as well, rejected here for a clearer message |

**Stage 2 — resolve and prefix-check.** `isInsideRoot(root, candidate)` is pure
and is the `resolveSafe` pattern from `webgpu-particles/server.js`, with one
correction:

```
candidate === root  ||  candidate.startsWith(root.endsWith(sep) ? root : root + sep)
```

The separator is not optional. Against a bare `root` prefix, a sibling
directory named `/srv/sandbox-evil` passes a `/srv/sandbox` prefix test. This
is a real class of bug and it is one character to prevent.

**Stage 3 — `realpath`, and check again.** This is the part a prefix check
cannot do, and the reason this section exists.

A prefix check operates on a *string*. A symlink is a property of the
*filesystem*. Given:

```
MCP_ROOT/notes -> /etc
```

the request `notes/passwd` normalises cleanly, resolves to
`MCP_ROOT/notes/passwd`, and passes the prefix check with room to spare. The
`open` syscall then follows the link and reads `/etc/passwd`. Every string-level
guard in stages 1 and 2 says yes.

So `resolveSafe` must resolve links on the real filesystem and re-check:

1. `realRoot = await realpath(MCP_ROOT)`, computed **once at startup** and
   cached. If the root is itself reached through a symlink — very common on
   macOS, where `/tmp` is a link to `/private/tmp` — an unresolved root makes
   every legitimate path fail its own prefix test.
2. `resolved = resolve(realRoot, normalised)`, then `isInsideRoot` (stage 2).
   This cheap check runs first so an obvious traversal never touches the disk.
3. `real = await realpath(resolved)`, then `isInsideRoot(realRoot, real)`
   **again**. This is the check that catches the symlink.
4. If `resolved` does not exist, `realpath` throws `ENOENT`. Walk up to the
   deepest existing ancestor, `realpath` that, and re-check. A non-existent
   path under a symlinked parent is still an escape; returning "not found"
   without checking leaks whether a path exists outside the root.

`list_directory` reports a symlink as `symlink` and does not follow it. A
listing that resolved links would report the *contents* of the target, which is
information disclosure even when reading through the link is blocked.

**Not defended, and named so nobody assumes otherwise:**

- **TOCTOU.** Between the `realpath` check and the `open`, another process can
  replace a component with a symlink. Closing this needs `openat` with
  `O_NOFOLLOW` per component, which Node does not expose. The exposure is a
  local attacker with write access inside the root, who by then can simply write
  the file they want read.
- **Hard links.** A hard link inside the root to a file outside it has no link
  to resolve; `realpath` reports the in-root path and the check passes. Blocking
  this needs device-and-inode comparison against the root's subtree. Out of
  scope, documented, and the reason `MCP_ROOT` should point at a directory you
  would be comfortable publishing.
- **Case-insensitive and Unicode-normalising filesystems.** On macOS and
  Windows, `Root/x` and `root/x` are the same file with different bytes. All
  comparisons here are on `realpath` output, which is what the OS reports, so
  the two agree — but a future guard that compares the *requested* string
  against a root must not assume byte equality means path equality.
- **Reading is the whole surface.** No tool writes, deletes, or executes. That
  is not a mitigation, it is the scope: adding a write tool re-opens every
  question above with worse consequences.

### 4.3 What the visualiser must not show

The timeline renders raw JSON, and raw JSON is exactly where a secret leaks.
The rule: **the browser never receives a field it must not display**, so the
redaction is on the server, not in the renderer. `/api/claude` strips request
headers from the echoed body before streaming it back. A renderer-side
blocklist would be one forgotten field away from painting a key into the DOM.

---

## 5. MCP tool schema → Claude tool definition

These are different formats and the mapping is not quite mechanical.

### 5.1 The mapping

| MCP tool field | Claude tool field | Transform |
|---|---|---|
| `name` | `name` | Verbatim. Must match `^[a-zA-Z0-9_-]{1,64}$`; a tool that does not is dropped with a reason |
| `description` | `description` | Verbatim. Empty descriptions are passed through — the model's tool selection degrades, but silently rewriting a server's description is worse |
| `inputSchema` | `input_schema` | Rename only, plus the strictness work below |
| — | `strict` | **Top-level on the tool definition**, computed by §5.2 |

`strict` is a sibling of `name`, `description` and `input_schema`. It is **not**
part of `tool_choice`. Putting it on `tool_choice` is a 400 and reads like a
plausible API, which is why it is called out here and in CLAUDE.md.

### 5.2 Can this schema be strict?

`strict: true` guarantees that `tool_use.input` validates exactly against the
schema — which removes an entire class of argument-parsing defect from the
loop. It requires the schema to be expressible in the strict subset:

`canBeStrict(schema)` returns `{ ok: false, reason }` for any of:

| Construct | Why it blocks strictness |
|---|---|
| `type` missing or not `"object"` | The strict subset is rooted at an object |
| `properties` missing or empty | Nothing to validate |
| `additionalProperties` not `false` | Strict mode requires the object be closed |
| `required` missing | Strict mode requires it present, even as `[]` |
| `oneOf`, `anyOf`, `allOf`, `not` | Unsupported combinators |
| `$ref`, `$defs`, `definitions` | No reference resolution |
| `patternProperties`, `propertyNames` | Dynamic key sets are not a closed object |
| Any of the above nested in a property | Applied recursively |

Two of these are **repairable and are repaired**, because they are omissions
rather than incompatibilities:

- `additionalProperties` absent → set to `false`
- `required` absent → set to `[]`

Both are narrowings of an underspecified schema, both are what the tool author
almost certainly meant, and both are recorded on the mapped tool as
`repairs: ['additionalProperties', 'required']` so the tool inventory panel can
show that the lab tightened the server's schema. Silently tightening without
saying so would make a tool reject arguments its own documentation permits.

`additionalProperties: true` is **not** repaired — flipping it to `false` would
contradict the author's explicit statement.

### 5.3 What happens to a tool that cannot be strict

It is mapped **without `strict`** and marked `degraded: true` with the reason
string. It still works: the model can call it, the arguments simply are not
guaranteed to validate, so the handler must validate them itself.

Three alternatives were considered and rejected:

- **Drop the tool.** A tool vanishing because of a schema detail is invisible
  in the timeline and the model's behaviour changes with no explanation.
- **Set `strict: true` anyway.** 400 at request time for the whole request, not
  just that tool. One unrepresentable schema would take the run down.
- **Rewrite the schema to fit.** Guessing an author's intent — collapsing a
  `oneOf` to its first branch, say — produces a tool that accepts arguments the
  real handler rejects. Worse than not being strict, because the failure moves
  from request time to run time.

The tool inventory panel shows a `degraded` badge with the reason on hover. All
four of this project's own tools are strict-capable; the degraded path exists
for third-party servers and is exercised by a fixture, not by a live tool.

### 5.4 Ordering

`toClaudeTools` returns tools **sorted by `name`**, and rebuilds nothing between
turns. §6.6 explains why. The sort happens on the client even though §3.3
already sorts on the server, because the caching invariant must not depend on a
remote server's good behaviour.

---

## 6. The agent loop

### 6.1 Request shape

```js
{
  model: 'claude-opus-5-5',            // server-side, never from the client
  max_tokens: 64000,                   // streaming; 16000 non-streaming
  stream: true,
  system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
  tools: toolsSortedByName,            // byte-stable across turns
  tool_choice: { type: 'auto' },
  thinking: { type: 'adaptive', display: 'summarized' },
  output_config: { effort: 'medium' },
  messages,
}
```

Every one of those lines is a decision.

**`model: 'claude-opus-5-5'`** — exactly this string. No date suffix. A
date-suffixed variant is a 404 that reads like a permissions problem.

**`max_tokens`** — 16000 non-streaming, up to 64000 streaming. Streaming is the
default, because a loop with a long tool-result history plus a long answer is
exactly the shape that hits an HTTP timeout on a non-streaming request. The
timeline also wants incremental events, which is a second reason but not the
main one.

**`thinking: { type: 'adaptive', display: 'summarized' }`** — or omitted
entirely. On this model `{ type: 'disabled' }` returns **400**, and so does
`budget_tokens`. Both are the stale shapes.

`display: 'summarized'` is set **here specifically because the visualiser wants
to show reasoning.** The default is `omitted`, which still thinks and still
bills, but returns `thinking` blocks with empty text. In a timeline that renders
a node per block, the default produces a node with a title and no body — a
confusingly blank card that looks like a rendering bug and is actually the
correct rendering of an empty string. If you ever see empty thinking nodes,
check this field before you debug `timeline.js`.

**`tool_choice: { type: 'auto' }`** — and it has to be.

> **Forced tool use is REMOVED on this model.** `tool_choice: { type: 'any' }`
> and `{ type: 'tool', name: ... }` both return **HTTP 400**. This is the single
> most likely thing to get wrong from stale knowledge, because forcing a tool
> was the standard way to guarantee a call for years.

The replacement is three parts together:

1. `tool_choice: { type: 'auto' }`.
2. An **explicit system instruction naming the tool**: "To answer any question
   about file contents you must call `read_text_file`. Do not describe a file
   you have not read."
3. **`strict: true` on the tool definition** (§5.2), which is what makes the
   arguments schema-valid — the job `{ type: 'tool', name }` used to do for
   shape, if not for occurrence.

`{ type: 'none' }` still works, and the UI uses it for the deliberate
"answer without tools" comparison run.

**`output_config: { effort: 'medium' }`** — `effort` is nested inside
`output_config`, not top-level. Default is `medium` on this model; it is set
explicitly so the UI selector has somewhere to write, and so the default is
visible in the request node rather than implied.

### 6.2 Termination

```
loop:
  response = send(request)
  if response.stop_reason !== 'tool_use': break
  toolUses = response.content.filter(b => b.type === 'tool_use')
  results  = await Promise.all(toolUses.map(execute))
  messages.push({ role: 'assistant', content: response.content })
  messages.push({ role: 'user', content: results })   // ONE message — §6.4
```

**Continue while `response.stop_reason === 'tool_use'`.** Not "while there is a
`tool_use` block" — those agree today but `stop_reason` is the contract, and
§6.5 requires checking it first anyway.

The full assistant `content` array is appended, not just the text and not just
the `tool_use` blocks. Thinking blocks must be echoed back unchanged when the
conversation continues on the same model. Filtering the content array to "the
interesting bits" drops them.

### 6.3 Caps

An agent loop without a hard cap is a bill with no ceiling. A tool that returns
a result the model finds unsatisfying — a search that always returns "no
matches" for a subtly wrong argument — produces a loop that never terminates and
never errors. Four caps, any one of which stops the run:

| Cap | Value | Rationale |
|---|---|---|
| `maxIterations` | **12** assistant turns | A read-search-read-answer task needs 3–5. Twelve leaves room for a wrong turn and a recovery; beyond that the model is not converging |
| `maxToolCalls` | **40** total executions | Parallel calls mean iterations alone do not bound tool work: 12 turns × 8 parallel calls is 96 filesystem walks |
| `tokenBudget` | **200 000** cumulative `input_tokens + output_tokens` | ~$1.60 at this model's input rate in the worst case. The number to raise first if a legitimate task trips it |
| `wallClockMs` | **120 000** (2 min) | Catches a hung tool that neither errors nor returns. Independent of the others because a stuck loop consumes no tokens |

Plus a **per-tool-call timeout of 5 000 ms**. A timed-out call returns a
`tool_result` with `is_error: true` and the text `timeout after 5000ms` — it
does **not** abort the run. The model can then try a different argument, which
is the behaviour you want, and §6.4 stays satisfied.

**What the UI shows when a cap trips.** Not an exception and not a silent stop.
The timeline appends a `cap` event that renders as a **terminal banner node**,
styled distinctly from an `error`, carrying:

- which cap tripped, and its configured value
- the counters at the moment it tripped, all four of them
- the last `tool_use` that was in flight
- a plain sentence: *"The loop stopped because it hit its 12-turn cap, not
  because the model finished. The answer below is incomplete."*

That last line matters. A capped run still has partial text, and partial text
that looks like an answer is worse than no answer. The `run_end` event carries
`{ completed: false, reason: 'cap:maxIterations' }`, and the final-text node is
rendered with an "incomplete" marker when it is false.

### 6.4 All `tool_result` blocks in one message

> One assistant message may contain several `tool_use` blocks. Execute them,
> then return **all** the `tool_result` blocks in a **single** user message.

Splitting them across several user messages does not error. It does not warn.
The run completes and the answer is fine. What it does is **silently train the
model, within that conversation, to stop making parallel calls** — it has been
shown a history in which parallel requests came back one at a time, so it stops
issuing them. The loop gets slower over its own length with no signal anywhere
that anything changed.

A degradation with no error is the hardest kind to find, which is why
`buildToolResultMessage(results)` returns **one** message object and has no
code path that returns more than one, and why `pipeline.test.mjs` asserts on the
recorded request bodies that a parallel turn produced exactly one follow-up user
message containing exactly as many `tool_result` blocks as there were
`tool_use` blocks. That test fails if the blocks are split.

Three further rules, all absolute:

- **Never drop a `tool_result`.** A `tool_use` id with no matching result is a
  malformed conversation. A failed tool returns a `tool_result` with
  `is_error: true` and a message; it does not return nothing.
- **Order does not matter, presence does.** `tool_use_id` does the pairing.
  `timeline.js` pairs them the same way and renders an unmatched id as a visible
  defect rather than omitting it (§7.3).
- **Parse `tool_use.input` with `JSON.parse`, never raw string matching.** JSON
  string escaping varies on this model — Unicode escapes, escaped forward
  slashes — so `input.includes('"path":"spec/SPEC.md"')` matches sometimes.
  With `strict: true` the SDK hands over a parsed object; the rule is for any
  path that touches the serialised form, including the timeline renderer.

### 6.5 `stop_reason` and `stop_details`

**Always check `stop_reason` before reading content.**

| `stop_reason` | Handling |
|---|---|
| `end_turn` | Normal completion. Render final text |
| `tool_use` | Continue the loop (§6.2) |
| `max_tokens` | The response is truncated. If it contains a `tool_use`, the arguments may be truncated too — **do not execute it**. Append a `cap`-style event and stop |
| `refusal` | `stop_details` is populated with a `category`. Render the category; do not retry |
| `pause_turn` | Server-tool pause. Not reachable here — no server tools are declared — and asserted unreachable rather than assumed |

**`stop_details` is `null` for every `stop_reason` except `refusal`.** Reading
`response.stop_details.category` unguarded throws a `TypeError` on the happy
path — a crash in the success case, introduced by code that only handles
failure. Guard on `stop_reason === 'refusal'` first, not on
`stop_details != null`, so the intent is legible.

**Assistant message prefill is removed.** A trailing assistant turn returns
400. There is no "start the answer for it" trick available, and §4.1 rejects it
at the proxy so the error arrives with a useful message.

### 6.6 Errors

SDK typed classes, **most specific first**:

```js
catch (err) {
  if (err instanceof Anthropic.BadRequestError)      // 400 — shape is wrong
  else if (err instanceof Anthropic.AuthenticationError) // 401 — key
  else if (err instanceof Anthropic.RateLimitError)  // 429 — back off
  else if (err instanceof Anthropic.APIError)        // typed .status
  else                                               // not an API error
}
```

**Never string-match error messages.** Message text is not API surface; it
changes without notice and it is localised at some layers. The typed classes
exist precisely so that this code does not have to guess.

The proxy maps each class to its own JSON body — `{ kind, status, message }` —
and `claude.js` maps `kind` back to a browser-side error class, so the browser
keeps the distinction without the SDK. A 400 and a 429 need opposite responses
(fix the request vs. wait and retry) and collapsing them into "an error
occurred" makes both undebuggable.

### 6.7 Prompt caching in a loop

`cache_control: { type: 'ephemeral' }`, **prefix match**, render order
**`tools` → `system` → `messages`**.

Any byte change anywhere in the prefix invalidates everything after it. In an
agent loop the messages array grows every turn, which is fine — that is append
-only and the prefix is stable. The thing that breaks is the part that should
never change:

> **The tool list must be byte-stable across turns, or every turn is a cache
> miss.** `tools` renders *first*, so a reordered tool array invalidates the
> system prompt and the entire message history along with it. Turn 8 of a
> 12-turn loop re-reads the whole conversation at full price.

This is why §3.3 sorts on the server and §5.4 sorts again on the client, and why
`tools` is built **once per run** and reused by reference rather than rebuilt
per turn. `Object.keys` order, a `Map` iteration, a `filter` over a set — all of
them are stable enough in practice to pass a smoke test and unstable enough to
bite when a tool is added.

Breakpoints: one at the end of `tools`, one at the end of `system`. Both are
frozen for the run.

**Verify with `response.usage.cache_read_input_tokens`.** If it is zero on turn
2 and after, something in the prefix is moving. The timeline puts cache
read/write next to the tool-list hash in every `usage` node, so a miss is
visible as a changed hash rather than requiring a diff of two request bodies.
That hash is a debugging aid, not part of the request.

---

## 7. Timeline data model

### 7.1 One append-only event array

```js
{ seq, t, type, runId, turn, data }
```

`seq` is a monotonic integer, `t` is milliseconds since `run_start`, `turn` is
the assistant turn index. `data` is type-specific and carries the raw JSON for
the detail pane.

### 7.2 Event types

| # | Type | Emitted when | `data` carries |
|---|---|---|---|
| 1 | `run_start` | A run begins | `mode` (`live`/`replay`), prompt, model, effort, caps, tool names |
| 2 | `request` | Before each API call | Allowlisted request body, message count, tool-list hash |
| 3 | `thinking` | A `thinking` block completes | Summary text |
| 4 | `text` | A `text` block completes | Text, and whether it is the final turn |
| 5 | `tool_use` | A `tool_use` block completes | `id`, `name`, parsed `input`, raw block |
| 6 | `tool_result` | A tool returns | `tool_use_id`, content, `is_error`, `durationMs`, MCP envelope |
| 7 | `usage` | A turn's usage is known | `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, running cost |
| 8 | `stop` | A turn ends | `stop_reason`, `stop_details` (null except `refusal`) |
| 9 | `cap` | A cap trips | Which cap, its value, all four counters, in-flight `tool_use` |
| 10 | `error` | A transport or API error | `kind`, `status`, message — never the request headers |
| 11 | `run_end` | The run finishes | `completed`, `reason`, totals, wall clock |

Eleven types, and the list is closed: `EVENT_TYPES` is exported and
`timeline.js` throws on an unknown type rather than rendering a generic card.
An unknown event type means a producer and a renderer have diverged, and a
generic card hides that for as long as nobody looks closely.

### 7.3 Why append-only, and not a mutable tree

The obvious model is a tree — a run with turns, turns with blocks, blocks with
results — updated in place as the stream arrives. It was rejected for five
reasons, in order of how much they matter.

1. **Replay and live become the same code path.** A recorded transcript *is* an
   event array. Replay is `for (const ev of fixture.events) timeline.append(ev)`
   — no second renderer, no "replay mode" branch inside the renderer, no
   possibility of the two diverging. With a mutable tree, replay means
   reconstructing intermediate tree states from a log, which is a second
   implementation of the thing being tested. This alone decides it: §8 makes
   replay a first-class feature, and a first-class feature must not have a
   second-class code path.
2. **The ordering *is* the lesson.** The interleaving of thinking, tool calls
   and results is what the project exists to show. A tree stores the final
   shape and throws away the order it arrived in. Two runs that produce the same
   tree can differ in whether two calls were parallel or sequential — the exact
   distinction §6.4 is about.
3. **Tests assert on a list.** `events.filter(e => e.type === 'tool_use')` and
   an index comparison is a one-line assertion. The equivalent against a tree
   is a traversal plus assumptions about where a node lives, which breaks when
   the shape changes for unrelated reasons.
4. **A scrubber is free.** Rendering the run as of `seq <= n` is a slice. Time
   travel needs no undo log because nothing was ever mutated.
5. **Streaming arrives out of order relative to the tree.** A `tool_result`
   can arrive before its `tool_use` node has finished rendering. An append-only
   log does not care; a tree needs the parent to exist before the child, which
   means buffering, which means a second ordering model.

The cost is that rendering needs a grouping pass: `pairToolResults(events)`
walks the array and returns `{ pairs, unmatchedUses, unmatchedResults }`. That
is ~20 lines, it is pure, and it is directly unit-testable — and it makes the
malformed-conversation case of §6.4 *visible*, because an unmatched `tool_use`
renders as a defect card instead of being structurally impossible to represent
and therefore silently dropped.

### 7.4 Rendering

`renderTimeline` is incremental: it renders events from `lastRendered + 1`
and appends. No diffing, no re-render, no keys. Append-only in, append-only out.

Selecting a node writes its `data` into the detail pane as
`JSON.stringify(data, null, 2)` — the raw JSON that crossed the wire, not a
prettied summary of it. Learning the wire format requires seeing the wire
format.

---

## 8. Replay mode

**Replay mode is a feature, not a fallback.** It is what makes the UI testable,
and it is the only way to explore the visualiser with no key and no spend.

### 8.1 Trigger

If `ANTHROPIC_API_KEY` is unset, `/api/claude` returns **503** with:

```json
{
  "kind": "no_key",
  "status": 503,
  "message": "ANTHROPIC_API_KEY is not set on the server. Live runs are unavailable.",
  "replay": true,
  "fixtures": ["single-tool", "parallel-tools", "tool-error", "refusal", "iteration-cap"]
}
```

503 rather than 500 — the service is unavailable, the request was fine. And a
JSON body rather than a bare status, because the UI has to distinguish "no key"
from "key rejected" (401) and from "server down" (network error), and those need
three different messages.

On 503 the UI shows the **replay banner**, a persistent bar naming the mode and
listing the fixtures. It is not a toast: replay is a state, not an event, and a
user who missed the toast would read a recorded transcript as a live run.

Replay can also be entered deliberately with `?replay=single-tool`, key or no
key. Comparing a live run against a recorded one is the fastest way to see
whether a behaviour change is yours or the model's.

### 8.2 Mechanism

A fixture is an array of timeline events plus the request bodies that produced
them. `replayTransport(fixture)` implements the same interface `agent.js` takes
in live mode — `{ send, callTool }` — reading from the fixture instead of the
network. So replay drives **the real loop**: the real `stop_reason` checks, the
real cap counters, the real `buildToolResultMessage`. It is not a recording
being played into the renderer; it is the loop being fed recorded responses.

That is what makes the tests meaningful. `pipeline.test.mjs` runs the actual
agent loop against fixtures and asserts on the request bodies the loop produced
— which is how a split `tool_result` message is caught. A replay that bypassed
the loop could not catch it.

### 8.3 Fixtures

| Fixture | Covers |
|---|---|
| `single-tool` | One `tool_use`, one `tool_result`, `end_turn`. The happy path |
| `parallel-tools` | Two `tool_use` blocks in one assistant message. The §6.4 assertion |
| `tool-error` | A sandbox refusal as `is_error: true`, and the model recovering |
| `refusal` | `stop_reason: 'refusal'` with a populated `stop_details.category` |
| `iteration-cap` | A model that calls the same tool forever, tripping `maxIterations` |

Fixtures are hand-written to the recorded shapes, not captured live, because a
captured transcript embeds a real account's usage numbers and a real tree's file
contents. They are checked against the live shapes by a manual pass, and that
is a known gap (§14).

---

## 9. The UI

| Region | Contents |
|---|---|
| Prompt | Textarea, effort selector, tool-choice selector (`auto`/`none`), Run, Stop |
| Replay banner | Mode, reason, fixture picker. Persistent while in replay |
| Timeline | One card per event, ordered, colour-coded by type, keyboard navigable |
| Detail pane | Raw JSON of the selected event, `<pre>` with a copy button |
| Tool inventory | `tools/list` result: name, description, `strict`/`degraded` badge, schema |
| Readout | Turns, tool calls, input/output tokens, cache read/write, estimated cost, elapsed, cap headroom |

### 9.1 Accessibility

- The timeline is a `<ol>` with `role="list"`; each card is a
  `<button aria-expanded>` inside an `<li>`. Cards are focusable and operable
  with Enter and Space, and arrow keys move between them.
- `aria-live="polite"` on the readout, so a screen reader hears turn and token
  updates without being interrupted mid-sentence. **Not** `assertive`: a 12-turn
  loop with assertive updates talks over everything else.
- `aria-live="assertive"` is reserved for the failure region and the cap banner,
  which are the two things a user must hear immediately.
- Visible focus rings on every interactive element (`:focus-visible`, 2 px).
- `prefers-reduced-motion` removes the card-entry transition. The timeline is
  information, not animation, and a 12-turn run animating in is a nuisance.
- The timeline is genuinely visual and there is no non-visual equivalent of the
  *shape* of a run. The per-event text is readable in order, which is the
  honest limit of what this can offer.

---

## 10. What the visualiser reveals that logs do not

This is the project's reason to exist, so it needs an argument rather than an
assertion. A log line per event gives you everything in §7.2 as text. Five
things it cannot give you.

**1. Grouping, and therefore parallelism.** Two `tool_use` blocks in one
assistant message and two in consecutive turns produce the same four log lines
in the same order. The first is one round trip, the second is two. The timeline
renders them as one card with two children versus two cards — the distinction
is structural in the rendering and invisible in the log. And this is the exact
distinction §6.4 is about: the failure mode of splitting `tool_result` blocks is
*losing parallelism*, which you can only notice if you can see parallelism.

**2. The cache boundary.** Cache hits are a property of the *prefix*, which is
a relationship between consecutive requests, not a property of either. A log
prints `cache_read_input_tokens: 0` twelve times. The timeline puts the
tool-list hash beside the cache numbers in every `usage` node, so a miss shows
up as *the hash changed on turn 4* — a diagnosis, not a symptom. Finding the
same thing in logs means diffing two multi-kilobyte JSON bodies by eye.

**3. Pairing, and therefore malformation.** A missing `tool_result` for a
`tool_use` id is a malformed conversation. In a log it is an absence — you find
it by counting, and only if you already suspect it. The timeline pairs by
`tool_use_id` and renders an unmatched use as a defect card, so the bug appears
as a thing on screen rather than as a thing not on screen. **Absence is the
hardest thing to see in a log and the easiest to see in a diagram.**

**4. Arguments as the model actually sent them.** The timeline shows
`JSON.parse`d input next to the raw block. A schema mismatch — a string where an
integer was declared, an extra key — is a visible difference between two
adjacent panes. In a log it is one serialised line you have to read character by
character, and §6.4's escaping warning explains why reading it character by
character is unreliable.

**5. Proportion.** A 40-second run where 38 seconds were one filesystem search
looks, in a log, like a list of timestamps you subtract. On a timeline the
search card is wide. Nobody has ever optimised the wrong thing after looking at
a flame graph; everybody has after reading a log.

The honest counter-argument: logs grep, persist, aggregate across runs, and work
in CI. The timeline does none of that. It is a **debugger**, not an
observability stack, and it wins on exactly the axis a debugger wins on — the
first run, when you do not yet know what you are looking for.

---

## 11. Failure modes

| Condition | Behaviour |
|---|---|
| `ANTHROPIC_API_KEY` unset | 503 with JSON explanation; UI enters replay mode (§8) |
| Key present but invalid | 401 → `AuthenticationError` → `error` event naming the key as the cause, and an offer to switch to replay |
| Rate limited | 429 → `RateLimitError` → `error` event with the retry hint. The loop stops; it does not silently retry, because a silent retry inside a capped loop makes the caps lie |
| 400 from a bad request | `error` event with the API's own message verbatim. §4.1 catches the known-bad shapes earlier with better messages |
| MCP subprocess fails to spawn | `/api/mcp` returns 503; UI shows an empty tool inventory with the spawn error, and offers a no-tools run |
| MCP subprocess dies mid-run | In-flight call returns `is_error: true`; `server.js` respawns once, then reports permanently. A respawn loop on a crashing server is worse than a clear failure |
| MCP writes a non-JSON line to stdout | Parse error surfaced verbatim with the offending line, plus a pointer to §3.1 — this is the `console.log` mistake and the message says so |
| Sandbox refusal | `tool_result` with `is_error: true`; renders as a refusal card, not an error card. The model recovers and the run continues |
| A cap trips | `cap` event, terminal banner, `run_end.completed: false` (§6.3) |
| `stop_reason: 'refusal'` | `stop` event with the category; run ends cleanly, no retry |
| Tool call exceeds 5 s | `is_error: true` with `timeout after 5000ms`. Run continues |

Every path renders something. There is no state in which the timeline stops
growing with no explanation — the equivalent of `webgpu-particles`' black
canvas, and the same rule applies.

---

## 12. Configuration

| Parameter | Location | Default |
|---|---|---|
| API key | `ANTHROPIC_API_KEY` env, server only | unset → replay mode |
| Model | `MODEL` env, `server.js` | `claude-opus-5-5` |
| Effort | UI selector, `output_config.effort` | `medium` |
| `max_tokens` | `server.js` | 64000 streaming, 16000 non-streaming |
| MCP root | `MCP_ROOT` env | the project directory |
| MCP spawn | `server.js` | `node mcp/server.mjs` |
| `maxIterations` | `CAPS`, `agent.js` | 12 |
| `maxToolCalls` | `CAPS`, `agent.js` | 40 |
| `tokenBudget` | `CAPS`, `agent.js` | 200000 |
| `wallClockMs` | `CAPS`, `agent.js` | 120000 |
| Per-call timeout | `CAPS`, `agent.js` | 5000 ms |
| Replay fixture | `?replay=<name>` | none |
| Port | `PORT` env | 5173 |
| Bind address | `HOST` env | `127.0.0.1` |

`.env.example` documents the key. `.gitignore` ignores `.env` and every
`.env.*` except the example. **No real key is ever written to a file in this
repository.**

Cost estimates use `claude-opus-5-5` rates: **$4.00 / MTok input, $20.00 / MTok
output, $0.20 / MTok cache read**. Cache *writes* are priced at 1.25× input
($5.00 / MTok) — that multiplier is the standard one but is **not** confirmed
from a primary source here, and it is the one number in the readout to verify
before trusting a total. The readout labels the estimate as an estimate.

---

## 13. Testing strategy

Four files, no dependencies, no browser, no key, no network. `npm test`, or
`npm test -- <suite>` for one. Each suite runs in its own process so fake-DOM
globals cannot leak — `tests/run.mjs` is `galaxy-spiral/tests/run.mjs`
verbatim, and greps stdout for lines beginning `PASS` and `FAIL`.

| Suite | Layer |
|---|---|
| `unit` | Schema mapping, strictness classification, timeline model, path sandbox |
| `boot` | DOM wiring against a fake DOM parsed from `index.html`; replay mode |
| `pipeline` | The real loop against fixtures, asserting on recorded request bodies |

`tests/harness.mjs` builds the fake DOM by parsing `index.html` — the same
technique as `galaxy-spiral/tests/harness.mjs`, and for the same reason: it
catches an id renamed in the markup but not in the script, which is a class of
bug no pure-function test can see. It also provides the fake transports.

### 13.1 The two tests that exist for a specific bug

**Parallel `tool_result` blocks are not split.** `pipeline.test.mjs` runs the
`parallel-tools` fixture and asserts, on the recorded request body of the turn
*after* the parallel call, that (a) exactly one user message was appended, and
(b) it contains exactly as many `tool_result` blocks as there were `tool_use`
blocks. **This test fails if the results are split across messages** — the
degradation of §6.4, which produces no error and no warning at run time.

**A path traversal or symlink escape fails.** Assertions in both suites:
`unit.test.mjs` covers `normaliseRequestPath` and `isInsideRoot` on traversal
strings, absolute paths, NUL bytes and the `root`/`root-evil` sibling case, all
pure and fast. `pipeline.test.mjs` builds a real temporary tree with a real
symlink pointing outside the root and asserts `resolveSafe` rejects reads
through it. **This test fails if the escape succeeds.**

On Windows, creating a symlink needs Developer Mode or elevation. When
`symlink()` throws `EPERM` the symlink test reports **FAIL** with the reason
rather than skipping. A silently skipped security test is worse than a red one:
a skip reads as a pass on every dashboard that counts passes.

### 13.2 Not covered

- **No live API call.** Nothing in the suite proves the request shape is
  accepted. Every API fact in §6 is asserted against a fixture that this project
  wrote, so a fixture that encodes a wrong belief passes. **Green tests plus a
  400 from the real API is an expected state, not a contradiction.** Closing it
  needs a keyed smoke test, which is in the backlog.
- **No real subprocess in the suites.** `/api/mcp` is exercised through a fake
  transport. `decodeFrames` and `handleMessage` are unit-tested directly, so the
  framing and dispatch are covered; the spawn, the pipe and the lifecycle are
  not. `npm run mcp` plus the pipe in §3.6 is the manual check.
- **No rendered pixels.** The fake DOM records calls; it does not lay anything
  out.
- **TOCTOU and hard links.** Named in §4.2 as undefended. A test would only
  assert the current behaviour, not a guarantee.

---

## 14. Known limitations

1. **MCP subset.** `initialize`, `notifications/initialized`, `tools/list`,
   `tools/call`. No resources, no prompts, no sampling, no progress
   notifications, no cancellation. A client expecting those gets `-32601`.
2. **One server, one root.** Multiple MCP servers would need name collision
   handling in §5 and a per-tool provenance badge in the inventory.
3. **Request-response bridge, not a stream.** `/api/mcp` is one JSON-RPC message
   in, one out. Server-initiated notifications have nowhere to go. A tool that
   wanted to report progress cannot.
4. **Fixtures are hand-written**, so they encode this document's beliefs about
   the API rather than observed responses. §13.2.
5. **Cache-write pricing is unverified.** §12.
6. **No cross-run history.** Each run starts empty. Comparing two runs means two
   browser tabs.
7. **Cost is an estimate** computed from `usage`, not from billing. Cache-write
   pricing (5) is the largest source of error.
8. **`search_files` is literal substring only.** Deliberate (§3.5), but it means
   "find every `TODO(` " needs the parenthesis and "find `foo` or `bar`" needs
   two calls.
9. **The timeline is unbounded in memory.** A 12-turn run with large file reads
   holds every `tool_result` string. The caps bound it in practice; there is no
   eviction.

---

## 15. Possible extensions

- A keyed smoke test, opt-in via env, asserting the request shape of §6.1 is
  accepted — closing the §13.2 gap that matters most
- Export a run as a fixture, so a live run becomes a regression test with one
  click, and fixtures stop being hand-written
- Connect an arbitrary MCP server by command line, with the trust conversation
  that requires
- A side-by-side diff of two runs' event arrays, which append-only makes almost
  free
- Streaming `/api/mcp` over SSE so server-initiated notifications and tool
  progress have a channel
- Write tools behind an explicit confirmation gate, and the §4.2 re-analysis
  that would need
- A regex mode for `search_files` on a linear-time engine

---

## 16. Changelog

### 1.0 — Draft (unimplemented)

Initial specification. Nothing is built. Module skeletons throw
`NotImplemented` naming the section they must satisfy, and the test suites are
written to fail red against them.

Decisions taken here rather than deferred to implementation, because each one
is a thing that is expensive to change later:

| Decision | Rationale |
|---|---|
| `server.js` is a proxy, not a static server | The browser cannot hold the key (§2.2) and cannot speak stdio (§2.1). Both boundaries force a Node middle |
| Field allowlist on `/api/claude` | An open relay to a paid API is the security bug to avoid (§4.1) |
| `model` is server-side only | Otherwise the endpoint is a cost oracle (§4.1) |
| `realpath` re-check after the prefix check | A prefix check is a string operation; a symlink is a filesystem fact (§4.2) |
| Root `realpath`ed once at startup | A symlinked root otherwise fails its own prefix test |
| Non-strict tools are marked degraded, not dropped | A tool vanishing on a schema detail is invisible; `strict: true` on an unrepresentable schema 400s the whole request (§5.3) |
| `additionalProperties` and `required` repaired; `additionalProperties: true` not | Filling an omission is a narrowing of intent; contradicting an explicit value is not (§5.2) |
| Tools sorted by name on both sides | Byte-stable tool list, or every turn is a cache miss (§6.6) |
| Append-only event array | Replay and live become one code path; ordering is the lesson (§7.3) |
| Replay drives the real loop | A replay that bypassed the loop could not catch a split `tool_result` (§8.2) |
| `display: 'summarized'` | The default is `omitted`, which renders blank thinking nodes (§6.1) |
| Four caps, not one | Iterations do not bound parallel tool work, and a hung tool spends no tokens (§6.3) |
| Literal substring search, not regex | A model-supplied regex is an unbounded input to a backtracking engine (§3.5) |
| Sandbox refusal is `isError`, not `-32602` | `-32602` tells the model its arguments were malformed, encouraging a retry (§3.4) |

**Deliberately not done in 1.0:** a live smoke test against the real API. It is
the most valuable missing coverage (§13.2) and it is left out on purpose — every
run of the suite would need a key and would cost money, which would make `npm
test` something contributors avoid. The mitigation is that the request shape
lives in one pure function (`buildRequest`) rather than being assembled inline,
so a single keyed test can cover it when one is added. That is tracked in
FEATURES.md rather than pretended away here.
