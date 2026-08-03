//! How a request body is authored, and what goes on the wire.
//!
//! A body used to be one thing: a string, sent verbatim, with `Content-Type:
//! application/json` if the author had not said otherwise. Form endpoints need key/value
//! parts instead, and hand-writing `a=1&b=2` is not the same as sending it — a value
//! containing `&`, `=` or a space corrupts the body silently, which is the worst kind of
//! test failure because the request looks right in the editor.
//!
//! **`payload` stays the single column, and `body_type` says how to read it.** For a form
//! type it holds a JSON array of fields. That is deliberate rather than a second column:
//! `DataRow.body` already overrides `payload` wholesale, so a row can replace a form body
//! with no new dataset concept and no second override path.
//!
//! Interpolation is untouched. The payload string is interpolated exactly as before and
//! only *then* parsed into fields, so `{{names}}` inside field values keep working — along
//! with `find_unresolved`, `placeholder_values`, `provenance` and the teardown guards,
//! none of which had to learn anything.

use serde::{Deserialize, Serialize};

/// How to read `payload` and what to send.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BodyType {
    /// The payload is the body, sent verbatim. The original behaviour, and the default for
    /// every test case written before this existed.
    #[default]
    Json,
    /// The payload is a JSON array of fields, sent as `application/x-www-form-urlencoded`.
    Urlencoded,
    /// The same fields, sent as `multipart/form-data`.
    Multipart,
}

impl BodyType {
    pub fn as_str(&self) -> &'static str {
        match self {
            BodyType::Json => "json",
            BodyType::Urlencoded => "urlencoded",
            BodyType::Multipart => "multipart",
        }
    }

    /// Unrecognised text reads as `Json` — the verbatim behaviour. A body type nobody
    /// knows must not stop a request being sent at all.
    pub fn parse(value: &str) -> Self {
        match value {
            "urlencoded" => BodyType::Urlencoded,
            "multipart" => BodyType::Multipart,
            _ => BodyType::Json,
        }
    }

    pub fn is_form(&self) -> bool {
        matches!(self, BodyType::Urlencoded | BodyType::Multipart)
    }

    /// The header this type implies, unless the author set one.
    pub fn content_type(&self) -> Option<&'static str> {
        match self {
            BodyType::Json => Some("application/json"),
            BodyType::Urlencoded => Some("application/x-www-form-urlencoded"),
            // Deliberately none: the boundary is part of the value and only the HTTP
            // client knows it. Setting it here would send a header with no boundary and
            // every server would reject the body.
            BodyType::Multipart => None,
        }
    }
}

/// One key/value part of a form body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FormField {
    pub name: String,
    #[serde(default)]
    pub value: String,
    /// Unticked fields are not sent. Stored as the exception, like `DataRow.disabled`, so
    /// an ordinary field says nothing.
    #[serde(default, skip_serializing_if = "is_not_set")]
    pub disabled: bool,
    /// Present ⇒ send as a file part rather than a plain value.
    ///
    /// There is no separate "is a file" flag, because in multipart there is no separate
    /// mode: a part carrying a filename *is* a file part. The distinction matters to the
    /// server — `/api/v1/numbers/upload` answers "Only XLSX, XLS or CSV files are allowed"
    /// by reading the extension off this and nothing else.
    ///
    /// Absence as the discriminator is the habit `rowIds` and `needs_flow` already follow.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    /// Defaults from the filename's extension when unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
}

fn is_not_set(flag: &bool) -> bool {
    !*flag
}

impl FormField {
    /// A file part carries a filename. Anything else is a plain value.
    pub fn is_file(&self) -> bool {
        self.filename.as_ref().is_some_and(|f| !f.trim().is_empty())
    }

    /// What to declare for this part: the author's choice, else the extension's, else a
    /// safe fallback.
    pub fn mime(&self) -> String {
        if let Some(declared) = self.content_type.as_ref().filter(|c| !c.trim().is_empty()) {
            return declared.clone();
        }
        mime_for(self.filename.as_deref().unwrap_or(""))
    }
}

