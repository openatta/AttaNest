#!/usr/bin/env bash
# Build a backend carrying the WebAssembly plugin carrier.
#
# **This is not the build Nest ships.** AttaCore carries one extension carrier
# or none, and the two are mutually exclusive: the shipped build carries the
# QuickJS script carrier, so its `plugin.*` answers PLUGINS_DISABLED and
# nothing installs. Packaging is bundled with the WebAssembly carrier by a
# feature flag upstream, which is what makes a second build necessary at all.
#
# Splitting them is filed against AttaCore. When it lands, packages install in
# the ordinary build and this script can go.
#
#   scripts/build-plugin-carrier.sh
#   node tests/package-e2e.mjs
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$root/target/plugin-carrier"
manifest="$root/Cargo.toml"
backup="$(mktemp)"

# The carrier is chosen in the workspace dependency table, and `cargo --config`
# does not reach a path dependency there — so the table is edited, built, and
# put back. Restored on any exit, including a failed build or a ^C.
cp "$manifest" "$backup"
restore() { cp "$backup" "$manifest"; rm -f "$backup"; }
trap restore EXIT

python3 - "$manifest" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); s = p.read_text()
s = s.replace(
    'daemon      = { path = "core/daemon" }',
    'daemon      = { path = "core/daemon", default-features = false, features = ["plugin-compile"] }',
)
p.write_text(s)
PY

echo "building the plugin-carrier backend (not the shipped one)…"
cargo build --release -p nest --target-dir "$out/build"

mkdir -p "$out"
cp "$out/build/release/nest" "$out/nest"
echo "  → target/plugin-carrier/nest"
