//! AWS Signature Version 4, enough of it for three requests.
//!
//! MinIO speaks S3 and nothing else, so a PUT has to be signed. `aws-sdk-s3` would pull some
//! forty crates to do it; this is the whole of what one PUT, one GET and one DELETE need,
//! against two small ones.
//!
//! Kept apart from `s3.rs` and free of any I/O so the signing can be tested as arithmetic —
//! which matters, because the failure mode is an opaque `403 SignatureDoesNotMatch` with no
//! indication of which of the four steps was wrong.
//!
//! The four steps, in order, are: a **canonical request**, a **string to sign** over its
//! hash, a **signing key** derived from the secret through four HMACs, and the **signature**.

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

/// Everything the signature covers.
pub struct Request<'a> {
    pub method: &'a str,
    /// Already URI-encoded, starting with `/` — e.g. `/sat-fixtures/fixtures/nums100.csv`.
    pub canonical_uri: &'a str,
    /// Already sorted and encoded, or empty — e.g. `list-type=2&prefix=fixtures%2F`.
    pub canonical_query: &'a str,
    /// Name and value pairs. Case and order are fixed up here, not by the caller.
    pub headers: Vec<(String, String)>,
    /// Hex SHA-256 of the body. `sha256_hex(b"")` for a request with none.
    pub payload_sha256: &'a str,
}

pub struct Credentials<'a> {
    pub access_key: &'a str,
    pub secret_key: &'a str,
    pub region: &'a str,
    pub service: &'a str,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC takes a key of any length");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

/// Percent-encode for a path segment, by S3's rules.
///
/// Unreserved characters stay; **everything else is encoded, and `/` is not**, because the
/// caller passes whole paths. S3 is stricter than a generic URI encoder — `*`, `(`, `)` and
/// friends must be encoded or the signature covers a different string than the one on the
/// wire, which is exactly how this fails invisibly.
pub fn uri_encode_path(path: &str) -> String {
    path.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Percent-encode a query-string name or value. Same rules, but `/` is encoded too.
pub fn uri_encode_query(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// `name=value` pairs sorted by name, then by value — the canonical query string.
pub fn canonical_query(pairs: &[(&str, &str)]) -> String {
    let mut encoded: Vec<(String, String)> = pairs
        .iter()
        .map(|(k, v)| (uri_encode_query(k), uri_encode_query(v)))
        .collect();
    encoded.sort();
    encoded.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&")
}

/// Step 1: the canonical request, and the headers it signed.
///
/// Header names are lower-cased and sorted, values trimmed. Returned alongside the
/// `SignedHeaders` list because the `Authorization` header has to repeat it exactly — deriving
/// it twice is how the two drift apart.
pub fn canonical_request(req: &Request) -> (String, String) {
    let mut headers: Vec<(String, String)> = req
        .headers
        .iter()
        .map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    headers.sort();

    let canonical_headers: String =
        headers.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
    let signed_headers =
        headers.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(";");

    let canonical = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        req.method,
        req.canonical_uri,
        req.canonical_query,
        canonical_headers,
        signed_headers,
        req.payload_sha256
    );
    (canonical, signed_headers)
}

/// Step 2: what actually gets signed.
///
/// `timestamp` is `YYYYMMDDTHHMMSSZ` and must be the same value as the `x-amz-date` header —
/// the scope's date is its first eight characters, so they cannot disagree.
pub fn string_to_sign(timestamp: &str, scope: &str, canonical_request: &str) -> String {
    format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        timestamp,
        scope,
        sha256_hex(canonical_request.as_bytes())
    )
}

/// `20130524/us-east-1/s3/aws4_request`
pub fn scope(date: &str, region: &str, service: &str) -> String {
    format!("{date}/{region}/{service}/aws4_request")
}

/// Step 3: the signing key — four chained HMACs, each keyed by the last.
pub fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> Vec<u8> {
    let k_date = hmac(format!("AWS4{secret}").as_bytes(), date);
    let k_region = hmac(&k_date, region);
    let k_service = hmac(&k_region, service);
    hmac(&k_service, "aws4_request")
}

/// Step 4: the signature.
pub fn signature(secret: &str, date: &str, region: &str, service: &str, to_sign: &str) -> String {
    hex(&hmac(&signing_key(secret, date, region, service), to_sign))
}

