/** The two numbers the client and the backend have to agree on.
 *
 * Their own file, with no DOM in it, because everything that has to state
 * them imports them rather than copying them: the client library, the test
 * harnesses, and — through `crates/contract/tests/protocol_version.rs` —
 * the Rust constant itself. A version written down twice is a version that
 * eventually disagrees with itself, and the failure looks like a refused
 * handshake nobody changed.
 */

/** Bumped when a method, an event shape or an error code changes in a way a
 *  client can observe. See `nest_contract::PROTOCOL_VERSION`. */
export const PROTOCOL_VERSION = 4;

/** The contribution point API — separate, because a UI bundle can be current
 *  on one and stale on the other. */
export const CONTRIB_API_VERSION = 1;

/** The codes Nest itself returns, as distinct from the ones that come from
 *  the engine untouched.
 *
 * These sit outside JSON-RPC's reserved implementation band (`-32000` …
 * `-32099`), which is where AttaCore's live. That separation is what makes
 * "the host refused you" tellable from "the engine has no such session" —
 * the two were the same number once, and the API tests used that number as
 * their only way to tell the layers apart.
 *
 * Kept in step with `nest_contract::codes` by
 * `crates/contract/tests/protocol_version.rs`. */
export const REFUSED = -31000;
export const HANDSHAKE_REFUSED = -31001;

/** JSON-RPC's own. Both layers use them and that is correct — "your params
 *  are wrong" needs no attribution. */
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
