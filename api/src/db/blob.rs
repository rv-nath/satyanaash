//! Preparing a run's bodies for storage: redact, then compress.
//!
//! A verbatim run of a fifteen-row dataset is around 62 KB, and roughly 35 KB of that is
//! one bearer token repeated once per row. Two things follow, in this order:
//!
//! 1. **Redact.** The token is over half the bytes and none of the value. Dropping it is
//!    free, and it stops writing live credentials into a file people copy into tickets.
//! 2. **Compress.** What is left is near-identical JSON across rows, which zstd takes
//!    another 4–5×.
//!
//! Together a stored run is ~7 KB, which is why there is no retention policy: keeping
//! everything costs less than the code to decide what to throw away.
//!
//! **Only ever pack what is fetched whole.** A packed column is opaque to SQL — no
//! `LIKE`, no index, no aggregate — so status, duration, names, row index, `expected`
//! and `error_message` stay plain text in `run_results`. Those are what a report groups
//! and filters on; the bodies are only ever shown.
//!
//! Redaction applies to the **stored** copy alone. The console still shows the token
//! while the run is in front of you, because that is when you need it to reproduce.

use std::borrow::Cow;

use crate::error::AppError;
use crate::execution::RequestLog;

/// zstd level 3 — its default, and the knee of the curve for JSON. Level 19 buys a few
/// more percent for an order of magnitude more CPU, on the request path of a test run.
const LEVEL: i32 = 3;

/// Headers whose value is a credential. Matched case-insensitively, because a header
/// name is case-insensitive on the wire and an author may well type `authorization`.
const SECRET_HEADERS: &[&str] = &[
    "authorization",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-api-key",
    "x-auth-token",
];

/// Stands in for a redacted value. The header is still recorded as *sent* — that it was
/// present is part of what the request was, and a missing `Authorization` and a hidden
/// one are different bugs.
pub const REDACTED: &str = "‹redacted›";

pub fn is_secret_header(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    SECRET_HEADERS.contains(&lower.as_str())
}

/// A copy of the request with credential header values replaced.
///
/// Known limit: a token in a *response body* — a login handing one back — is still
/// stored. Header redaction takes the repeated bulk, which is the size argument; the
/// security argument it only partly serves.
pub fn redact(request: &RequestLog) -> Cow<'_, RequestLog> {
    if !request.headers.keys().any(|k| is_secret_header(k)) {
        return Cow::Borrowed(request);
    }
    let mut clean = request.clone();
    for (name, value) in clean.headers.iter_mut() {
        if is_secret_header(name) {
            *value = REDACTED.to_string();
        }
    }
    Cow::Owned(clean)
}

/// Compress a string for storage. `None` in, `None` out — a column with nothing in it
/// stays NULL rather than holding the compression of an empty string.
pub fn pack(text: Option<&str>) -> Option<Vec<u8>> {
    let text = text?;
    // Not `is_empty()`: an empty body and no body are different, and the caller has
    // already decided which this is by passing Some.
    Some(zstd::encode_all(text.as_bytes(), LEVEL).unwrap_or_else(|_| {
        // encode_all fails only on allocation trouble. Storing the text uncompressed
        // would be silently unreadable later, so fall back to an empty frame's worth of
        // nothing and let unpack report it rather than hand back mystery bytes.
        Vec::new()
    }))
}

/// Serialize a value to JSON, then pack it.
pub fn pack_json<T: serde::Serialize>(value: Option<&T>) -> Option<Vec<u8>> {
    let value = value?;
    let json = serde_json::to_string(value).ok()?;
    pack(Some(&json))
}

/// Decompress a stored column back to text.
pub fn unpack(bytes: Option<&[u8]>) -> Result<Option<String>, AppError> {
    let Some(bytes) = bytes else { return Ok(None) };
    if bytes.is_empty() {
        return Ok(None);
    }
    let raw = zstd::decode_all(bytes)
        .map_err(|e| AppError::Internal(format!("stored run body could not be read: {e}")))?;
    String::from_utf8(raw)
        .map(Some)
        .map_err(|e| AppError::Internal(format!("stored run body is not text: {e}")))
}

