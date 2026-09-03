/** `sidebar.group` — how the session list is grouped and ordered.
 *
 * Evaluated when the set of sessions changes. A contribution returns groups;
 * the shell draws them, keeps the collapse state and handles the drag. What
 * the point owns is the answer to "which sessions belong together and in what
 * order" — grouping by scene, by day, by whether a turn is running are all
 * registrations rather than forks.
 *
 * The workspace grouping below is the product's own answer, and it holds the
 * one fact worth stating: a session Nest has never opened has no project root
 * to group by, because `session.list` does not carry one. It gets its own
 * group rather than a guess, and it moves out the moment it is opened. */

export function sidebarGroups(host) {
  const { t, state } = host;

  const sortRows = (rows, manualOrder) => {
    const order = manualOrder && manualOrder.length ? manualOrder : null;
    rows.sort((a, b) => {
      if (order) {
        const ia = order.indexOf(a.session_id);
        const ib = order.indexOf(b.session_id);
        if (ia !== -1 || ib !== -1) return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
      }
      return String(b.last_active || "").localeCompare(String(a.last_active || ""));
    });
  };

  return [
    {
      id: "builtin.workspace",
      label: () => t("sidebar.byWorkspace"),
      /** Registered workspaces first, in their stored order; then whatever is
       *  left — no project, then never opened. */
      group(sessions) {
        const workspaces = state.workspaces || [];
        const groups = workspaces.map((workspace) => ({
          key: workspace.id,
          workspace,
          title: workspace.title,
          hint: workspace.path,
          rows: [],
        }));
        const byId = new Map(groups.map((group) => [group.key, group]));
        const loose = { key: "loose", title: t("sidebar.groupLoose"), rows: [] };
        const unknown = { key: "unknown", title: t("sidebar.groupUnknown"), rows: [] };

        for (const session of sessions) {
          const group = session.workspace_id && byId.get(session.workspace_id);
          if (group) group.rows.push(session);
          else if (session.scene) loose.rows.push(session);
          else unknown.rows.push(session);
        }

        for (const group of groups) sortRows(group.rows, group.workspace.session_order);
        sortRows(loose.rows);
        sortRows(unknown.rows);

        return [...groups, loose, unknown].filter((group) => group.rows.length);
      },
    },
  ];
}
