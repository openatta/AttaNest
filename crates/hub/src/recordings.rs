//! The request envelope, read back out of the engine's recording.
//!
//! What the model was sent, minus the messages: the assembled system blocks,
//! the whole tool catalog, and the call configuration. AttaCore does not send
//! this over the wire — it writes every call to a recording
//! (`core/docs/recorder_design.md`), and this crate reads that directory.
//!
//! Reading files rather than receiving frames is what makes the envelope
//! survive a reload: the browser can ask for it at any point, including for a
//! session whose turns ran in a previous process. The cost is the boundary in
//! §4 — a recording covers the current *run* of a session, because the writer
//! truncates when a resumed session makes its first call.
//!
//! Only turn calls are folded into the timeline. Compaction, memory extraction
//! and titling assemble their own envelopes, so including them would report a
//! change on every one and a change back afterwards, none of which describes
//! the conversation.

use std::path::PathBuf;

use base::interface::model::ToolDef;
use base::interface::prompt::PromptBlock;
use daemon::rpc::codes;
use serde_json::{json, Value};
use telemetry::recorder::blob::{BlobId, BlobStore};
use telemetry::recorder::format::{CallRecord, RecordedParams};
use telemetry::recorder::reader;

use crate::{require_session_id, Hub};

/// Asked for on `session.create` and on the `session.resume` behind an attach,
/// which is every way a session that can run a turn comes into being here.
///
/// No `dir`: the daemon resolves the root from settings, and `Engine`
/// resolves the same way for reading. Naming a path here would mean two
/// answers to one question.
pub(crate) fn record_option() -> Value {
    json!({"mode": "record"})
}

/// Merge the recorder option into a browser's `options`, keeping whatever
/// else it sent. A browser cannot ask for `replay` or for a different root:
/// this key is overwritten, not defaulted.
pub(crate) fn with_recording(mut params: Value) -> Value {
    let options = params
        .as_object_mut()
        .map(|obj| obj.entry("options").or_insert_with(|| json!({})));
    if let Some(Value::Object(options)) = options {
        options.insert("recorder".into(), record_option());
    }
    params
}

impl Hub {
    fn recording_dir(&self, session_id: &str) -> PathBuf {
        self.engine.recordings_root.join(session_id)
    }

    /// `nest.requestHeaders {session_id}` — the envelope timeline of this
    /// session's current run, oldest first, one entry per change.
    pub(crate) async fn request_headers(&self, params: Value) -> Result<Value, Value> {
        let session_id = require_session_id(&params)?;
        envelopes_in(&self.recording_dir(&session_id))
    }

    /// Drop a session's recording. Called when the session itself is deleted:
    /// the recorder keeps no retention policy of its own and says so — a
    /// recording is a self-contained directory for its owner to remove.
    pub(crate) fn forget_recording(&self, session_id: &str) {
        let dir = self.recording_dir(session_id);
        if let Err(e) = std::fs::remove_dir_all(&dir) {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(session = session_id, error = %e, "could not remove recording");
            }
        }
    }
}

/// Fold one recording directory into the changes of its envelope.
///
/// A session that has not called the model yet has no recording at all; that
/// reports as `recording: false` rather than as an error, because it is the
/// ordinary state of a session nobody has spoken to.
fn envelopes_in(dir: &std::path::Path) -> Result<Value, Value> {
    let recording = match reader::load(dir) {
        Ok(recording) => recording,
        Err(reader::ReadError::NotFound(_)) => {
            return Ok(json!({
                "recording": false, "headers": [], "calls": 0,
                "auxiliary": 0, "damaged": 0,
            }))
        }
        Err(e) => {
            return Err(json!({
                "code": codes::INTERNAL_ERROR,
                "message": format!("unreadable recording: {e}"),
            }))
        }
    };

    let blobs = BlobStore::new(dir);
    let mut headers: Vec<Value> = Vec::new();
    let mut previous: Option<Fingerprint> = None;
    let mut turn_calls = 0u64;
    let mut auxiliary = 0u64;

    for call in &recording.calls {
        let request = &call.request;
        if request.purpose.is_some() {
            auxiliary += 1;
            continue;
        }
        turn_calls += 1;
        let fingerprint = Fingerprint::of(request);
        if previous.as_ref() == Some(&fingerprint) {
            continue;
        }
        let reason = if previous.is_none() { "initial" } else { "changed" };
        previous = Some(fingerprint);
        headers.push(envelope(request, reason, &blobs));
    }

    Ok(json!({
        "recording": true,
        "headers": headers,
        "calls": turn_calls,
        "auxiliary": auxiliary,
        "damaged": recording.damaged,
    }))
}