/// Content type implied by a filename's extension.
///
/// Only the handful a test fixture actually is. Anything else falls back to
/// `application/octet-stream`, which is what an unknown body is.
pub fn mime_for(filename: &str) -> String {
    let ext = filename
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "csv" => "text/csv",
        "json" => "application/json",
        "xml" => "application/xml",
        "txt" => "text/plain",
        "html" | "htm" => "text/html",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xls" => "application/vnd.ms-excel",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// The fields a form body will send, in order.
///
/// A payload that will not parse yields none rather than failing the request: the run log
/// says the body was unreadable, which is more useful than an error with no request in it.
/// A field with a blank name is dropped — it cannot be addressed by any server.
pub fn parse_fields(payload: &str) -> Vec<FormField> {
    serde_json::from_str::<Vec<FormField>>(payload)
        .unwrap_or_default()
        .into_iter()
        .filter(|f| !f.disabled && !f.name.trim().is_empty())
        .collect()
}

/// Did this payload look like a field list at all?
///
/// Told apart from "parsed to nothing" so the run log can say *why* a form body sent
/// nothing — an unparseable payload and an empty one are different mistakes.
pub fn looks_like_fields(payload: &str) -> bool {
    serde_json::from_str::<Vec<FormField>>(payload).is_ok()
}

/// What to record in the request log for a form body.
///
/// The values as authored, not percent-encoded: the log is read by a person deciding
/// whether the right thing was sent, and `%7B%7Btoken%7D%7D` answers that question worse
/// than `{{token}}` does. The content-type header beside it says how it was encoded.
pub fn describe(fields: &[FormField]) -> String {
    fields
        .iter()
        .map(|f| {
            if f.is_file() {
                // A file part's own metadata, because that is what the server checks. The
                // content follows so the log still shows what was actually uploaded.
                format!(
                    "{} (file: {}, {})\n{}",
                    f.name,
                    f.filename.as_deref().unwrap_or(""),
                    f.mime(),
                    f.value
                )
            } else {
                format!("{}={}", f.name, f.value)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAYLOAD: &str = r#"[
        {"name":"token","value":"{{authToken}}"},
        {"name":"userId","value":"42"},
        {"name":"note","value":"a & b = c"}
    ]"#;

    #[test]
    fn a_field_list_parses_in_order() {
        let fields = parse_fields(PAYLOAD);
        assert_eq!(fields.len(), 3);
        assert_eq!(fields[0].name, "token");
        // Interpolation has already run by the time this is parsed, so a leftover
        // placeholder here means the value never resolved — not that this code mishandled it.
        assert_eq!(fields[0].value, "{{authToken}}");
        // A value carrying the very characters that break a hand-written body survives.
        assert_eq!(fields[2].value, "a & b = c");
    }

    #[test]
    fn a_disabled_field_is_not_sent() {
        let fields = parse_fields(
            r#"[{"name":"a","value":"1"},{"name":"b","value":"2","disabled":true}]"#,
        );
        assert_eq!(fields.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["a"]);
    }

    #[test]
    fn a_field_stores_nothing_for_the_ordinary_case() {
        // Mirrors DataRow's flags: an ordinary field says nothing, so a saved payload does
        // not churn and one written before `disabled` existed reads back unchanged.
        let json = serde_json::to_string(&FormField {
            name: "a".into(),
            value: "1".into(),
            disabled: false,
            filename: None,
            content_type: None,
        })
        .unwrap();
        assert_eq!(json, r#"{"name":"a","value":"1"}"#);
    }

    #[test]
    fn a_nameless_field_is_dropped() {
        // No server can address it, and sending `=value` is a body nobody asked for.
        let fields = parse_fields(r#"[{"name":"  ","value":"1"},{"name":"ok","value":"2"}]"#);
        assert_eq!(fields.len(), 1);
        assert_eq!(fields[0].name, "ok");
    }

    #[test]
    fn an_unparseable_payload_sends_nothing_rather_than_failing() {
        // A run log saying the body was unreadable beats an error with no request in it.
        assert!(parse_fields("not json at all").is_empty());
        assert!(parse_fields(r#"{"not":"an array"}"#).is_empty());
        // …and the two mistakes are told apart, so the log can name the right one.
        assert!(!looks_like_fields("not json at all"));
        assert!(looks_like_fields("[]"));
    }

    #[test]
    fn multipart_declares_no_content_type_of_its_own() {
        // The boundary is part of the value and only the HTTP client knows it. A header set
        // here would carry no boundary and every server would reject the body.
        assert_eq!(BodyType::Multipart.content_type(), None);
        assert_eq!(
            BodyType::Urlencoded.content_type(),
            Some("application/x-www-form-urlencoded")
        );
        assert_eq!(BodyType::Json.content_type(), Some("application/json"));
    }

    #[test]
    fn an_unknown_body_type_reads_as_verbatim() {
        // A type nobody knows must not stop the request being sent.
        assert_eq!(BodyType::parse("urlencoded"), BodyType::Urlencoded);
        assert_eq!(BodyType::parse("multipart"), BodyType::Multipart);
        assert_eq!(BodyType::parse("json"), BodyType::Json);
        assert_eq!(BodyType::parse("graphql"), BodyType::Json);
        assert_eq!(BodyType::parse(""), BodyType::Json);
        // …and the default is the behaviour every existing test case already has.
        assert_eq!(BodyType::default(), BodyType::Json);
    }

    #[test]
    fn the_log_shows_the_values_as_authored() {
        // The log is read by a person deciding whether the right thing was sent, and
        // percent-encoding answers that worse than the plain text does.
        let described = describe(&parse_fields(PAYLOAD));
        assert_eq!(described, "token={{authToken}}\nuserId=42\nnote=a & b = c");
    }

    #[test]
    fn a_filename_is_what_makes_a_part_a_file() {
        // There is no separate "is a file" flag, because multipart has no separate mode.
        // The server reads the extension off this and nothing else — which is how
        // /api/v1/numbers/upload answers "Only XLSX, XLS or CSV files are allowed".
        let fields = parse_fields(
            r#"[{"name":"file","value":"msisdn","filename":"numbers.csv"}]"#,
        );
        assert!(fields[0].is_file());
        assert_eq!(fields[0].mime(), "text/csv");

        // A blank filename is not a filename.
        let blank = parse_fields(r#"[{"name":"a","value":"1","filename":"   "}]"#);
        assert!(!blank[0].is_file());
    }

    #[test]
    fn the_content_type_comes_from_the_extension_unless_stated() {
        assert_eq!(mime_for("numbers.csv"), "text/csv");
        assert_eq!(mime_for("payload.JSON"), "application/json");
        // Unknown, and no extension at all, are both "some bytes".
        assert_eq!(mime_for("thing.bin"), "application/octet-stream");
        assert_eq!(mime_for("README"), "application/octet-stream");

        // An author who states one wins over the extension.
        let stated = parse_fields(
            r#"[{"name":"f","value":"x","filename":"a.csv","content_type":"text/plain"}]"#,
        );
        assert_eq!(stated[0].mime(), "text/plain");
    }

    #[test]
    fn several_fields_may_share_one_name() {
        // A multipart array of files *is* repeated parts sharing a name, which is what
        // `recipientFiles: {type: array, items: {format: binary}}` means on the wire. So
        // nothing here may dedupe by name.
        let fields = parse_fields(
            r#"[{"name":"recipientFiles","value":"a","filename":"a.csv"},
                {"name":"recipientFiles","value":"b","filename":"b.csv"}]"#,
        );
        assert_eq!(fields.len(), 2);
        assert!(fields.iter().all(|f| f.name == "recipientFiles"));
        assert_eq!(fields[1].filename.as_deref(), Some("b.csv"));
    }

    #[test]
    fn the_log_names_a_file_part_and_still_shows_its_content() {
        // The metadata is what the server checks, the content is what was uploaded. A log
        // with only one of the two cannot answer "did the right thing go out".
        let described = describe(&parse_fields(
            r#"[{"name":"file","value":"447700900123","filename":"numbers.csv"},
                {"name":"sourceType","value":"0"}]"#,
        ));
        assert!(described.contains("file (file: numbers.csv, text/csv)"), "{described}");
        assert!(described.contains("447700900123"));
        assert!(described.contains("sourceType=0"));
    }

    #[test]
    fn a_field_with_no_file_stores_nothing_for_it() {
        // Same rule as `disabled`: an ordinary field says nothing, so payloads written
        // before file parts existed read back unchanged and a saved one does not churn.
        let json = serde_json::to_string(&parse_fields(r#"[{"name":"a","value":"1"}]"#)).unwrap();
        assert_eq!(json, r#"[{"name":"a","value":"1"}]"#);
    }
}
