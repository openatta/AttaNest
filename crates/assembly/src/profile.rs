//! What this process is, said once, declaratively.
//!
//! A profile names the scenes, the providers, the interface bundle and the
//! transport topology. Assembly does what it says and nothing more, and
//! nothing can rewrite it while the process runs — whatever could rewrite
//! this would be deciding what this process is (§3.1, §10).
//!
//! Extensions are not named here. Scripts are configured in AttaCore's own
//! settings tiers and plugins are installed through AttaCore's own
//! installer; a second place to declare them would be a second truth.
//!
//! Changing shape is a configuration change, not a fork. That is the first of
//! the three levels of customization (§8) and the one that costs no code.

use std::path::PathBuf;

use nest_contract::Topology;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Profile {
    pub engine: EngineProfile,
    pub transport: TransportProfile,
    pub ui: UiProfile,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct EngineProfile {
    /// Default scene for `session.create`, and the scope its state lives under.
    pub scene: String,
    /// Scenes activated on top of the default.
    pub scenes: Vec<String>,
    pub model: String,
    pub max_tokens: u32,
    pub session_cap: usize,
    pub session_idle_timeout_secs: u64,
    pub permission_prompt_timeout_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct TransportProfile {
    /// Topologies this deployment serves. A client picks one at handshake;
    /// anything else is refused with a reason rather than downgraded.
    pub topologies: Vec<Topology>,
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct UiProfile {
    /// Where the built interface is. `None` serves no static face at all —
    /// the `--headless` shape, for a pure RPC node (§3.3.4, §5.1).
    pub dir: Option<PathBuf>,
}

impl Default for EngineProfile {
    fn default() -> Self {
        Self {
            scene: "coding".into(),
            scenes: Vec::new(),
            model: "claude-sonnet-4-6".into(),
            max_tokens: 2000,
            session_cap: 32,
            session_idle_timeout_secs: 3600,
            permission_prompt_timeout_secs: 300,
        }
    }
}

impl Default for TransportProfile {
    fn default() -> Self {
        Self {
            // One bidirectional connection, which is the edge default: out
            // there a connection costs more than middleware does (§7.2).
            // A deployment behind a proxy adds `split_streams` and gets the
            // proxy's middleware back.
            topologies: vec![Topology::SingleDuplex],
            host: "127.0.0.1".into(),
            port: 4080,
        }
    }
}

impl Profile {
    pub fn parse(text: &str) -> anyhow::Result<Self> {
        Ok(toml::from_str(text)?)
    }

    pub fn load(path: &std::path::Path) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| anyhow::anyhow!("profile {}: {e}", path.display()))?;
        Self::parse(&text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A misspelled key is an error, not a silently ignored line. A profile
    /// that quietly does not mean what it says is the failure mode this whole
    /// file exists to avoid.
    #[test]
    fn an_unknown_key_is_refused() {
        let err = Profile::parse("[engine]\nscenee = \"chat\"\n").unwrap_err();
        assert!(err.to_string().contains("scenee"), "{err}");
    }

    #[test]
    fn the_edge_default_is_one_connection() {
        assert_eq!(Profile::default().transport.topologies, vec![Topology::SingleDuplex]);
    }
}