/// The finished `Authorization` header value, and the `SignedHeaders` that go with it.
pub fn authorization(creds: &Credentials, req: &Request, timestamp: &str) -> String {
    let date = &timestamp[..8];
    let scope = scope(date, creds.region, creds.service);
    let (canonical, signed_headers) = canonical_request(req);
    let to_sign = string_to_sign(timestamp, &scope, &canonical);
    let sig = signature(creds.secret_key, date, creds.region, creds.service, &to_sign);
    format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        creds.access_key, scope, signed_headers, sig
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The empty-body hash, which every GET and DELETE here sends.
    ///
    /// A published constant, and the one value in SigV4 that is quotable without ambiguity —
    /// it is simply SHA-256 of nothing, so the assertion is self-checking.
    const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    #[test]
    fn sha256_of_nothing_is_the_documented_constant() {
        // If this is wrong, the digest wiring is wrong and nothing below means anything.
        assert_eq!(sha256_hex(b""), EMPTY_SHA256);
        // And a known one-liner, to catch a byte-order or hex-formatting mistake.
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn hmac_matches_rfc_4231() {
        // RFC 4231 test case 1 for HMAC-SHA-256 — an external, quotable vector, so the
        // chaining in `signing_key` rests on something checkable rather than on itself.
        let key = [0x0bu8; 20];
        assert_eq!(
            hex(&hmac(&key, "Hi There")),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
    }

    #[test]
    fn a_path_is_encoded_by_s3s_rules_not_a_generic_uri_encoders() {
        // Separators survive, so a whole key can be passed in one go.
        assert_eq!(uri_encode_path("/bucket/fixtures/nums100.csv"), "/bucket/fixtures/nums100.csv");
        // A space and the characters a generic encoder leaves alone. If any of these reached
        // the wire unencoded while the signature covered the encoded form, minio would answer
        // 403 with nothing to point at.
        assert_eq!(uri_encode_path("/b/my file(1).csv"), "/b/my%20file%281%29.csv");
        assert_eq!(uri_encode_path("/b/a~b-c_d.e"), "/b/a~b-c_d.e");
        assert_eq!(uri_encode_path("/b/100%.csv"), "/b/100%25.csv");
    }

    #[test]
    fn a_query_string_encodes_its_separators_too() {
        assert_eq!(uri_encode_query("fixtures/"), "fixtures%2F");
        // Sorted by name, which is what makes the string canonical at all.
        assert_eq!(
            canonical_query(&[("prefix", "fixtures/"), ("list-type", "2")]),
            "list-type=2&prefix=fixtures%2F"
        );
        assert_eq!(canonical_query(&[]), "");
    }

    #[test]
    fn headers_are_lowercased_sorted_and_trimmed() {
        let req = Request {
            method: "GET",
            canonical_uri: "/test.txt",
            canonical_query: "",
            headers: vec![
                ("X-Amz-Date".into(), "20130524T000000Z".into()),
                ("Host".into(), "  examplebucket.s3.amazonaws.com  ".into()),
                ("Range".into(), "bytes=0-9".into()),
            ],
            payload_sha256: EMPTY_SHA256,
        };
        let (canonical, signed) = canonical_request(&req);
        // Order and case are fixed here rather than by the caller, so a header added later
        // cannot break the signature by arriving in the wrong place.
        assert_eq!(signed, "host;range;x-amz-date");
        assert_eq!(
            canonical,
            format!(
                "GET\n/test.txt\n\nhost:examplebucket.s3.amazonaws.com\nrange:bytes=0-9\n\
                 x-amz-date:20130524T000000Z\n\nhost;range;x-amz-date\n{EMPTY_SHA256}"
            )
        );
    }

    #[test]
    fn the_string_to_sign_has_the_shape_the_spec_states() {
        let s = string_to_sign(
            "20130524T000000Z",
            &scope("20130524", "us-east-1", "s3"),
            "CANONICAL",
        );
        let lines: Vec<&str> = s.split('\n').collect();
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0], "AWS4-HMAC-SHA256");
        assert_eq!(lines[1], "20130524T000000Z");
        assert_eq!(lines[2], "20130524/us-east-1/s3/aws4_request");
        // The fourth line is the *hash* of the canonical request, not the request.
        assert_eq!(lines[3], sha256_hex(b"CANONICAL"));
    }

    #[test]
    fn the_authorization_header_repeats_the_headers_it_signed() {
        // The commonest self-inflicted 403: SignedHeaders in the header disagreeing with the
        // list used to build the canonical request. They come from one place for that reason.
        let creds = Credentials {
            access_key: "AKIAIOSFODNN7EXAMPLE",
            secret_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            region: "us-east-1",
            service: "s3",
        };
        let req = Request {
            method: "PUT",
            canonical_uri: "/b/nums.csv",
            canonical_query: "",
            headers: vec![
                ("host".into(), "127.0.0.1:9000".into()),
                ("x-amz-date".into(), "20130524T000000Z".into()),
                ("x-amz-content-sha256".into(), EMPTY_SHA256.into()),
            ],
            payload_sha256: EMPTY_SHA256,
        };
        let auth = authorization(&creds, &req, "20130524T000000Z");
        let (_, signed) = canonical_request(&req);
        assert!(auth.contains(&format!("SignedHeaders={signed}")), "{auth}");
        assert!(
            auth.contains("Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request"),
            "{auth}"
        );
        // 64 hex characters, so a truncated or empty signature cannot pass unnoticed.
        let sig = auth.rsplit("Signature=").next().unwrap();
        assert_eq!(sig.len(), 64, "{auth}");
        assert!(sig.chars().all(|c| c.is_ascii_hexdigit()), "{auth}");
    }

    #[test]
    fn the_scope_date_and_the_timestamp_cannot_disagree() {
        // The scope's date is taken from the timestamp rather than passed separately, because
        // a mismatch between them is a 403 that reads like a credential problem.
        let creds = Credentials {
            access_key: "K",
            secret_key: "S",
            region: "eu-west-1",
            service: "s3",
        };
        let req = Request {
            method: "GET",
            canonical_uri: "/b",
            canonical_query: "",
            headers: vec![("host".into(), "h".into())],
            payload_sha256: EMPTY_SHA256,
        };
        let auth = authorization(&creds, &req, "20260804T101530Z");
        assert!(auth.contains("Credential=K/20260804/eu-west-1/s3/aws4_request"), "{auth}");
    }
}
