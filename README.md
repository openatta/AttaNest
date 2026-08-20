# AttaNest

English | [简体中文](README.zh-CN.md)

**[AttaCore](https://github.com/openatta/AttaCore) in a browser.** One Rust binary: the engine, the
web server and the frontend are the same process — no subprocess, no socket, no npm.

![AttaNest](docs/images/nest.png)

`daemon` is a library, so `nest` links the engine in and talks to it through a function call rather
than a socket. That removes a whole category of things to operate: no port for the engine, no
handshake, no health check, no restart supervisor, no discovery file. And the frontend is native ES
modules served straight out of the binary, so there is no bundler, no `node_modules`, and no build
step between editing a file and reloading the page.

## Status

Early. The engine underneath it is real work and the UI is complete enough to use daily, but this
repository is young and the protocol between the browser and the hub is ours to change. Expect
breaking changes; pin a commit if you depend on one.

## Run it

```sh
git clone --recurse-submodules https://github.com/openatta/AttaNest.git
cd AttaNest
cargo build --release
./target/release/nest                      # → http://127.0.0.1:4080/
```

Rust 1.80 or newer. No Node, no package manager, nothing else. The `--recurse-submodules` matters:
AttaCore lives at `core/` and the build needs it.

No environment variable is required. With no credentials configured, open **Settings → Models &
credentials → Add provider** and fill in a base URL and an API key — it is written to
`settings.json`, and never reaches the browser or the logs. If you prefer the environment, set
`ANTHROPIC_AUTH_TOKEN` (plus an optional `ANTHROPIC_BASE_URL`). With neither, startup fails and
says so.

## What makes it interesting

- **A turn belongs to the server, not to your tab.** Close the tab mid-turn, reload, come back on
  another one — the hub subscribed to the session *before any browser asked*, so the frames you
  missed are already buffered and you catch up from them. This is the invariant the whole design
  rests on, and it is why a refresh cannot lose a half-finished answer.

- **You can read exactly what was sent to the model.** Not a summary — the assembled system blocks,
  the complete tool catalog and the call configuration, with each block and each tool naming the
  stage that produced it (`identity`, `skills`, `memory`, `mcp:<server>`, `plugin:<id>`). See below.

- **No build step for the frontend.** `nest --assets-dir ./assets` serves the SPA from disk instead
  of from the binary: edit, reload, done.

- **It shares state with the terminal.** The engine directory is the same `~/.atta` that
  `attacored` and AttaCode use, so a session you ran in the TUI opens here, and vice versa.

- **Sends queue instead of failing.** Send while a turn is running and it goes in a queue that
  drains when the turn ends. Stopping clears the queue too.

- **Localhost only, and it enforces it.** Loopback binding (both `127.0.0.1` and `[::1]`, because
  browsers resolve `localhost` to `::1` first), a per-process token, an Origin check, and a CSP with
  no inline anything and no external sources.

- **English and 简体中文** throughout, switchable at runtime.

## In the UI

Three panes, in the shape of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
sessions on the left grouped by project, the conversation in the middle (streaming markdown, tool
cards, permission cards, compaction marks, sub-agents), details on the right (the full input and
output of one call).

- Enter sends, Shift+Enter breaks a line; `/` opens command completion, fed by the engine's live
  command list; `@` references a project file (respecting `.gitignore`)
- ⌘K / Ctrl+K for a new session; right-click a session row to close, fork or delete it
- The sidebar groups by project: collapsible, five per group by default, drag to reorder, rename,
  archive. Type to filter titles; press Enter to search inside conversations instead
- Images paste or drop into the composer and become 64px thumbnails
- Settings covers appearance, language, engine settings (model, per-turn tokens, permission mode —
  each writable to the global, scene or project tier), providers and credentials, scenes, MCP,
  plugins and diagnostics

## The request envelope

![The request envelope](docs/images/request-envelope.png)

Every model call carries an envelope — the system prompt as assembled, every tool definition, the
call configuration — and normally you never see it. AttaCore records each call, and Nest folds
those recordings into the points where the envelope *changed*, so the conversation shows one row
per change and the details pane shows the full text.

Because it is read from a recording rather than received as an event, it survives: reload the page,
reopen the conversation tomorrow, restart the process — the envelope is still there. Recordings
live in `<atta-dir>/recordings/<session-id>/` and are deleted with the session.

They also contain everything the model saw, in plain text, with no redaction. Treat a recording as
you would the transcript it belongs to.

## Options

```
nest --port 4080 --scene coding --scenes chat,research --model claude-sonnet-5
```

| Option | Meaning |
|---|---|
| `--port` / `--host` | Defaults `4080` / `127.0.0.1`. Loopback addresses only; given IPv4 loopback it **also listens on `[::1]`** |
| `--scene` / `--scenes` | Default scene, and scenes activated alongside it (`coding` `chat` `research` `demo`) |
| `--atta-dir` | Engine directory: config, transcripts, memory, skills, recordings. Defaults to `$ATTA_CONFIG_HOME`, then `~/.atta` |
| `--data-dir` | Project directory: where the picker opens and new projects are created. Defaults to `$NEST_DATA_DIR`, then `~/Documents` |

<details>
<summary>Less common options</summary>

| Option | Meaning |
|---|---|
| `--model` / `--max-tokens` | For new sessions. The three settings tiers still outrank them, as in `attacored` |
| `--session-cap` / `--session-idle-timeout` | Ceiling on live sessions, and idle reclamation |
| `--permission-prompt-timeout` | How long an unanswered permission prompt waits before counting as a refusal (default 300s; the UI counts down) |
| `--assets-dir` | Serve the frontend from disk instead of from the binary — for development |

</details>

## Directories

Two, and only two:

- **Engine directory** `--atta-dir` (default `~/.atta`) — config, transcripts, memory, skills,
  recordings. Shared with `attacored` and AttaCode.
- **Project directory** `--data-dir` (default `~/Documents`) — where the picker starts and where
  "new project" creates. A default, not a fence: projects elsewhere under `$HOME` open fine.

```sh
nest --atta-dir /srv/atta --data-dir /srv/projects
```

What you install is one binary. The web app is compiled into it and nothing is read from the
install directory at runtime. Nest's own bookkeeping — workspaces, titles, view preferences, the
token, uploads — is data too, and lives in `.nest/` under the project directory.

## Layout

```
crates/app      the `nest` binary
crates/web      axum: static files, /ws, /upload, Origin + token + CSP
crates/hub      the session hub: sole engine connection, event replay, send queue, method allow-list
crates/engine   AttaCore assembly
assets/         the SPA, unbuilt: index.html + styles/*.css + src/**.js, compiled into the binary
core/           AttaCore (submodule)
```

## Documentation

[docs/architecture.md](docs/architecture.md) is the design record — why the browser does not talk to
the engine directly (§3), how catch-up and replay keep a reload from losing anything (§5), which
methods are not exposed to the browser (§4.1), and the trade-offs behind running the engine
in-process (§2). *Written in Chinese.*

## Tests

```sh
cargo clippy --workspace
cargo test -p nest -p nest-hub -p nest-engine -p nest-web   # our Rust tests

node tests/style-lint.mjs                        # static style checks: icon sizing, tokens, ids
node tests/reducer-smoke.mjs                     # frontend logic, offline, fastest
node tests/i18n-smoke.mjs                        # language-pack health
node tests/readme-pairing.mjs                    # the two READMEs moved together
node tests/ui-smoke.mjs   <port> <token>         # real engine + real model
node tests/tool-smoke.mjs <port> <token>         # real tool calls
```

`<token>` comes from the token file `nest` prints at startup (`<data-dir>/.nest/token`).

**Do not run `cargo test --workspace`.** It would also run the absorbed AttaCore crates, and two of
Core's tests assume they are at the workspace root (they walk upward looking for `bridges/`), which
cannot hold here. Run Core's tests in Core: `cd core && cargo test --workspace`.

## License

[Apache-2.0](LICENSE).