/// What makes two calls carry the same envelope.
///
/// Blob ids, not contents: a blob id *is* a hash of the content, so equal ids
/// mean equal bytes and the comparison costs no reads. This is the same
/// identity replay uses to detect divergence.
#[derive(PartialEq)]
struct Fingerprint {
    params: RecordedParams,
    system: Vec<String>,
    tools: String,
}

impl Fingerprint {
    fn of(request: &CallRecord) -> Self {
        Self {
            params: request.params.clone(),
            system: request.system.iter().map(|id| id.0.clone()).collect(),
            tools: request.tools.0.clone(),
        }
    }
}

/// One envelope in the shape the browser renders.
///
/// `text` and `cache` rather than `content` and `cache_strategy`: the flow row
/// and the details pane read a block, not a `PromptBlock`, and `source` is the
/// field that lets them say *which* block — the skills inventory, the memory
/// recall, a named scene section — instead of numbering them.
fn envelope(request: &CallRecord, reason: &str, blobs: &BlobStore) -> Value {
    let system: Vec<Value> = request
        .system
        .iter()
        .map(|id| match read::<PromptBlock>(blobs, id) {
            Some(block) => json!({
                "role": block.role,
                "cache": block.cache_strategy,
                "source": block.source,
                "text": block.content,
            }),
            None => json!({"role": "system", "cache": null, "source": null, "text": missing(id)}),
        })
        .collect();
    let tools = read::<Vec<ToolDef>>(blobs, &request.tools).unwrap_or_default();

    json!({
        "reason": reason,
        "turn": request.turn,
        "step": request.step,
        "ts": request.ts,
        "provider": request.provider,
        "model": request.params.model,
        "max_tokens": request.params.max_tokens,
        "thinking_mode": request.params.thinking_mode,
        "system": system,
        "tools": tools,
    })
}

/// A blob a recording references but does not have.
///
/// Only reachable for a hand-edited or partially copied directory, and it
/// stands in for one block rather than failing the whole read — the rest of
/// the envelope still answers most of what a reader came for.
fn missing(id: &BlobId) -> String {
    format!("<missing blob {id}>")
}

fn read<T: serde::de::DeserializeOwned>(blobs: &BlobStore, id: &BlobId) -> Option<T> {
    match blobs.get::<T>(id) {
        Ok(value) => value,
        Err(e) => {
            tracing::warn!(blob = %id, error = %e, "unreadable recording blob");
            None
        }
    }
}

/// Written against real recordings produced by the recorder's own writer,
/// rather than against hand-written JSON: the format belongs to AttaCore, and
/// a fixture we typed ourselves would keep passing after Core changed it.
#[cfg(test)]
mod tests {
    use super::*;
    use base::interface::model::ToolDef;
    use base::interface::prompt::{BlockRole, CacheStrategy, PromptBlock};
    use base::interface::settings::ThinkingMode;
    use base::provider::ApiType;
    use telemetry::recorder::format::{Header, Record, RecordedParams};
    use telemetry::recorder::writer::RecordingWriter;

    fn block(content: &str, source: &str) -> PromptBlock {
        PromptBlock {
            role: BlockRole::System,
            content: content.to_string(),
            cache_strategy: Some(CacheStrategy::Ephemeral),
            source: Some(source.to_string()),
        }
    }

    fn tool(name: &str, source: &str) -> ToolDef {
        ToolDef {
            name: name.to_string(),
            description: format!("does {name}"),
            input_schema: json!({"type": "object"}),
            source: Some(source.to_string()),
        }
    }

