// The ceilings, approached rather than read.
//
// Every number in `nest.hello`'s `limits` used to be checked the same way:
// `> 0`. That says a field is present, not that the number means anything —
// and two of the three meant nothing at all. `max_frame_bytes` was published
// and enforced nowhere; `max_upload_bytes` was published as 32 MB while the
// web framework's own untouched default refused everything over 2 MB with a
// sentence naming neither Nest nor the channel. Installing an extension
// package of any real size was broken, and no test could see it because no
// test ever sent anything big.
//
// So these are slow and allocate. That is the cost of testing a limit: you
// have to reach it.

import { INVALID_PARAMS } from "../../../ui/runtime/protocol.js";
import { finish } from "../harness.mjs";

const assert = (cond, message) => { if (!cond) throw new Error(message); };

export default {
  tests: {
    "hello reports every ceiling a client has to respect": async ({ client }) => {
      const { limits } = await client.call("nest.hello");
      for (const key of ["max_frame_bytes", "max_upload_bytes", "replay_max_frames"]) {
        assert(typeof limits[key] === "number" && limits[key] > 0,
          `limits.${key} is ${JSON.stringify(limits[key])}`);
      }
      // The three were assembled by hand here once, and `max_upload_bytes`
      // was simply left out — a client had no way to learn the number it
      // would be held to.
      assert(Object.keys(limits).length === 3,
        `limits carries ${Object.keys(limits).join(", ")}`);
    },

    "a frame over the ceiling is refused, and the connection survives":
      async ({ client }) => {
        const { limits } = await client.call("nest.hello");
        // Just over. Building the whole ceiling plus one is 16 MB of string
        // for a check that triggers at exactly the same place.
        const message = "x".repeat(limits.max_frame_bytes + 1024);
        const e = await client.refused("nest.send",
          { session_id: "no-such-session", message });
        assert(e, "a frame over the ceiling was accepted");
        assert(String(e.message).includes(String(limits.max_frame_bytes)),
          `the refusal does not name the ceiling: "${e.message}"`);

        // Still usable. Dropping the connection would leave the client
        // guessing which frame did it, and reconnecting to find out.
        const hello = await client.call("nest.hello");
        assert(hello.protocol_version, "the connection did not survive the refusal");
      },

    "a frame just under the ceiling goes through": async ({ client }) => {
      // The other half of a limit: it has to let the legal case past. A
      // ceiling enforced one byte low is indistinguishable from one enforced
      // correctly until somebody sends the largest legal thing.
      //
      // Aimed at a session that does not exist, deliberately. What is under
      // test is that the frame *arrives* — and "session not found" is proof
      // it reached dispatch, without spending a turn to find out.
      const { limits } = await client.call("nest.hello");
      const message = "x".repeat(Math.floor(limits.max_frame_bytes * 0.9));
      const e = await client.refused("nest.send",
        { session_id: "no-such-session", message });
      assert(e, "a legal frame was answered as if the session existed");
      assert(!String(e.message).includes("ceiling"),
        `a legal frame was refused for its size: "${e.message}"`);
      assert(/not found|no such/i.test(e.message), `answered "${e.message}"`);
    },

    "an upload is held to the ceiling its own grant was issued under":
      async ({ backend, client }) => {
        const { limits } = await client.call("nest.hello");
        const grant = await client.call("nest.upload.begin",
          { name: "big.bin", bytes: 1 });
        assert(grant.max_bytes === limits.max_upload_bytes,
          `the grant says ${grant.max_bytes}, hello says ${limits.max_upload_bytes}`);

        const over = await fetch(`http://127.0.0.1:${backend.port}${grant.url}`, {
          method: "POST",
          body: Buffer.alloc(grant.max_bytes + 1024),
        });
        assert(over.status === 413, `an oversized upload answered ${over.status}`);
        const said = await over.text();
        // Nest's own sentence, naming the number. The framework's default
        // said "failed to buffer the request body", which tells a caller
        // neither what the limit is nor that there is a bulk channel at all.
        assert(said.includes(String(grant.max_bytes)),
          `the refusal does not name the ceiling: "${said}"`);
      },

    "a package may be larger than a file, because its grant says so":
      async ({ backend, client }) => {
        // The two things that use this channel have different ceilings, and
        // the ceiling travels with the grant rather than being one number for
        // the route. A package upload at a size a file upload would refuse is
        // the case that proves it.
        const file = await client.call("nest.upload.begin", { name: "f.bin", bytes: 1 });
        const pkg = await client.call("nest.plugins.upload", { name: "p.zip" });
        assert(pkg.max_bytes > file.max_bytes,
          `package ceiling ${pkg.max_bytes} is not above the file ceiling ${file.max_bytes}`);

        const body = Buffer.alloc(file.max_bytes + 4 * 1024 * 1024);
        const accepted = await fetch(`http://127.0.0.1:${backend.port}${pkg.url}`,
          { method: "POST", body });
        assert(accepted.ok,
          `a package inside its own ceiling was refused: ${accepted.status} ${await accepted.text()}`);
      },

    "asking for a grant above the ceiling is refused before one exists":
      async ({ client }) => {
        const { limits } = await client.call("nest.hello");
        const e = await client.refused("nest.upload.begin",
          { name: "huge.bin", bytes: limits.max_upload_bytes + 1 });
        assert(e && e.code === INVALID_PARAMS, `code ${e?.code}`);
        assert(e.message.includes(String(limits.max_upload_bytes)),
          `does not name the ceiling: "${e.message}"`);
      },

    "more requests in flight than the cap are answered, not dropped":
      async ({ client }) => {
        // The transport holds a semaphore of 16. What a client must never see
        // is a request that disappears: over the cap the extra ones wait, and
        // every one of them comes back.
        const n = 40;
        const answers = await Promise.all(
          Array.from({ length: n }, () => client.call("daemon.ping")));
        assert(answers.length === n, `${answers.length} of ${n} came back`);
        for (const a of answers) assert(a.pong === true, `an answer was ${JSON.stringify(a)}`);
      },

    "the replay buffer is bounded and says when it truncated":
      async ({ client }) => {
        // Not filled here — 20 000 frames is a live turn nobody wants in a
        // suite. What is checked is that the field a client branches on
        // exists and is a boolean on a fresh attach, because the interface
        // shows a banner off it and a missing field reads as "not truncated".
        const created = await client.call("session.create", {});
        const attached = await client.call("nest.attach", { session_id: created.session_id });
        assert(typeof attached.truncated === "boolean",
          `truncated is ${JSON.stringify(attached.truncated)}`);
        assert(attached.truncated === false, "a fresh session reports a truncated buffer");
        assert(Array.isArray(attached.replay), "replay is not an array");
        await finish(client, created.session_id);
      },
  },
};
