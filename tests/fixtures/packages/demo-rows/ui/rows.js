// A contributed tool row.
//
// Registered after the built-ins, so it wins the claim for `Bash` and leaves
// every other tool to the row the product draws. That ordering is what
// "replace a row without forking" means in practice.
//
// Tokens only, keys only: a hard-coded colour is unreadable in the other
// theme, and hard-coded text turns the interface into two languages the
// moment somebody switches. The admission check enforces both.
export function activate(host) {
  host.register("tool.row", {
    match: (block) => block.name === "Bash",
    render: (block) => host.el("div", "blk row-item", [
      host.el("div", "row-head", [
        host.el("span", "name", "demo-rows"),
        host.el("span", "summary truncate", String(block.name || "")),
      ]),
    ]),
  });
}
