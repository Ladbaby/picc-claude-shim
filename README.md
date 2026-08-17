# pi-claude-shim

Drop-in replacement for [Claude Code](https://github.com/anthropics/claude-code)'s
CLI, powered by [pi](https://github.com/earendil-works/pi). Lets third-party
tools that spawn `claude` — specifically
[hapi](https://github.com/tiann/hapi) — drive a pi session with zero changes.

## What this is

`hapi` spawns the Claude Code CLI as a subprocess and exchanges JSON-lines over
stdin/stdout. It builds `claude` command-line arguments from
`hapi/cli/src/claude/sdk/query.ts:280-365` and reads `claude`'s output as
NDJSON. The protocol:

```
claude --output-format stream-json --input-format stream-json --verbose \
       [--permission-prompt-tool stdio] [--system-prompt X] [--resume ID] ...
```

Emits messages like:

```
{type:"system",    subtype:"init",  session_id, model, cwd, tools, slash_commands}
{type:"assistant", message:{role:"assistant", content:[{type:"text"|"tool_use",...}]}}
{type:"result",    subtype, usage, total_cost_usd, duration_ms, session_id}
{type:"control_request",  request_id, request:{subtype:"can_use_tool", tool_name, input}}
{type:"control_response", response: {request_id, subtype, response:{behavior:"allow"|"deny"}}}
```

This extension adds a `claude` binary entry script that **translates between
the Claude Code NDJSON protocol and pi's session events** so that hapi works
unchanged against pi.

## Install

Run once:

```bash
cd ~/.pi/agent/extensions/pi-claude-shim
node install.js
```

This:
1. Adds `extensions/pi-claude-shim` to `~/.pi/agent/settings.json#packages`
   so pi auto-loads the extension factory.
2. Writes `~/.local/bin/claude.cmd` (POSIX `claude`) — a thin wrapper that
   forwards to `bin/claude.js`. This is the entry that hapi spawns.

If a real `claude.cmd` already exists, the install refuses to overwrite
unless you pass `--force`. The alternative is to set
`HAPI_CLAUDE_PATH=/full/path/to/pi-claude-shim/bin/claude.cmd` (the path
hapi's `cli/src/claude/sdk/utils.ts:145-200` already honors for Claude Code
overrides).

## How hapi drives the shim

When you run `hapi` against a session, hapi invokes `claudeRemote` which
spawns the configured `claude` binary as a subprocess. With this shim
installed, the binary is the shim, which:

1. Parses Claude-flavored flags (`--output-format stream-json`,
   `--permission-prompt-tool stdio`, `--system-prompt`, etc.).
2. Creates a pi `AgentSession` via `createAgentSession()`.
3. Subscribes to pi events, accumulates partial content into a
   content-block buffer, and flushes `assistant.content` blocks on
   `message_end`.
4. Writes `system/init` (with session_id, model, cwd, tools).
5. Writes a hapi-compatible session JSONL at
   `$CLAUDE_CONFIG_DIR/projects/<sanitized-cwd>/<session-id>.jsonl`
   so hapi's `claudeCheckSession` (`cli/src/claude/utils/claudeCheckSession.ts`)
   observes the file.
6. Reads NDJSON from stdin. `user` messages feed `session.prompt()`;
   `control_response` resolves outstanding permission gates.
7. Mirrors each user/assistant message into the JSONL with a UUID for
   hapi's session scanner.
8. On `agent_end` (and stdin close), computes usage synthesis from
   `session.getSessionStats()` and emits a final `result` message.
9. Exits 0.

## Verified end-to-end

```
$ node bin/claude.js --output-format stream-json --input-format stream-json --verbose << 'EOF'
{"type":"user","message":{"role":"user","content":"say lol"}}
EOF

{"type":"system","subtype":"init","session_id":"019f8d49-...","model":"Tresor/claude-sonnet",...}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"lol 😂"}]}}
{"type":"result","subtype":"success","result":"lol 😂","num_turns":1,
 "usage":{"input_tokens":1,"output_tokens":3,"cache_read_input_tokens":9243,...},
 "total_cost_usd":0,"duration_ms":2926,...}
```

## Scope

- ✅ Remote mode (`--output-format stream-json --input-format stream-json`)
- ✅ Tool permission negotiation (`--permission-prompt-tool stdio`)
- ✅ System prompt replace and append (`--system-prompt`, `--append-system-prompt`)
- ✅ Resume / continue (`--resume`, `--continue`)
- ✅ Allowed / disallowed tools, model, permission-mode flags
- ✅ Hapi-compatible session JSONL at `<projectDir>/<session-id>.jsonl`
- ✅ One-shot `--print <prompt>` mode for quick smoke tests
- ❌ Local (TTY-attached) mode — out of scope; emits an explicit error
- ❌ Hooks (`--settings` SessionStart) — not invoked; rely on `system/init` + JSONL
- ❌ `--model` flag is parsed but not yet honored (pi's model selection is
       based on `~/.pi/agent/settings.json` defaults)
- ❌ `--max-turns` is parsed but not enforced

## Tested behavior

Run the unit tests:

```bash
node test/run-all.mjs
```

Tests cover:
- `args.test.ts` — flag parsing (`--output-format`, `--permission-prompt-tool`, etc.)
- `tool-names.test.ts` — Claude/Anthropic ↔ pi tool name mapping
- `session-jsonl.test.ts` — hapi JSONL writer
- `cost.test.ts` — usage + cost synthesis
- `translator.test.ts` — stdin → pi calls
- `translator-out.test.ts` — pi events → Claude NDJSON
- `entry.e2e.test.ts` — full end-to-end subprocess handshake

## Files

```
extensions/pi-claude-shim/
├── package.json         # @earendil-works/pi-coding-agent + jiti deps
├── tsconfig.json
├── install.js           # postinstall — registers extension, writes claude.cmd
├── README.md
├── bin/
│   ├── claude.js        # Node entry; imports src/entry.ts via jiti
│   ├── claude.cmd       # Windows entry that forwards to claude.js
│   └── claude           # POSIX entry
├── src/
│   ├── index.ts         # Extension factory (no-op; registers --claude-shim-install flag)
│   ├── entry.ts         # Orchestrator: args → pi session → protocol loop
│   ├── args.ts          # parseClaudeArgs — Claude-flavored argv parser
│   ├── translator.ts    # bi-directional event/message translation
│   ├── session-jsonl.ts # hapi-compatible session JSONL writer
│   ├── tool-names.ts    # PascalCase ↔ lowercase tool name mapping
│   ├── cost.ts          # synthesizeUsageAndCost from pi's SessionStats
│   └── types.ts         # (reserved for future shared types)
└── test/
    ├── args.test.ts
    ├── tool-names.test.ts
    ├── session-jsonl.test.ts
    ├── cost.test.ts
    ├── translator.test.ts
    ├── translator-out.test.ts
    ├── entry.e2e.test.ts
    ├── run-all.mjs      # Run all unit tests
    └── run-e2e.mjs      # Run e2e test specifically
```

## Design choices

- **Why an extension?** Pi already auto-discovers local extensions in
  `~/.pi/agent/extensions/`. The shim lives there instead of being a
  separate npm package because pi-version drift would otherwise break the
  wire protocol.

- **Why a separate `claude` binary rather than a `pi claude-shim` flag?**
  hapi spawns a binary literally named `claude` via `which`/`where`
  lookup. Pi has no API to alias itself as `claude`. The install script
  drops a thin wrapper at `~/.local/bin/claude.cmd`.

- **Tool name mapping:** built-ins (Read, Write, Edit, Bash, Grep, Glob,
  LS) map identity-modulo-case. Unknown tools (TodoWrite, WebSearch,
  etc.) are not yet supported; if a tool-call gate asks permission for
  one, the shim replies with `control_response{behavior:"deny"}`.

- **Thinking blocks:** dropped on the wire for now. pi's `thinking_delta`
  events are observed but not emitted; consumers can still see them in
  the JSONL session log.

- **Cost & duration:** `total_cost_usd` is taken straight from pi's
  `SessionStats.cost` (which pi calculates against the model's pricing).
  `duration_api_ms` mirrors `duration_ms` because pi does not separate
  the two at the per-session granularity Claude exposes — this is
  marked as a known approximation in the plan.

- **Why no Local mode?** pi's interactive TUI uses Ink and would conflict
  with hapi's terminal handling. Surfacing an explicit error is more
  discoverable than silent misbehaviour.

## Known limitations

- The `--model` flag is parsed but the shim currently lets pi pick the
  model from `settings.json#defaultModel`. Honoring arbitrary provider
  IDs requires plumbing through pi's `ModelRuntime` registry.
- `--max-turns` is parsed but not enforced. The pi session runs as many
  turns as the agent decides; we may add a wrapper that aborts after N
  in a follow-up.
- Hook forwarder commands (the `hapi hook-forwarder` invocation Claude
  Code itself does on SessionStart) are not triggered. hapi tolerates
  this when `system/init` and the JSONL file are both present, but the
  hook-based session-start notification is skipped.
