//! The catalog and its documentation, compared.
//!
//! A list of extension points that can go stale is worse than none: it gets
//! quoted as fact. So the table in `docs/contribution_points.md` is rendered
//! from `nest_contrib::catalog` and this fails when the two disagree —
//! change the catalog, not the table.

use std::path::{Path, PathBuf};

const BEGIN: &str = "<!-- BEGIN GENERATED TABLE — see nest_contrib::catalog::render_markdown -->";
const END: &str = "<!-- END GENERATED TABLE -->";

fn doc_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("crates/app is two levels below the root")
        .join("docs/contribution_points.md")
}

#[test]
fn the_documented_table_is_the_generated_one() {
    let path = doc_path();
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let start = text.find(BEGIN).unwrap_or_else(|| panic!("{} has no generated-table marker", path.display()));
    let end = text.find(END).unwrap_or_else(|| panic!("{} has no end marker", path.display()));
    let documented = text[start + BEGIN.len()..end].trim();
    let generated = nest_contrib::catalog::render_markdown();
    assert_eq!(
        documented,
        generated.trim(),
        "\n{} is out of date. Regenerate it from nest_contrib::catalog.\n",
        path.display()
    );
}
