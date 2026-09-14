use crate::policy::{Notify, Policy};
use std::time::Duration;

/// Fire a webhook notification for a decision, if the policy asks for one.
///
/// Doctrine (same as previews): this layer must NEVER delay or break
/// enforcement. Hard 3-second timeout, every error swallowed. Slack being
/// down cannot make Termaxa hang or fail a decision that was already made.
pub fn maybe_send(policy: &Policy, decision: &str, command: &str, reason: &str, source: &str) {
    let Some(cfg) = &policy.notify else { return };
    if !cfg.on.iter().any(|d| d.eq_ignore_ascii_case(decision)) {
        return;
    }
    send(cfg, decision, command, reason, source);
}

fn send(cfg: &Notify, decision: &str, command: &str, reason: &str, source: &str) {
    let emoji = match decision {
        "deny" => "🛑",
        "ask" => "⚠️",
        _ => "✅",
    };
    let cwd = std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let text = format!(
        "{} *termaxa {}* [{}]\n`{}`\n{}\n_{}_",
        emoji,
        decision.to_uppercase(),
        source,
        command,
        reason,
        cwd
    );
    let body = serde_json::json!({ "text": text }).to_string();

    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(3))
        .build();
    // Fire and forget: success or failure, the decision already stands.
    let _ = agent
        .post(&cfg.webhook)
        .set("Content-Type", "application/json")
        .send_string(&body);
