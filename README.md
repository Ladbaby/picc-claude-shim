# picc-claude-shim

[![npm downloads](https://img.shields.io/npm/dt/@ladbabynpm/picc-claude-shim.svg)](https://www.npmjs.com/package/@ladbabynpm/picc-claude-shim)

Drop-in replacement for the Claude Code CLI, by disguising [pi](https://github.com/earendil-works/pi) as Claude Code.
Part of [picc](https://github.com/Ladbaby/picc), a pi agent setup mirroring Claude Code's harness.
Softwares built upon Claude Code, like [hapi](https://github.com/tiann/hapi) and [T3 Code](https://github.com/pingdotgg/t3code), can directly replace Claude Code with pi.

The shim parses the Claude-flavored CLI flags, creates a pi `AgentSession`, and translates bidirectionally between pi session events and Claude Code's  `stream-json` wire protocol (`system`/`assistant`/`result`/`control_request`/`control_response`).
It also mirrors each turn into a Claude/hapi-compatible session JSONL and reports a Claude-style version, so hosts that probe `claude --version` or scan `~/.claude/projects/**/<session-id>.jsonl` see exactly what they would see against a real Claude Code install.

## Modes

| Mode | Invocation | Purpose |
|------|------------|---------|
| `stream-json` | `--output-format stream-json --input-format stream-json` | The primary host target. Bidirectional NDJSON over stdin/stdout; speaks the Claude Code SDK protocol and bridges a live pi session. |
| `json` | `--output-format json` | One-shot single-JSON-object output. With `--json-schema <schema>` emits `{"structured_output": <value>}` (t3code's commit/PR/title text-generation parser); without, emits a single Claude `result` message. Prompt arrives inline or on stdin. |
| `print` | `--print <prompt>` (or bare `-p`) | One-shot text output. Streams the assistant's final text to stdout and exits 0. Used for quick smoke tests. |
| local (TTY) | (default, no JSON flags) | **Not supported.** Emits an explicit error and exits 1 — pi's interactive TUI uses Ink and would conflict with a host's terminal handling. |

`--version` and `--help` are answered by a fast JS path (`bin/claude.js`) without loading the pi
runtime. `--version` prints `1.0.37 (Claude Code)` — the version the shim impersonates
(`src/version.js`), so host version checks pass.

## Install

Install as a pi package — one command does the whole job:

```bash
pi install npm:@ladbabynpm/picc-claude-shim
```

`pi install` runs `npm install`, which fires the package's `postinstall` hook (`install.js`). That
hook writes the `claude.cmd` (Windows), `claude` (POSIX; skipped on Windows unless
`PI_SHIM_POSIX=1`), and `claude.exe` (Windows, only if one was built) entry wrappers into the first
writable directory on PATH (`~/.local/bin`, then `~/bin`). These thin wrappers forward to
`bin/claude.js`. This is the `claude` a host (hapi, T3 Code, the Claude Agent SDK) discovers via
`which`/`where`.

pi also records `npm:@ladbabynpm/picc-claude-shim` in `~/.pi/agent/settings.json#packages` and
loads the `pi.extensions` manifest itself, so no manual registration is needed. Verify with:

```bash
claude --version
```

## Flags

Parsed by `parseClaudeArgs` (`src/args.ts`). Unrecognized flags are collected and reported on the
startup banner but do not fail the run.

| Flag | Effect |
|------|--------|
| `--output-format stream-json` / `--input-format stream-json` | Enable stream-json mode. |
| `--output-format json` | Enable json (one-shot) mode. |
| `--print <prompt>` / `-p` | Enable print mode. Bare `-p` reads the prompt from stdin. |
| `--permission-prompt-tool stdio` | Accepted. The permission gate is in practice open for any non-`bypassPermissions` mode. |
| `--permission-mode <mode>` / `--dangerously-skip-permissions` | `bypassPermissions` closes the gate entirely; other modes are forwarded to `PICC_PERMISSION_MODE` for `@ladbabynpm/picc-permission-modes`. |
| `--system-prompt <text>` | Replace the pi system prompt. |
| `--append-system-prompt <text>` | Append to the pi system prompt. |
| `--resume <id>` | Open the existing pi session with that id (falls back to a fresh session if not found). |
| `--continue` | Continue the most recent pi session in the cwd. |
| `--allowed-tools <list>` / `--disallowed-tools <list>` | Allow/deny tools, mapped through the tool-name table below. |
| `--model <id>` | Parsed, surfaced in `system/init` until the real pi model is known. See [Known limitations](#known-limitations). |
| `--max-turns <n>` | Parsed but not enforced. |
| `--include-partial-messages` | When set, the translator emits partial assistant message updates. |
| `--json-schema <schema>` | (json mode only) Emit `{"structured_output": <value>}` decoded against the schema. |

### Tool name mapping

Mappings in `src/tool-names.ts` are **case-insensitive in both directions** to match picc's
registered tool names, which may be lowercase (`read`, `bash`, `grep`) or PascalCase (`Read`,
`Edit`, `Glob`). pi `find` maps to Claude `Glob` (picc-glob accepts both `Glob` and `find`); the
other built-ins map identity-modulo-case. Unknown tools (TodoWrite, WebSearch, etc.) have no pi
equivalent — if a tool-call gate asks permission for one, the shim replies with
`control_response{behavior:"deny"}`.

| pi (canonical) | Claude wire name |
|----------------|------------------|
| `read` | `Read` |
| `write` | `Write` |
| `edit` | `Edit` |
| `bash` | `Bash` |
| `grep` | `Grep` |
| `find` | `Glob` |
| `ls` | `LS` |

## Testing

Run the unit tests:

```bash
node test/run-all.mjs
```

Tests cover:

- `args.test.ts` — flag parsing (`--output-format`, `--permission-prompt-tool`, etc.)
- `tool-names.test.ts` — pi ↔ Claude tool name mapping (case-insensitive)
- `session-jsonl.test.ts` — hapi JSONL writer
- `session-resume.test.ts` — resume id resolution
- `cost.test.ts` — usage + cost synthesis
- `permission-gate.test.ts` — when the permission gate is open/closed
- `translator.test.ts` — stdin → pi calls
- `translator-out.test.ts` — pi events → Claude NDJSON (result fields, control_request)
- `compact.test.ts` — `/compact` parsing and interception
- `skills.test.ts` — skill discovery + expansion
- `structured-output.test.ts` — `--json-schema` value extraction

`entry.e2e.test.ts` is a separate live-backend test (needs a configured pi model + API key) and is
not part of `run-all.mjs`. Run it with:

```bash
node test/run-e2e.mjs
```

## Files

```
picc-claude-shim/
├── package.json         # @ladbabynpm/picc-claude-shim; jiti dep, pi peer deps
├── tsconfig.json
├── install.js           # postinstall: writes claude.cmd/claude/claude.exe (registers locally when not pi-managed)
├── README.md
├── scripts/
│   ├── build-exe.mjs    # build native claude.exe (Claude Agent SDK spawn path on Windows)
│   └── claude_launcher.c
├── bin/
│   ├── claude.js        # Node entry; --version/--help fast path, else imports src/entry.ts via jiti
│   ├── claude.cmd       # Windows entry template (install.js fills in the path)
│   ├── claude           # POSIX entry
│   ├── claude.exe       # native entry (built by scripts/build-exe.mjs)
│   └── entry-slow.mjs   # jiti loader; aliases pi-coding-agent to pi's install
├── src/
│   ├── index.ts         # no-op extension factory; registers --claude-shim-install flag
│   ├── entry.ts         # orchestrator: args → pi session → protocol loop (all modes)
│   ├── args.ts          # parseClaudeArgs — Claude-flavored argv parser
│   ├── translator.ts    # bi-directional event/message translation
│   ├── session-jsonl.ts # hapi-compatible session JSONL writer
│   ├── tool-names.ts    # case-insensitive pi ↔ Claude tool name mapping
│   ├── cost.ts          # synthesizeUsageAndCost from pi's SessionStats
│   ├── skills.ts        # Claude skill discovery + expansion
│   ├── structured-output.ts # --json-schema value extraction
│   └── version.js       # version string the shim impersonates
└── test/                # unit + e2e tests (see Testing)
```

## Known limitations

- `--model` is parsed and surfaced in `system/init` but does not select a model; pi picks from
  `~/.pi/agent/settings.json#defaultModel`. Honoring arbitrary provider IDs requires plumbing
  through pi's `ModelRuntime` registry.
- `--max-turns` is parsed but not enforced; the session runs as many turns as the agent decides.
- Hook forwarder commands (the `hapi hook-forwarder` invocation Claude Code runs on SessionStart)
  are not triggered. Hosts tolerate this when `system/init` and the JSONL file are both present.

## Differences from Claude Code

These are intentionally out of scope for picc-claude-shim.

- **No local (TTY) mode** — stream-json, json, and print only.
- **No hooks** — `--settings` SessionStart hook forwarding is not invoked.
- **No `--model` selection** — pi's default model is used.
- **No `--max-turns` enforcement.**
- **Skill inline bash** — Claude Code executes inline `` !`…` `` injections in a skill body before
  sending; the shim forwards the substituted body as-is and lets pi's agent run such commands via
  its own tools.
- **No `.agents/skills` scan** — only the user and project `.claude/skills` roots Claude Code
  verifies are scanned.
- **No `--output-format stream-json` partial streaming** by default — set
  `--include-partial-messages` to emit partial assistant updates.
