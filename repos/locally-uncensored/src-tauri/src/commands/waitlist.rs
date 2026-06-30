//! Cloud "Hosted LU Workflows" waitlist — opt-in email capture.
//!
//! The desktop app posts a single, user-typed email straight to LU's own
//! Supabase project (EU region). This is the ONE thing LU sends off-device,
//! and ONLY when the user explicitly clicks "Notify me" — no telemetry, no
//! tracking, no ping on launch. See the in-app microcopy in CloudWaitlistBadge.
//!
//! Direct-to-Supabase with an INSERT-ONLY RLS policy: the anon key below is
//! public-safe by design — under the policy it can only INSERT into the
//! `waitlist` table, never read it. So shipping it in the client is fine.
//!
//! `Prefer: return=minimal` is REQUIRED: without it PostgREST tries to SELECT
//! the freshly-inserted row back to return it, which the insert-only policy
//! blocks → the whole request would 401/403. We do a PLAIN insert (NOT an
//! on-conflict upsert: PostgREST's upsert path needs more than the insert
//! policy and 401s under insert-only RLS — verified live). A repeat email
//! therefore returns 409, which we treat as success so "You're already on
//! the list" stays clean.

/// LU's own Supabase project (EU region). The project URL is public — it is
/// the `NEXT_PUBLIC_SUPABASE_URL` and ships in every Supabase client.
const SUPABASE_URL: &str = "https://gewbdlmziumhseftxgrr.supabase.co";

/// Public-safe anon ("publishable") key.
/// Source: Supabase Dashboard → Project Settings → API → Project API keys →
/// `anon` `public` (same value as `NEXT_PUBLIC_SUPABASE_ANON_KEY` in
/// `apps/web/.env.local`). Safe to embed — RLS is insert-only.
///
/// This is the anon key (JWT `role:anon`) — NOT the service-role key. It can
/// only INSERT into `waitlist` under the insert-only RLS policy, never read.
const SUPABASE_ANON_KEY: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdld2JkbG16aXVtaHNlZnR4Z3JyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxNDk2MzQsImV4cCI6MjA4ODcyNTYzNH0.aywRbeeJNQezl56i_39dA0EpdsN6Y4AI9EkobSmJQ3A";

/// Minimal, defense-in-depth email check (the UI validates too — this just
/// stops obviously-bogus values from hitting the network).
fn looks_like_email(email: &str) -> bool {
    if email.len() < 3 || email.len() > 254 || email.contains(char::is_whitespace) {
        return false;
    }
    let at = match email.find('@') {
        Some(i) => i,
        None => return false,
    };
    // Exactly one '@', non-empty local part, and a dotted domain.
    if email.matches('@').count() != 1 || at == 0 {
        return false;
    }
    let domain = &email[at + 1..];
    domain.len() >= 3
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
}

/// Submit one opt-in email to the hosted-workflows waitlist.
///
/// Parameters are deliberately SINGLE WORDS (`email`, `source`, `version`) so
/// there is zero camelCase↔snake_case ambiguity across the Tauri IPC boundary
/// (a real footgun — cf. the STT `audioBase64` bug). The Supabase column is
/// `app_version`; we map `version` → that column when building the JSON body.
#[tauri::command]
pub async fn waitlist_submit(
    email: String,
    source: Option<String>,
    version: Option<String>,
) -> Result<(), String> {
    let email = email.trim().to_lowercase();
    if !looks_like_email(&email) {
        return Err("Please enter a valid email address.".into());
    }

    let url = format!("{}/rest/v1/waitlist", SUPABASE_URL);
    let payload = serde_json::json!({
        "email": email,
        "source": source.unwrap_or_else(|| "app-badge".to_string()),
        "app_version": version,
    });

    let client = reqwest::Client::builder()
        .user_agent("LocallyUncensored/2.0")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post(&url)
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {}", SUPABASE_ANON_KEY))
        .header("Content-Type", "application/json")
        // return=minimal is mandatory under insert-only RLS (no SELECT-back).
        // PLAIN insert (not an on-conflict upsert — PostgREST's upsert path 401s
        // under insert-only RLS); a repeat email returns 409, handled as success.
        .header("Prefer", "return=minimal")
        .body(payload.to_string())
        .send()
        .await
        .map_err(|e| format!("waitlist_submit: {}", e))?;

    let status = resp.status();
    // 2xx = inserted (or duplicate ignored). 409 = duplicate without the
    // ignore-duplicates path — still "you're on the list", so treat as success.
    if status.is_success() || status.as_u16() == 409 {
        Ok(())
    } else {
        let code = status.as_u16();
        let text = resp.text().await.unwrap_or_default();
        Err(format!("Waitlist signup failed (HTTP {}): {}", code, text))
    }
}

#[cfg(test)]
mod tests {
    use super::looks_like_email;

    #[test]
    fn accepts_normal_addresses() {
        assert!(looks_like_email("david@example.com"));
        assert!(looks_like_email("a.b+tag@sub.domain.co"));
    }

    #[test]
    fn rejects_bogus() {
        assert!(!looks_like_email(""));
        assert!(!looks_like_email("noatsign"));
        assert!(!looks_like_email("@nolocal.com"));
        assert!(!looks_like_email("no@domain"));
        assert!(!looks_like_email("two@@at.com"));
        assert!(!looks_like_email("has space@x.com"));
        assert!(!looks_like_email("trailing@dot."));
    }
}
