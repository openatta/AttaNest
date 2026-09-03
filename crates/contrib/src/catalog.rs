//! Every seam the interface is assembled out of, and what each one costs.
//!
//! This is the source. The table in `docs/contribution_points.md` is rendered
//! from it, and a test compares the two — see the module docs.
//!
//! Engine and host extension points are *not* here, and not because they were
//! forgotten: extending the agent is AttaCore's, and a copy of its catalog
//! kept on this side would be a second copy to drift.

use std::fmt::Write as _;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointKind {
    /// Contribute a named, ordered, removable thing.
    Register,
    /// Fold a stream into derived state.
    Fold,
    /// Draw something.
    Render,
}

/// The order of magnitude a point fires at. This is a constraint, not
/// decoration: it decides whether a point is open, and to what.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Frequency {
    PerProcess,
    PerSession,
    PerTurn,
    /// When a block's state changes — a tool starts, finishes, fails. Tens
    /// per turn. Explicitly *not* per streaming delta.
    PerBlockChange,
    /// When the user's selection or a panel's input changes.
    PerInteraction,
}

impl Frequency {
    pub fn as_str(&self) -> &'static str {
        match self {
            Frequency::PerProcess => "每进程(10⁰ 量级)",
            Frequency::PerSession => "每会话(10⁰ 量级)",
            Frequency::PerTurn => "每轮(10⁰–10¹ 量级)",
            Frequency::PerBlockChange => "每次块状态变化(10¹ 量级)",
            Frequency::PerInteraction => "每次交互(10⁰–10¹ 量级)",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Point {
    pub id: &'static str,
    pub kind: PointKind,
    /// What a contribution here supplies.
    pub what: &'static str,
    /// When it is evaluated.
    pub when: &'static str,
    pub frequency: Frequency,
}

/// The six points the interface is built out of.
///
/// The number is part of the design (§5.2): a seventh is an argument to be
/// made, not a commit to be pushed. Every one of them is drawn by a built-in
/// registration **and asked for by the shell**, which is what makes the count
/// honest — a seam nothing uses is not a seam, it is a line in this list.
/// There was a seventh for a while, and it was exactly that.
pub const POINTS: &[Point] = &[
    Point {
        id: "tool.row",
        kind: PointKind::Render,
        what: "一次工具调用在流里的那一行:图标、标题、摘要",
        when: "该工具块状态变化时",
        frequency: Frequency::PerBlockChange,
    },
    Point {
        id: "details.panel",
        kind: PointKind::Render,
        what: "详情栏里的一页",
        when: "选中项变化时",
        frequency: Frequency::PerInteraction,
    },
    Point {
        id: "flow.block",
        kind: PointKind::Render,
        what: "流里的一种新块",
        when: "该块状态变化时",
        frequency: Frequency::PerBlockChange,
    },
    Point {
        id: "sidebar.group",
        kind: PointKind::Register,
        what: "会话列表的分组与排序",
        when: "会话集合变化时",
        frequency: Frequency::PerInteraction,
    },
    Point {
        id: "command",
        kind: PointKind::Register,
        what: "一条斜杠命令及其补全候选",
        when: "命令面板打开时",
        frequency: Frequency::PerInteraction,
    },
    Point {
        id: "settings.section",
        kind: PointKind::Render,
        what: "设置面板里的一节",
        when: "设置页打开时",
        frequency: Frequency::PerInteraction,
    },
];

pub fn point(id: &str) -> Option<&'static Point> {
    POINTS.iter().find(|p| p.id == id)
}

/// The table `docs/contribution_points.md` carries between its generated
/// markers. Changing a point changes the doc; a test enforces it.
pub fn render_markdown() -> String {
    let mut out = String::new();
    out.push_str("| 贡献点 | 类型 | 贡献什么 | 求值时机 | 频率 |\n");
    out.push_str("|---|---|---|---|---|\n");
    for p in POINTS {
        let kind = match p.kind {
            PointKind::Register => "注册",
            PointKind::Fold => "折叠",
            PointKind::Render => "呈现",
        };
        let _ = writeln!(
            out,
            "| `{}` | {} | {} | {} | {} |",
            p.id, kind, p.what, p.when, p.frequency.as_str()
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Six, and adding one is a decision (§5.2).
    #[test]
    fn the_interface_has_six_points() {
        assert_eq!(POINTS.len(), 6);
    }

    /// Nothing here may fire per streaming delta — the whole reason frequency
    /// is stated in the contract (§4.4).
    #[test]
    fn no_point_follows_the_stream() {
        for p in POINTS {
            assert!(
                matches!(
                    p.frequency,
                    Frequency::PerBlockChange | Frequency::PerInteraction | Frequency::PerTurn
                ),
                "{} fires too often to be contributable",
                p.id
            );
        }
    }
}
