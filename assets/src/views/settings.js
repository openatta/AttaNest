/** The settings panel: a modal shell with a section list on the left.
 *
 * Shape follows DSH (`ui-settings` declares the seats, `ui-settings-general`
 * owns the shell, each feature owns its page); here the sections are a plain
 * table because there are no plugins to register more of them.
 *
 * Sections that only read are complete. The ones that write engine settings
 * land with `nest.settings.*` — the engine exposes `config.get`/`reload` but
 * no generic write, so Nest writes the tier's settings.json itself and asks
 * the engine to reload (docs/architecture.md §11). Until then those rows say
 * so rather than pretending. */

import { $, el, button, icon } from "../dom.js";
import { ICON } from "../icons.js";
import { call, errorText } from "../rpc.js";
import { state } from "../state.js";
import { banner } from "../session.js";
import { openModal, closeModal } from "./modals.js";
import { setTheme, currentThemeChoice } from "../theme.js";
import { t, locales, localeChoice, setLocale } from "../i18n/index.js";

const SECTIONS = [
  { id: "general", label: "settings.nav.general", render: renderGeneral },
  { id: "scenes", label: "settings.nav.scenes", render: renderScenes },
  { id: "models", label: "settings.nav.models", render: renderModels },
  { id: "mcp", label: "settings.nav.mcp", render: renderMcp },
  { id: "plugins", label: "settings.nav.plugins", render: renderPlugins },
  { id: "diagnostics", label: "settings.nav.diagnostics", render: renderDiagnostics },
  { id: "about", label: "settings.nav.about", render: renderAbout },
];

let active = "general";
/** Bumped on every navigation; a late `load()` whose generation is stale is
 *  discarded instead of painting over the page the user is now looking at. */
let generation = 0;

export function openSettings() {
  openModal(t("settings.title"), (body, foot) => {
    body.classList.add("settings-body");
    const nav = el("div", "settings-nav");
    const page = el("div", "settings-page");
    body.append(nav, page);

    const paint = () => {
      generation += 1;
      nav.innerHTML = "";
      for (const section of SECTIONS) {
        nav.appendChild(button(`nav-item${section.id === active ? " on" : ""}`, t(section.label), () => {
          active = section.id;
          paint();
        }));
      }
      page.innerHTML = "";
      const section = SECTIONS.find((s) => s.id === active) || SECTIONS[0];
      section.render(page);
    };
    paint();

    foot.appendChild(button("btn outline", t("common.close"), closeModal));
  });
}

/* ── rows ─────────────────────────────────────────────────────────────── */

function row(label, control, hint) {
  return el("div", "srow-setting", [
    el("div", "text", [el("div", "label", label), hint ? el("div", "hint", hint) : null]),
    el("div", "control", control),
  ]);
}

function select(options, value, onChange) {
  const node = el("select");
  for (const [key, text] of options) {
    const option = el("option", "", text);
    option.value = key;
    node.appendChild(option);
  }
  node.value = value;
  node.onchange = () => onChange(node.value);
  return node;
}

function pending(text) {
  return el("span", "pending", text);
}

async function section(page, title, load, render) {
  const mine = generation;
  page.appendChild(el("h3", "", title));
  const host = el("div", "");
  page.appendChild(host);
  host.appendChild(el("div", "hint", t("common.loading")));
  try {
    const data = await load();
    if (mine !== generation) return;
    host.innerHTML = "";
    render(host, data);
  } catch (e) {
    if (mine !== generation) return;
    host.innerHTML = "";
    host.appendChild(el("div", "hint err", errorText(e)));
  }
}

/* ── sections ─────────────────────────────────────────────────────────── */

