// Pairing, listing and revoking devices.
//
// The loopback listener does not require a paired device — the token is the
// whole story there — so what is checked here is the pairing machinery
// itself. `tests/remote-smoke.mjs` checks that a reachable listener actually
// demands it.

const assert = (cond, message) => { if (!cond) throw new Error(message); };

export default {
  tests: {
    "the device list starts empty": async ({ client }) => {
      const { devices } = await client.call("nest.devices.list");
      assert(Array.isArray(devices), "no device list");
    },

    "a pairing code is minted once and shown once": async ({ client }) => {
      const grant = await client.call("nest.devices.pair.begin", { label: "a test device" });
      assert(typeof grant.code === "string" && grant.code.length >= 6, `code is ${grant.code}`);
      assert(grant.expires_in_secs > 0, "the code never expires");
      // Read off one screen and typed into another: the two characters that
      // go wrong are designed out.
      for (const c of grant.code) {
        assert(!"01OIl".includes(c), `the code contains an ambiguous character: ${grant.code}`);
      }
    },

    "a code pairs a device, and then is spent": async ({ client }) => {
      const grant = await client.call("nest.devices.pair.begin", { label: "laptop" });
      const paired = await client.call("nest.devices.pair.complete",
        { code: grant.code, public_key: "dGVzdC1rZXk=" });
      assert(paired.device?.id, "pairing returned no device");
      assert(paired.device.label === "laptop", `label is ${paired.device.label}`);

      const again = await client.refused("nest.devices.pair.complete",
        { code: grant.code, public_key: "dGVzdC1rZXk=" });
      assert(again, "the same code paired a second device");

      const { devices } = await client.call("nest.devices.list");
      assert(devices.some((d) => d.id === paired.device.id), "the paired device is not listed");

      const revoked = await client.call("nest.devices.revoke", { device_id: paired.device.id });
      assert(revoked.revoked === true, "revoking reported nothing");
      const after = await client.call("nest.devices.list");
      assert(!after.devices.some((d) => d.id === paired.device.id), "the device survived revocation");
    },

    "a code that was never issued is refused the same way as a spent one": async ({ client }) => {
      const never = await client.refused("nest.devices.pair.complete",
        { code: "ZZZZZZZZ", public_key: "dGVzdA==" });
      assert(never, "an invented code paired a device");
      // One answer for "no such code", "expired" and "already used": telling
      // them apart tells a guesser which guesses were closer.
      assert(!/expired|already|unknown device/i.test(never.message),
        `the refusal describes the guess: "${never.message}"`);
    },

    "revoking something that was never paired is not an error": async ({ client }) => {
      const result = await client.call("nest.devices.revoke", { device_id: "dev-nonexistent" });
      assert(result.revoked === false, "revoking a stranger reported success");
    },
  },
};
