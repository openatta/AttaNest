# API tests

A real backend, a real engine, and a client that talks to it the way the
interface does — same methods, same params, same frames. What is under test is
the **backend**, through the only surface a client ever has.

```sh
node tests/api/run.mjs                           # everything, replayed
node tests/api/run.mjs 04-hub 13-agent           # named suites
node tests/api/run.mjs --topology split_streams  # the same suites, other topology
node tests/api/run.mjs --live                    # against a real model
node tests/api/run.mjs --no-model                # neither; model-shaped suites skip
```

## Turns are replayed, not called

By default every model call comes from a **recorded fixture**
(`fixtures/recordings/`). The same tool is called every run, at the same
point, with the same arguments — no provider, no network, no waiting, and a
whole suite in a couple of seconds.

That is not a convenience. Before it, the permission path had never once been
exercised: the configured model would not reach for a tool, so the tests that
needed one reported *inconclusive* run after run, and `session.respondToPrompt`
sat at 0% coverage while everything looked green. Replay took that from
"depends on what a provider felt like today" to a fact.

`--live` calls a real model. Two suites are live-only, and say why in their
own headers: `05-turns` needs turns that take real time (a replayed one
settles in ~300ms, which makes "a client arrives mid-turn" a race rather than
a test), and `11-recordings` is about the recording being *written*, which a
replaying session does not do.

## Where this sits among the other tests

| | drives | needs |
|---|---|---|
| `tests/reducer-smoke.mjs` | the **interface**, against a scripted socket | nothing |
| `tests/api/` | the **backend**, through the client-facing API | a binary; a model for some suites |
| `tests/browser/interface.spec.mjs` | layout and themes, in a real browser | chromium |
| `tests/browser/interaction.spec.mjs` | typing, tool rows, permission cards — real UI on a real backend | chromium |
| `tests/package-e2e.mjs` | a package from zip to a row on screen | chromium; the release binary |
| `tests/topology-parity.mjs` | both topologies give the same answers | a backend serving **both** |
| `tests/remote-smoke.mjs` | pairing, TLS, revocation | a **reachable** backend, TLS, both topologies |

The last four want a backend started a particular way, and each one now says
so when it is not: `ui-smoke` and `tool-smoke` need `--scenes chat`, the two
below it need a profile listing both topologies, and `remote-smoke` needs a
non-loopback bind — on loopback the per-process token is the whole story by
design, so its rules have nothing to gate.

```toml
# profile.toml — what the last three want
[transport]
topologies = ["single_duplex", "split_streams"]
host = "0.0.0.0"          # loopback only for the first two
port = 4310
```

```
nest --profile profile.toml --scenes chat --tls-cert cert.pem --tls-key key.pem
```

The reducer tests are the server, so every event kind can be produced on
demand — which covers the front end and, deliberately, none of the back end.
These are the other half.

## Coverage is measured, not claimed

The backend answers `nest.reachable` with every method a client may call. The
harness records every method the suites call and reports the difference:

```
── coverage ──
  55/56 reachable methods exercised (98%)
  not exercised:
    session.respondToPrompt
```

Measured against what the backend says, not against a list kept by hand — a
hand-kept list drifts the moment a method is added, and it drifts in the
direction that makes coverage look better.

## Three outcomes, not two

`ok`, `FAIL`, and **`--` inconclusive**.

A permission test whose model never reached for a tool has not shown that
permissions work. Reporting it green would be the test lying; reporting it red
would train people to ignore red. So it says what happened, and the coverage
line shows the method it did not reach.

## Writing a suite

A file in `suites/`, exporting a default object. The numeric prefix is the
order they run in.

```js
export default {
  needsModel: true,          // skipped entirely without one
  setup: async ({ backend }) => ({ /* merged into every test's context */ }),
  tests: {
    "what this shows": async ({ client }) => { /* throw to fail */ },
  },
};
```

Each test gets **its own client**. The event log is per client, and sharing
one meant a test could match a frame an earlier test produced — which is how
two of these went green and red on alternate runs until it was found. A
handshake costs milliseconds; a test whose result depends on what ran before
it costs considerably more.

### The client

- `call(method, params)` — throws the JSON-RPC error on refusal
- `refused(method, params)` — returns the error, or `null` if it went through
- `waitFor(predicate, { timeout, describe })` — waits on a frame; `describe`
  is what the timeout message says it was waiting for
- `eventsOfKind(kind, sessionId)` / `text(sessionId)` — what arrived
- `handshake` — what was agreed
- `inconclusive(reason)` — from `../harness.mjs`

Wait on a predicate, never on a clock. That is the difference between a suite
that is slow and one that is flaky.

## The model

Read from `.env` at the repository root, in shell form:

```sh
export ANTHROPIC_AUTH_TOKEN=…
export ANTHROPIC_BASE_URL=…
export ANTHROPIC_MODEL=…
```

Without it, suites marked `needsModel` are **skipped, not failed**: a missing
credential is a fact about the machine, and turning it into a red test trains
people to ignore red tests.

Every run gets a fresh engine directory. A suite that inherited yesterday's
sessions would be a suite whose failures depend on what somebody did
yesterday.

## Leave nothing running

Every test that starts a turn ends with `finish(client, sessionId)`: interrupt,
**wait for the settlement**, then delete.

This is not tidiness. Deleting a session with a turn still running leaves the
engine finishing work for something that no longer exists, and the next test
pays for it — three tests here passed alone and failed in a full run until it
was found, and the failures moved around between runs, which is the shape that
takes longest to diagnose.