/** Editable settings for one tier, with where the effective value came from. */
async function renderEngineSettings(page, only) {
  const scene = (state.session && state.session.scene)
    || ((state.hello && state.hello.engine.active_scenes) || [])[0];
  const projectRoot = (state.session && state.session.project_root) || null;
  const request = { scene, project_root: projectRoot };

  await section(page, t("settings.engineDefaults"), () => call("nest.settings.describe", request),
    (host, data) => {
      const tier = state.settingsTier || "global";
      const paths = data.paths || {};

      const picker = select(
        [["global", t("settings.tier.global")], ["scene", t("settings.tier.scene", { scene })],
         ["project", t("settings.tier.project")]].filter(([id]) => paths[id]),
        tier,
        (value) => {
          state.settingsTier = value;
          openSettings();
        },
      );
      host.appendChild(row(t("settings.tier"), picker, paths[tier] || ""));

      for (const field of data.fields || []) {
        if (only && !only.includes(field.key)) continue;
        const own = field.tiers[tier];
        const inherited = own === null || own === undefined;
        const write = (value) => call("nest.settings.set", { ...request, tier, key: field.key, value })
          .then(() => { banner(t("settings.written", { path: paths[tier] })); setTimeout(() => banner(null), 2500); openSettings(); })
          .catch((e) => banner(t("settings.writeFailed", { error: errorText(e) })));

        let control;
        if (field.kind === "choice") {
          control = select((field.options || []).map((o) => [o, o]), String(field.effective ?? ""), write);
        } else if (field.kind === "flag") {
          control = el("input", { type: "checkbox", checked: !!field.effective });
          control.onchange = () => write(control.checked);
        } else {
          control = el("input", { type: "text", value: String(field.effective ?? "") });
          control.onchange = () => write(field.kind === "count" ? Number(control.value) : control.value);
        }

        const controls = [control];
        if (!inherited) {
          controls.push(button("btn sm outline", t("settings.clear"), () => write(null), {
            title: t("settings.clearHint"),
          }));
        }
        const notes = [inherited ? t("settings.inherited") : t("settings.setHere")];
        if (field.source) notes.push(t("settings.sourceTier", { tier: t(`settings.tier.${field.source}`, { scene }) }));
        // The engine keeps a per-(project, scene) cache that `config.reload`
        // does not clear, so a fresh write can be on disk and not yet in the
        // running engine. Say so rather than pretending.
        if (field.engine !== null && field.engine !== undefined
            && JSON.stringify(field.engine) !== JSON.stringify(field.effective)) {
          notes.push(t("settings.engineLags", { value: JSON.stringify(field.engine) }));
        }
        host.appendChild(row(t(`settings.field.${field.key}`), controls, notes.join(" · ")));
      }
    });
}

function renderGeneral(page) {
  page.appendChild(el("h3", "", t("settings.appearance")));
  page.appendChild(row(t("settings.theme"), select(
    [
      ["system", t("settings.theme.system")],
      ["light", t("settings.theme.light")],
      ["dark", t("settings.theme.dark")],
    ],
    currentThemeChoice(),
    (value) => setTheme(value),
  ), t("settings.themeHint")));

  page.appendChild(row(t("settings.language"), select(
    locales().map((entry) => [entry.id, entry.label]),
    localeChoice(),
    (value) => setLocale(value),
  ), t("settings.languageHint")));

  renderEngineSettings(page, ["permission_mode", "memory_enabled", "allow_client_permission_override"]);
}

function renderScenes(page) {
  section(page, t("settings.scenes"), () => call("scene.list"), (host, data) => {
    for (const scene of data.scenes || []) {
      const caps = scene.capabilities || {};
      const control = scene.active
        ? el("span", "value ok", t("settings.sceneActive"))
        : button("btn sm outline", t("settings.sceneActivate"), async () => {
            try {
              await call("scene.activate", { scene: scene.scene });
              banner(t("settings.sceneActivated", { scene: scene.scene }));
              setTimeout(() => banner(null), 2500);
            } catch (e) {
              banner(errorText(e));
            }
          });
      host.appendChild(row(
        `${scene.name || scene.scene} · ${scene.scene}`,
        control,
        [
          caps.requires_project ? t("settings.sceneNeedsProject") : t("settings.sceneNoProject"),
          caps.supports_team ? t("settings.sceneSupportsTeam") : null,
          t("settings.sceneSessions", { count: scene.sessions || 0 }),
        ].filter(Boolean).join(" · "),
      ));
    }
  });
}

