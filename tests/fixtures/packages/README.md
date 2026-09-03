# Package fixtures

`demo-rows/` is a package source; `demo-rows.zip` is it, packed the way the
engine's installer takes one.

It contributes a single interface module: a `tool.row` that claims `Bash` and
leaves every other tool alone. That is enough to show the whole path — the
file goes up the bulk channel, the engine installs and discloses it, Nest
reads the one section the engine ignores and serves the directory
same-origin, the browser imports the module, and the row it registers wins
over the built-in one because it registered later.

Re-pack after editing:

```sh
cd tests/fixtures/packages/demo-rows && zip -qr ../demo-rows.zip .
```

## Why this needs a `plugins` build

The engine carries one extension carrier or none, and the packaging system is
bundled with the WebAssembly one by a feature flag — so in the build Nest
ships, `plugin.*` answers `PLUGINS_DISABLED` and nothing installs. The test
that uses this fixture builds its own backend with `--features plugin-compile`
and skips when it cannot.

Splitting packaging from the carrier is filed against AttaCore; when it lands,
this works in the ordinary build and the test stops needing its own.