    struct Fixture {
        root: tempfile::TempDir,
        writer: RecordingWriter,
    }

    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().expect("tempdir");
            let writer = RecordingWriter::create(
                root.path(),
                Header {
                    version: telemetry::recorder::format::FORMAT_VERSION,
                    name: "S-1".into(),
                    session_id: "S-1".into(),
                    parent: None,
                    agent_type: None,
                    created_at: 0,
                    engine_version: "test".into(),
                },
            );
            Self { root, writer }
        }

        fn dir(&self) -> PathBuf {
            self.root.path().join("S-1")
        }

        fn call(&self, turn: u32, model: &str, system: &[PromptBlock], tools: &[ToolDef], purpose: Option<&str>) {
            let blobs = self.writer.blobs();
            let record = CallRecord {
                seq: self.writer.next_seq(),
                ts: 0,
                session_id: Some("S-1".into()),
                parent_session_id: None,
                agent_type: None,
                turn,
                step: 0,
                purpose: purpose.map(str::to_string),
                provider: "anthropic".into(),
                api_type: ApiType::Anthropic,
                params: RecordedParams {
                    model: model.to_string(),
                    max_tokens: 8192,
                    thinking_mode: ThinkingMode::Off,
                    fallback_model: None,
                    cache_edits: vec![],
                },
                system: system.iter().map(|b| blobs.put(b).expect("blob")).collect(),
                tools: blobs.put(&tools.to_vec()).expect("blob"),
                messages: vec![],
                input_map: None,
            };
            self.writer
                .append(&Record::Call(Box::new(record)))
                .expect("append");
            self.writer.flush().expect("flush");
        }
    }

    #[test]
    fn a_session_that_never_called_the_model_is_not_an_error() {
        let root = tempfile::tempdir().expect("tempdir");
        let answer = envelopes_in(&root.path().join("S-never")).expect("ok");
        assert_eq!(answer["recording"], json!(false));
        assert_eq!(answer["headers"], json!([]));
    }

    #[test]
    fn identical_envelopes_fold_to_one() {
        let fixture = Fixture::new();
        let system = [block("you are a coding agent", "scene")];
        let tools = [tool("Bash", "builtin")];
        for turn in 1..=3 {
            fixture.call(turn, "claude-sonnet-5", &system, &tools, None);
        }

        let answer = envelopes_in(&fixture.dir()).expect("ok");
        assert_eq!(answer["calls"], json!(3));
        assert_eq!(answer["headers"].as_array().expect("headers").len(), 1);
        assert_eq!(answer["headers"][0]["reason"], json!("initial"));
    }

    #[test]
    fn a_changed_catalog_is_a_new_envelope_and_carries_its_sources() {
        let fixture = Fixture::new();
        let system = [block("you are a coding agent", "scene")];
        fixture.call(1, "claude-sonnet-5", &system, &[tool("Bash", "builtin")], None);
        fixture.call(
            2,
            "claude-sonnet-5",
            &system,
            &[tool("Bash", "builtin"), tool("Grep", "mcp:files")],
            None,
        );

        let answer = envelopes_in(&fixture.dir()).expect("ok");
        let headers = answer["headers"].as_array().expect("headers");
        assert_eq!(headers.len(), 2);
        assert_eq!(headers[1]["reason"], json!("changed"));
        // The blobs were hydrated, not just referenced: the pane renders text
        // and provenance, and neither survives as a blob id.
        assert_eq!(headers[1]["system"][0]["text"], json!("you are a coding agent"));
        assert_eq!(headers[1]["system"][0]["source"], json!("scene"));
        assert_eq!(headers[1]["system"][0]["cache"], json!("ephemeral"));
        assert_eq!(headers[1]["tools"][1]["source"], json!("mcp:files"));
    }

    /// Compaction and memory extraction assemble envelopes of their own. Left
    /// in, each one would report a change and then a change back, and a
    /// session that compacted twice would show four envelopes it never sent to
    /// the conversation.
    #[test]
    fn auxiliary_calls_are_counted_but_not_folded() {
        let fixture = Fixture::new();
        let system = [block("you are a coding agent", "scene")];
        let tools = [tool("Bash", "builtin")];
        fixture.call(1, "claude-sonnet-5", &system, &tools, None);
        fixture.call(0, "claude-haiku-4-5", &[block("summarize", "compact")], &[], Some("compact"));
        fixture.call(2, "claude-sonnet-5", &system, &tools, None);

        let answer = envelopes_in(&fixture.dir()).expect("ok");
        assert_eq!(answer["calls"], json!(2));
        assert_eq!(answer["auxiliary"], json!(1));
        assert_eq!(answer["headers"].as_array().expect("headers").len(), 1);
    }
}