function renderModels(page) {
  renderEngineSettings(page, ["model.model_name", "model.max_tokens"]);

  const scene = (state.session && state.session.scene)
    || ((state.hello && state.hello.engine.active_scenes) || [])[0];
  const projectRoot = (state.session && state.session.project_root) || null;

  section(page, t("settings.providers"),
    () => call("nest.settings.describe", { scene, project_root: projectRoot }),
    (host, data) => {
      const providers = (data.providers && data.providers.providers) || {};
      const names = Object.keys(providers);
      if (!names.length) host.appendChild(el("div", "hint", t("settings.providersNone")));
      for (const id of names) {
        const provider = providers[id];
        host.appendChild(row(
          id,
          [
            el("span", `value ${provider.api_key ? "ok" : "err"}`,
              provider.api_key ? t("settings.keySet") : t("settings.keyMissing")),
            button("btn sm outline", t("common.edit"), () => providerDialog(id, provider, scene, projectRoot)),
          ],
          [provider.api_type, provider.base_url, provider.default_model].filter(Boolean).join(" · "),
        ));
      }
      host.appendChild(button("btn sm outline", [icon(ICON.key, "glyph"), t("settings.providerAdd")],
        () => providerDialog("", {}, scene, projectRoot)));
      host.appendChild(el("div", "hint", t("settings.providerHint")));
    });
}

/** Add or edit one provider — the only path credentials take from the UI. */
function providerDialog(id, provider, scene, projectRoot) {
  openModal(id ? t("settings.providerEdit", { id }) : t("settings.providerAdd"), (body, foot) => {
    const fields = {};
    const add = (key, label, value, type) => {
      const input = el("input", { type: type || "text", value: value || "" });
      fields[key] = input;
      body.appendChild(el("div", "field", [el("label", "", label), input]));
    };
    if (!id) add("provider_id", t("settings.providerId"), "");
    add("api_type", t("settings.apiType"), provider.api_type || "anthropic");
    add("base_url", t("settings.baseUrl"), provider.base_url || "");
    add("api_key", t("settings.apiKey"), "", "password");
    add("default_model", t("settings.defaultModel"), provider.default_model || "");
    body.appendChild(el("div", "hint", t("settings.apiKeyHint")));

    foot.appendChild(button("btn outline", t("common.cancel"), closeModal));
    if (id) {
      foot.appendChild(button("btn outline danger", t("common.delete"), async () => {
        try {
          await call("nest.settings.setProvider", { provider_id: id, delete: true });
          closeModal();
          openSettings();
        } catch (e) { banner(errorText(e)); }
      }));
    }
    foot.appendChild(button("btn primary", t("common.save"), async () => {
      const providerId = id || fields.provider_id.value.trim();
      if (!providerId) return banner(t("settings.providerIdRequired"));
      const config = {
        api_type: fields.api_type.value.trim(),
        base_url: fields.base_url.value.trim(),
        default_model: fields.default_model.value.trim(),
      };
      if (fields.api_key.value) config.api_key = fields.api_key.value;
      try {
        await call("nest.settings.setProvider", { provider_id: providerId, config });
        closeModal();
        openSettings();
      } catch (e) { banner(t("settings.writeFailed", { error: errorText(e) })); }
    }));
  });
}

