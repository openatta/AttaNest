//! Topology two: unary and out-of-band over ordinary HTTP, each subscription
//! face on its own download-only stream.
//!
//! For a deployment behind a reverse proxy. A WebSocket is opaque to
//! everything a proxy is good at — per-request rate limiting, caching, access
//! logs, an authenticating front door — because after the upgrade the proxy
//! sees one long connection and nothing about what travels inside it. Putting
//! unary back on plain HTTP buys all of that with no code.
//!
//! It also lets the two faces disconnect independently, and lets a read-only
//! client open only the stream it wants: watching the sidebar should not mean
//! receiving every session's body.
//!
//! ```text
//!   POST /handshake            once — version, topology, and a credential
//!   POST /rpc                  unary
//!   POST /respond              out-of-band answers
//!   GET  /events/session       server → client
//!   GET  /events/host          server → client
//!   POST /upload               bulk, and identical in every topology
//! ```
//!
//! **The methods, params, error codes and event shapes are the same as the
//! other topology's.** Switching topology is not switching protocol; that is
//! the whole claim, and `tests/topology-parity.mjs` is what checks it.

use std::convert::Infallible;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures::Stream;
use nest_contract::{codes, RpcError, Subject, Topology};
use serde_json::{json, Value};
use tokio_stream::wrappers::UnboundedReceiverStream;
use tokio_stream::StreamExt;

use crate::{handshake, AppState};

#[derive(serde::Deserialize)]
pub struct Credential {
    /// Also accepted as the `Authorization: Bearer …` header; a query
    /// parameter is what an `EventSource` can send, because that API cannot
    /// set headers.
    token: Option<String>,
}

fn credential_of(headers: &HeaderMap, query: &Credential) -> Option<String> {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_string)
        .or_else(|| query.token.clone())
}

/// One handshake, before any channel is opened.
pub async fn establish(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !crate::origin_allowed(&headers) {
        return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
    }
    let device = match crate::admission::admit(
        state.config.admission,
        &state.config.token,
        &state.devices,
        &state.challenges,
        &body,
    )
    .await
    {
        crate::admission::Verdict::Admit { device } => device,
        crate::admission::Verdict::Refuse(reason) => {
            return (StatusCode::UNAUTHORIZED, reason).into_response()
        }
    };
    let subject = Subject::Device {
        id: device.unwrap_or_else(|| "local".into()),
    };
    let negotiated = match handshake::negotiate(&body, &state.config.topologies, subject) {
        Ok(negotiated) => negotiated,
        Err(e) => return rpc_error(e).into_response(),
    };
    if negotiated.topology != Topology::SplitStreams {
        return rpc_error(RpcError::new(
            codes::HANDSHAKE_REFUSED,
            "this endpoint establishes the split-streams topology; \
             the single-duplex one is established on its own connection",
        ))
        .into_response();
    }
    // Neither face is subscribed yet: in this topology a client opts into
    // each stream by opening it, which is what makes a read-only client
    // possible at all.
    let (credential, established, _) = state
        .sessions
        .establish(&state.hub, negotiated.subject.clone(), negotiated.topology, None)
        .await;
    let mut answer = handshake::accepted(&negotiated, &state.config.topologies);
    answer["credential"] = json!(credential);
    answer["client"] = json!(established.client.0);
    Json(answer).into_response()
}

/// One request, one reply.
pub async fn rpc(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<Credential>,
    Json(mut body): Json<Value>,
) -> Response {
    let Some(credential) = credential_of(&headers, &query) else {
        return rpc_error(RpcError::new(codes::HANDSHAKE_REFUSED, "no credential")).into_response();
    };
    let Some(established) = state.sessions.get(&credential).await else {
        return rpc_error(RpcError::new(
            codes::HANDSHAKE_REFUSED,
            "unknown credential; call /handshake first",
        ))
        .into_response();
    };
    let Some(method) = body.get("method").and_then(Value::as_str).map(str::to_string) else {
        return rpc_error(RpcError::new(codes::INVALID_REQUEST, "missing method")).into_response();
    };
    let id = body.get("id").cloned().unwrap_or(Value::Null);
    let mut params = body
        .get_mut("params")
        .map(Value::take)
        .unwrap_or_else(|| json!({}));

    // Which client this is, from the **credential** — not from this
    // connection. `nest.attach` arrives here while the frames it registers a
    // watcher for go out on a different socket entirely, so connection
    // identity would be the wrong answer, and quietly (§3.3.3, item 2).
    if let Some(obj) = params.as_object_mut() {
        obj.insert("__client".into(), json!(established.client.0));
    }

    match state.gate.call(&established.subject, &method, params).await {
        Ok(result) => Json(json!({"jsonrpc": "2.0", "id": id, "result": result})).into_response(),
        Err(e) => Json(json!({
            "jsonrpc": "2.0", "id": id,
            "error": {"code": e.code, "message": e.message},
        }))
        .into_response(),
    }
}

/// Answering a question the server asked.
///
/// A separate endpoint because a download-only stream has no return path.
/// Treating it as its own semantic is what lets every topology implement it
/// honestly instead of one of them growing a patch (§3.3.1).
pub async fn respond(
    state: State<AppState>,
    headers: HeaderMap,
    query: Query<Credential>,
    body: Json<Value>,
) -> Response {
    rpc(state, headers, query, body).await
}

/// This client's session events.
pub async fn session_events(
    state: State<AppState>,
    query: Query<Credential>,
    headers: HeaderMap,
) -> Response {
    stream_for(state, headers, query, Face::Session).await
}

/// Everything not tied to a session.
pub async fn host_events(
    state: State<AppState>,
    query: Query<Credential>,
    headers: HeaderMap,
) -> Response {
    stream_for(state, headers, query, Face::Host).await
}

enum Face {
    Session,
    Host,
}

async fn stream_for(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<Credential>,
    face: Face,
) -> Response {
    let Some(credential) = credential_of(&headers, &query) else {
        return (StatusCode::UNAUTHORIZED, "no credential").into_response();
    };
    let Some(established) = state.sessions.get(&credential).await else {
        return (StatusCode::UNAUTHORIZED, "unknown credential").into_response();
    };
    // Opening the stream *is* the subscription: this is where a read-only
    // client says which face it wants.
    let is_session = matches!(face, Face::Session);
    state.sessions.subscribe(&credential, is_session).await;
    let slot = if is_session { &established.session_events } else { &established.host_events };

    // One reader per face. A second is refused rather than silently splitting
    // the frames between two readers, which would lose half of them to each.
    let Some(receiver) = slot.lock().await.take() else {
        return (StatusCode::CONFLICT, "this stream already has a reader").into_response();
    };
    let stream = UnboundedReceiverStream::new(receiver)
        .map(|payload| Ok::<Event, Infallible>(Event::default().data(payload)));
    sse(stream)
}

fn sse<S>(stream: S) -> Response
where
    S: Stream<Item = Result<Event, Infallible>> + Send + 'static,
{
    // A comment every 15s: an idle proxy that times out a quiet connection is
    // the ordinary way a download-only stream dies without either end
    // noticing.
    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

fn rpc_error(e: RpcError) -> Json<Value> {
    Json(json!({"jsonrpc": "2.0", "id": Value::Null, "error": {"code": e.code, "message": e.message}}))
}
