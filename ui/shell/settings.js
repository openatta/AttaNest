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

import { $, el, button, icon } from "../runtime/dom.js";
import { ICON } from "../runtime/icons.js";
import { call, errorText } from "../runtime/client.js";
import { state } from "../runtime/state.js";
import { banner } from "../shell/session.js";
import { at, render as renderPoint } from "../runtime/contrib.js";
import { openModal, closeModal } from "../shell/modals.js";
import { setTheme, currentThemeChoice } from "../runtime/theme.js";
import { t, locales, localeChoice, setLocale } from "../runtime/i18n/index.js";

/** The pages this file supplies, handed to `settings.section` at boot.
 *
 * The panel draws whatever is registered at that point, so a plugin's section
 * sits in the same nav as these and is reached the same way. Exported rather
 * than registered here, because registration belongs to `ui/builtin/`, which
 * is the one place that knows the whole built-in set. */
export const BUILTIN_SECTIONS = [
  { id: "general", label: "settings.nav.general", render: renderGeneral },
  { id: "scenes", label: "settings.nav.scenes", render: renderScenes },
  { id: "models", label: "settings.nav.models", render: renderModels },
  { id: "mcp", label: "settings.nav.mcp", render: renderMcp },
  { id: "plugins", label: "settings.nav.plugins", render: renderPlugins },
  { id: "devices", label: "settings.nav.devices", render: renderDevices },
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
      const sections = at("settings.section");
      for (const section of sections) {
        nav.appendChild(button(`nav-item${section.id === active ? " on" : ""}`, section.label, () => {
          active = section.id;
          paint();
        }));
      }
      page.innerHTML = "";
      const section = sections.find((s) => s.id === active) || sections[0];
      // A section that throws loses its page, not the panel: the nav stays
      // usable so the reader can go somewhere else.
      if (section && !renderPoint("settings.section", section, page)) {
        page.appendChild(el("div", "empty", t("details.noPanel")));
      }
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

/** Plugins are AttaCore's. This page installs one and lists what is there.
 *
 * Two failures are shown differently on purpose. **`PLUGINS_DISABLED` means
 * this build carries no plugin subsystem at all** — AttaCore carries one
 * extension carrier or none, and the script carrier and the plugin carrier
 * are mutually exclusive, so the build that has scripts has no plugins. That
 * is a different fact from "nothing is installed", and showing it as an empty
 * list would send the reader looking for a package that could never load. */
function renderPlugins(page) {
  // `nest.plugins.list`, not the engine's own — it answers with what is
  // installed *and* what of it reaches this side, and it turns
  // PLUGINS_DISABLED into a fact the page can state instead of an error it
  // has to interpret.
  section(page, t("settings.plugins"), () => call("nest.plugins.list"),
    (host, data) => {
      if (data.available === false) {
        host.appendChild(el("div", "hint", data.reason || t("settings.pluginsUnavailable")));
        return;
      }
      host.appendChild(installer());
      const plugins = data.plugins || [];
      if (!plugins.length) host.appendChild(el("div", "hint", t("settings.pluginsNone")));
      for (const plugin of plugins) {
        host.appendChild(row(
          `${plugin.name} ${plugin.version || ""}`,
          el("div", "control", [
            button("btn sm outline", plugin.enabled ? t("settings.pluginDisable") : t("settings.pluginEnable"),
              async () => {
                await call(plugin.enabled ? "nest.plugins.disable" : "nest.plugins.enable", { name: plugin.name });
                openSettings();
              }),
            button("btn sm danger", t("common.remove"), async () => {
              if (!confirm(t("settings.pluginRemoveConfirm", { name: plugin.name }))) return;
              await call("nest.plugins.uninstall", { name: plugin.name });
              openSettings();
            }),
          ]),
          plugin.description || "",
        ));
        const contributes = (data.contributes || []).find((c) => c.plugin === plugin.name);
        for (const entry of contributes?.ui ?? []) {
          host.appendChild(row(t("settings.pluginContributes"),
            el("span", "value", entry.point), entry.module));
        }
        for (const reason of contributes?.inert ?? []) {
          host.appendChild(row(t("settings.pluginInert"), el("span", "value", ""), reason));
        }
        // Separate line, because "will not appear" and "works, but worth
        // knowing" are different things to be told.
        for (const note of contributes?.notes ?? []) {
          host.appendChild(row(t("settings.pluginNote"), el("span", "value", ""), note));
        }
      }
    });
}

/** Pick a `.zip`, send it up the bulk channel, then ask the engine to install
 *  it from where it landed.
 *
 * AttaCore fetches packages itself and has no upload channel, which is fine
 * when the package is already on the machine running the engine and useless
 * when it is on the reader's laptop. This is that one step, and nothing more:
 * the file is not opened on this side. */
function installer() {
  const status = el("div", "hint", "");
  const pick = el("input");
  pick.type = "file";
  pick.accept = ".zip";
  pick.onchange = async () => {
    const file = pick.files && pick.files[0];
    if (!file) return;
    status.textContent = t("settings.pluginUploading", { name: file.name });
    try {
      const grant = await call("nest.plugins.upload", { name: file.name });
      const response = await fetch(grant.url, { method: "POST", body: file });
      if (!response.ok) throw { message: await response.text() };
      status.textContent = t("settings.pluginInstalling");
      const result = await call("nest.plugins.install", { path: grant.path, name: file.name });
      // The engine installs and *then* says what the package will put in
      // front of the model. That order is the engine's, so it is the order
      // shown: installed, here is what it will say, keep it or remove it.
      status.textContent = result.message || t("settings.pluginInstalled");
      if (result.disclosure) {
        status.appendChild(el("pre", "", typeof result.disclosure === "string"
          ? result.disclosure
          : JSON.stringify(result.disclosure, null, 2)));
      }
    } catch (e) {
      status.textContent = errorText(e);
    }
  };
  return el("div", "", [
    button("btn sm outline", t("settings.pluginInstall"), () => pick.click()),
    el("div", "hint", t("settings.pluginInstallHint")),
    status,
  ]);
}

/** Paired devices, and the one screen a pairing code is ever shown on.
 *
 * The code is minted, displayed once and kept only as a hash, so this is the
 * single moment it exists in the clear anywhere. It is read off here and
 * typed into the other machine — which is why it is large, monospaced and
 * has a countdown rather than sitting quietly in a row.
 *
 * Revoking is immediate and total: a credential belongs to the device, not to
 * a connection, so there is no such thing as revoking one of its channels. */
function renderDevices(page) {
  section(page, t("settings.devices"), () => call("nest.devices.list"), (host, data) => {
    host.appendChild(el("div", "hint", t("settings.devicesHint")));

    const devices = data.devices || [];
    if (!devices.length) host.appendChild(el("div", "hint", t("settings.devicesNone")));
    for (const device of devices) {
      host.appendChild(row(
        device.label || device.id,
        button("btn sm danger", t("settings.deviceRevoke"), async () => {
          if (!confirm(t("settings.deviceRevokeConfirm", { name: device.label || device.id }))) return;
          await call("nest.devices.revoke", { device_id: device.id });
          openSettings();
        }),
        device.id,
      ));
    }

    const shown = el("div", "");
    host.appendChild(button("btn sm outline", t("settings.devicePair"), async () => {
      shown.innerHTML = "";
      try {
        const grant = await call("nest.devices.pair.begin", { label: t("settings.deviceNew") });
        const left = el("span", "hint", "");
        shown.appendChild(el("div", "pairing-code", grant.code));
        shown.appendChild(el("div", "hint", t("settings.devicePairHint")));
        shown.appendChild(left);
        // A countdown, not a timestamp: the question being asked is "do I
        // still have time to walk over there", and a clock time does not
        // answer it.
        let remaining = grant.expires_in_secs;
        const tick = setInterval(() => {
          remaining -= 1;
          if (remaining <= 0) {
            clearInterval(tick);
            shown.innerHTML = "";
            shown.appendChild(el("div", "hint", t("settings.devicePairExpired")));
            return;
          }
          left.textContent = t("settings.devicePairLeft", {
            minutes: Math.floor(remaining / 60),
            seconds: String(remaining % 60).padStart(2, "0"),
          });
        }, 1000);
      } catch (e) {
        shown.appendChild(el("div", "hint", errorText(e)));
      }
    }));
    host.appendChild(shown);
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

  // What did not take, and why.
  //
  // The registry records every registration that was refused and every render
  // that threw. Collecting that and never showing it would leave the one
  // failure mode this interface has no other symptom for — a part that simply
  // does not appear — with nowhere to be found (§2.4).
  page.appendChild(el("h3", "", t("settings.contributions")));
  const refused = state.contributionRefusals || [];
  if (!refused.length) {
    page.appendChild(el("div", "hint", t("contrib.noneRefused")));
  } else {
    for (const entry of refused) {
      page.appendChild(row(
        t("contrib.refusedAt", { point: entry.point }),
        el("span", "value", entry.owner),
        entry.reason,
      ));
    }
  }

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