function renderMcp(page) {
  section(page, t("settings.mcpServers"), () => call("mcp.status"), (host, data) => {
    const servers = data.servers || [];
    if (!servers.length) host.appendChild(el("div", "hint", t("settings.mcpNone")));
    for (const server of servers) {
      host.appendChild(row(
        server.name,
        el("span", `value ${server.connected ? "ok" : "err"}`,
          server.connected ? t("settings.mcpConnected") : t("settings.mcpDisconnected")),
        `${t("settings.mcpTools", { count: server.tools || 0 })}${server.error ? ` · ${server.error}` : ""}`,
      ));
    }
    host.appendChild(el("div", "hint", t("settings.mcpAddHint")));
  });
}

function renderPlugins(page) {
  section(page, t("settings.plugins"), () => call("plugin.list"), (host, data) => {
    const plugins = data.plugins || [];
    if (!plugins.length) host.appendChild(el("div", "hint", t("settings.pluginsNone")));
    for (const plugin of plugins) {
      host.appendChild(row(
        `${plugin.name} ${plugin.version || ""}`,
        el("span", `value ${plugin.enabled ? "ok" : ""}`, plugin.enabled ? t("settings.pluginEnabled") : t("settings.pluginDisabled")),
        plugin.description || "",
      ));
    }
  });
}

function renderDiagnostics(page) {
  section(page, t("settings.engine"), () => call("daemon.status"), (host, data) => {
    host.appendChild(row(t("settings.version"), el("span", "value", data.version || t("common.none"))));
    host.appendChild(row(t("settings.uptime"), el("span", "value", t("settings.uptimeValue", { minutes: Math.round((data.uptime_secs || 0) / 60) }))));
    host.appendChild(row(t("settings.sessionCount"), el("span", "value", String(data.sessions ?? "—"))));
    host.appendChild(row(t("settings.activeScenes"), el("span", "value",
      ((state.hello && state.hello.engine.active_scenes) || []).join(" · ") || t("common.none"))));
  });

  const report = el("div", "");
  page.appendChild(el("h3", "", t("settings.doctor")));
  page.appendChild(button("btn sm outline", [icon(ICON.refresh, "glyph"), t("settings.doctorRun")], async () => {
    report.innerHTML = "";
    report.appendChild(el("div", "hint", t("common.running")));
    try {
      const data = await call("daemon.doctor");
      report.innerHTML = "";
      report.appendChild(el("div", "hint", data.ok ? t("settings.doctorOk") : t("settings.doctorFailed")));
      for (const check of data.checks || []) {
        report.appendChild(row(
          `${check.scope} · ${check.name}`,
          el("span", `value ${check.ok ? "ok" : "err"}`, check.ok ? t("settings.checkPass") : t("settings.checkFail")),
          check.detail || "",
        ));
      }
    } catch (e) {
      report.innerHTML = "";
      report.appendChild(el("div", "hint err", errorText(e)));
    }
  }));
  page.appendChild(report);
}

function renderAbout(page) {
  const hello = state.hello || {};
  const limits = hello.limits || {};
  page.appendChild(el("h3", "", t("settings.about")));
  page.appendChild(row(t("settings.protocolVersion"), el("span", "value", String(hello.protocol_version || "—"))));
  page.appendChild(row(t("settings.cwd"), el("span", "value", hello.cwd || t("common.none"))));
  page.appendChild(row(t("settings.attaDir"), el("span", "value", hello.engine.data_root || t("common.none")),
    t("settings.attaDirHint")));
  page.appendChild(row(t("settings.projectsDir"), el("span", "value", hello.projects_root || t("common.none")),
    t("settings.projectsDirHint")));
  page.appendChild(row(t("settings.stateDir"), el("span", "value", hello.state_dir || t("common.none")),
    t("settings.stateDirHint")));
  page.appendChild(row(t("settings.frameLimit"), el("span", "value",
    t("settings.megabytes", { size: Math.round((limits.max_frame_bytes || 0) / 1048576) }))));
  page.appendChild(row(t("settings.uploadLimit"), el("span", "value",
    t("settings.megabytes", { size: Math.round((limits.max_upload_bytes || 0) / 1048576) }))));
}