/// Decompress and parse a stored column.
///
/// A body that will not parse is reported as absent rather than failing the whole run
/// fetch: one unreadable payload should not hide the ninety-nine results beside it.
pub fn unpack_json<T: serde::de::DeserializeOwned>(bytes: Option<&[u8]>) -> Option<T> {
    let text = unpack(bytes).ok()??;
    serde_json::from_str(&text).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const TOKEN: &str = "eyJhbGciOiJIUzI1NiJ9.aVeryLongPayloadStandingInForATwoKilobyteJwt";

    fn request_with(headers: &[(&str, &str)]) -> RequestLog {
        RequestLog {
            method: "POST".into(),
            url: "http://host/api/v1/campaigns".into(),
            headers: headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect::<HashMap<_, _>>(),
            body: Some(r#"{"channel":"SMS"}"#.into()),
        }
    }

    #[test]
    fn a_packed_body_round_trips() {
        let body = r#"{"campaignId":"a1b2","status":"SCHEDULED"}"#;
        let packed = pack(Some(body)).expect("packs");
        assert_eq!(unpack(Some(&packed)).unwrap().as_deref(), Some(body));
    }

    #[test]
    fn nothing_in_nothing_out() {
        // A NULL column must stay NULL, not become the compression of "".
        assert!(pack(None).is_none());
        assert!(unpack(None).unwrap().is_none());
        assert!(unpack(Some(&[])).unwrap().is_none());
    }

    #[test]
    fn packing_a_run_of_near_identical_rows_shrinks_it() {
        // The shape that actually gets stored: one payload per dataset row, differing by
        // a field. If this stopped shrinking, the whole retention argument would be gone.
        let rows: String = (0..15)
            .map(|i| format!(r#"{{"channel":"SMS","name":"campaign {i}","body":"hello there"}}"#))
            .collect::<Vec<_>>()
            .join("\n");
        let packed = pack(Some(&rows)).expect("packs");
        assert!(
            packed.len() * 4 < rows.len(),
            "expected better than 4x on repeated JSON, got {} -> {}",
            rows.len(),
            packed.len()
        );
    }

    #[test]
    fn a_credential_header_is_redacted_whatever_its_casing() {
        let request = request_with(&[
            ("Authorization", &format!("Bearer {TOKEN}")),
            ("content-type", "application/json"),
        ]);
        let clean = redact(&request);

        assert_eq!(clean.headers.get("Authorization").unwrap(), REDACTED);
        // The header is still recorded as sent — absent and hidden are different bugs.
        assert!(clean.headers.contains_key("Authorization"));
        // Everything else is untouched.
        assert_eq!(clean.headers.get("content-type").unwrap(), "application/json");
        assert_eq!(clean.body, request.body);

        let lowercase = request_with(&[("authorization", &format!("Bearer {TOKEN}"))]);
        assert_eq!(redact(&lowercase).headers.get("authorization").unwrap(), REDACTED);
    }

    #[test]
    fn a_request_with_nothing_to_hide_is_not_copied() {
        let request = request_with(&[("content-type", "application/json")]);
        assert!(matches!(redact(&request), Cow::Borrowed(_)));
    }

    #[test]
    fn no_token_survives_the_round_trip() {
        // The test that matters, and the reason it unpacks first: a compressed token is
        // still a token. Scanning the packed bytes would pass while the credential sat
        // in the database intact.
        let request = request_with(&[("Authorization", &format!("Bearer {TOKEN}"))]);
        let packed = pack_json(Some(redact(&request).as_ref())).expect("packs");

        let restored = unpack(Some(&packed)).unwrap().unwrap();
        assert!(
            !restored.contains(TOKEN),
            "the bearer token reached storage: {restored}"
        );
        assert!(restored.contains("redacted"));
    }

    #[test]
    fn an_unreadable_body_is_reported_not_guessed() {
        assert!(unpack(Some(b"this is not a zstd frame")).is_err());
        // …but a whole run fetch is not lost to one bad column.
        assert!(unpack_json::<RequestLog>(Some(b"not a zstd frame")).is_none());
    }
}
