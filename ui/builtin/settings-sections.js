/** `settings.section` — a section of the settings panel.
 *
 * Evaluated when the settings page opens. Each section says what it is called
 * and draws itself into the page node it is given; the shell owns the nav and
 * the order.
 *
 * The pages themselves live in `ui/shell/settings.js` — they are large and
 * they are this product's own. What matters here is that they arrive through
 * the point, in the same list a plugin's section joins, so there is no
 * private path for the built-in ones to take.
 */

import { BUILTIN_SECTIONS } from "../shell/settings.js";

export function settingsSections(host) {
  const { t } = host;
  return BUILTIN_SECTIONS.map((section) => ({
    id: `builtin.${section.id}`,
    // The nav asks for `id` and a label; the point asks for `render`.
    label: t(section.label),
    render: section.render,
  })).map((c, i) => ({ ...c, id: BUILTIN_SECTIONS[i].id }));
}
