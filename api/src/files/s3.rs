//! MinIO, over the S3 API.
//!
//! Three operations, each SigV4-signed by `sigv4`: PUT an object, list them, delete one.
//! Path-style addressing (`{endpoint}/{bucket}/{key}`) because that is what a minio reached by
//! IP or port-forward serves — virtual-host style would need DNS per bucket.
//!
//! **The list response is XML**, and it is scanned rather than parsed. ListObjectsV2 returns a
//! flat repetition of `<Contents><Key/><Size/><LastModified/></Contents>` and pulling three
//! tags out of it does not justify an XML dependency in a project that hand-writes its SQL.
//! The five standard entities are decoded, which is all a key can contain.

use async_trait::async_trait;

use super::sigv4::{
    authorization, canonical_query, sha256_hex, uri_encode_path, Credentials, Request,
};
use super::{key_for, FileStore, Reference, StoreConfig, StoredFile};
use crate::error::AppError;

pub struct S3Store {
    cfg: StoreConfig,
    /// Optional, deliberately: `buckets()` exists to answer "which buckets are there?", and
    /// requiring one to ask that made the constructor reject the very case it is for. Demanded
    /// only by the operations that address an object.
    bucket: Option<String>,
    access_key: String,
    secret_key: String,
    client: reqwest::Client,
}

impl S3Store {
    pub fn new(cfg: StoreConfig) -> Result<Self, AppError> {
        // Credentials are required for any request at all — an unsigned one to minio is a 403
        // with nothing to learn from. `missing()` normally catches this first.
        let access_key = cfg.access_key.clone().ok_or_else(|| {
            AppError::BadRequest("this storage has no access key".to_string())
        })?;
        let secret_key = cfg.secret_key.clone().ok_or_else(|| {
            AppError::BadRequest("this storage has no secret key".to_string())
        })?;
        let bucket = cfg.bucket.clone().filter(|b| !b.trim().is_empty());
        Ok(Self { cfg, bucket, access_key, secret_key, client: reqwest::Client::new() })
    }

    /// The bucket, for an operation that cannot work without one.
    ///
    /// A `BadRequest` rather than an internal error: a storage saved without a bucket is a
    /// configuration someone can fix, not a fault in this process.
    fn bucket(&self) -> Result<&str, AppError> {
        self.bucket.as_deref().ok_or_else(|| {
            AppError::BadRequest(
                "this storage has no bucket set — put one in the Bucket field".to_string(),
            )
        })
    }

    fn creds(&self) -> Credentials<'_> {
        Credentials {
            access_key: &self.access_key,
            secret_key: &self.secret_key,
            region: &self.cfg.region,
            service: "s3",
        }
    }

    /// The `Host` header value — what the signature covers, so it must match the URL exactly.
    fn host(&self) -> String {
        self.cfg
            .endpoint
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_end_matches('/')
            .to_string()
    }

    /// `YYYYMMDDTHHMMSSZ`, the only timestamp format SigV4 accepts.
    fn now() -> String {
        chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string()
    }

    /// What the author pastes into a test.
    ///
    /// `bucket/key` by default rather than a URL: an in-cluster minio is on an RFC1918
    /// address, and a URL pointing at it is what the platform's SSRF guard rejects.
    fn reference(&self, bucket: &str, key: &str) -> String {
        match self.cfg.reference {
            Reference::Key => format!("{bucket}/{key}"),
            Reference::Url => format!("{}/{}/{}", self.cfg.endpoint, bucket, key),
        }
    }

    fn unreachable(&self, e: reqwest::Error) -> AppError {
        AppError::HttpError(format!(
            "could not reach the file store at {} — {}",
            self.cfg.endpoint, e
        ))
    }

    /// S3's own words, plus the one hint worth adding.
    fn refused(&self, what: &str, status: u16, body: &str) -> AppError {
        let code = tag(body, "Code").unwrap_or_default();
        let message = tag(body, "Message").unwrap_or_else(|| snippet(body));
        // The signature failing says nothing about *why*, and the two causes are wildly
        // different places to look.
        let hint = if code == "SignatureDoesNotMatch" {
            " — check the access key and secret, and that this machine's clock is right \
             (SigV4 rejects a timestamp more than 15 minutes out)"
        } else if code == "NoSuchBucket" {
            // Stale wording until now: it named an environment variable, which stopped being
            // where the bucket comes from once storages moved into the UI. It is also the
            // commonest first failure, so it has to point at the actual fix.
            " — the bucket has to exist before satyanaash can use it. Create it in minio, or \
             change the Bucket field to one that is already there"
        } else if code == "AccessDenied" {
            " — this credential is not allowed to. Ask whoever administers the storage, quoting \
             exactly this"
        } else {
            ""
        };
        AppError::HttpError(format!("the file store refused to {what} ({status} {code}): {message}{hint}"))
    }
}

#[async_trait]
impl FileStore for S3Store {
    async fn put(&self, name: &str, bytes: Vec<u8>, mime: Option<&str>) -> Result<StoredFile, AppError> {
        let bucket = self.bucket()?.to_string();
        let key = key_for(&self.cfg, name);
        let path = uri_encode_path(&format!("/{}/{}", bucket, key));
        let timestamp = Self::now();
        let payload_hash = sha256_hex(&bytes);
        let host = self.host();

        let signed = vec![
            ("host".to_string(), host.clone()),
            ("x-amz-content-sha256".to_string(), payload_hash.clone()),
            ("x-amz-date".to_string(), timestamp.clone()),
        ];
        let auth = authorization(
            &self.creds(),
            &Request {
                method: "PUT",
                canonical_uri: &path,
                canonical_query: "",
                headers: signed,
                payload_sha256: &payload_hash,
            },
            &timestamp,
        );

        let size = bytes.len() as u64;
        let mut req = self
            .client
            .put(format!("{}{}", self.cfg.endpoint, path))
            .header("x-amz-content-sha256", &payload_hash)
            .header("x-amz-date", &timestamp)
            .header("Authorization", auth)
            .body(bytes);
        // Sent but deliberately unsigned: S3 requires every `x-amz-*` header to be signed and
        // permits others not to be, and one fewer header in the canonical request is one
        // fewer way for it to disagree with the wire.
        if let Some(m) = mime {
            req = req.header("Content-Type", m);
        }

        let res = req.send().await.map_err(|e| self.unreachable(e))?;
        let status = res.status().as_u16();
        if !res.status().is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(self.refused("store the file", status, &body));
        }

        Ok(StoredFile {
            name: name.to_string(),
            reference: self.reference(&bucket, &key),
            key,
            size,
            // S3 answers a PUT with no body, so there is nothing to report. The list gives
            // the timestamp — inventing one here would sort convincingly wrongly.
            uploaded_at: None,
        })
    }

    async fn list(&self) -> Result<Vec<StoredFile>, AppError> {
        let mut pairs: Vec<(&str, &str)> = vec![("list-type", "2")];
        if !self.cfg.prefix.is_empty() {
            pairs.push(("prefix", &self.cfg.prefix));
        }
        let query = canonical_query(&pairs);
        let path = uri_encode_path(&format!("/{}", self.bucket()?));
        let timestamp = Self::now();
        let empty = sha256_hex(b"");
        let host = self.host();

        let auth = authorization(
            &self.creds(),
            &Request {
                method: "GET",
                canonical_uri: &path,
                canonical_query: &query,
                headers: vec![
                    ("host".to_string(), host),
                    ("x-amz-content-sha256".to_string(), empty.clone()),
                    ("x-amz-date".to_string(), timestamp.clone()),
                ],
                payload_sha256: &empty,
            },
            &timestamp,
        );

        let res = self
            .client
            .get(format!("{}{}?{}", self.cfg.endpoint, path, query))
            .header("x-amz-content-sha256", &empty)
            .header("x-amz-date", &timestamp)
            .header("Authorization", auth)
            .send()
            .await
            .map_err(|e| self.unreachable(e))?;

        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(self.refused("list its files", status, &body));
        }
        let bucket = self.bucket()?.to_string();
        Ok(parse_list(&body, &self.cfg.prefix, |k| self.reference(&bucket, k)))
    }

    /// `GET /` — ListAllMyBuckets.
    async fn buckets(&self) -> Result<Vec<String>, AppError> {
        let timestamp = Self::now();
        let empty = sha256_hex(b"");
        let auth = authorization(
            &self.creds(),
            &Request {
                method: "GET",
                canonical_uri: "/",
                canonical_query: "",
                headers: vec![
                    ("host".to_string(), self.host()),
                    ("x-amz-content-sha256".to_string(), empty.clone()),
                    ("x-amz-date".to_string(), timestamp.clone()),
                ],
                payload_sha256: &empty,
            },
            &timestamp,
        );

        let res = self
            .client
            .get(format!("{}/", self.cfg.endpoint))
            .header("x-amz-content-sha256", &empty)
            .header("x-amz-date", &timestamp)
            .header("Authorization", auth)
            .send()
            .await
            .map_err(|e| self.unreachable(e))?;

        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(self.refused("list its buckets", status, &body));
        }
        // Same scan as the object list: `<Bucket><Name>…</Name></Bucket>`, repeated.
        Ok(body
            .split("<Bucket>")
            .skip(1)
            .filter_map(|chunk| tag(chunk.split("</Bucket>").next().unwrap_or(chunk), "Name"))
            .collect())
    }

    /// `PUT /{bucket}`.
    async fn create_bucket(&self, name: &str) -> Result<(), AppError> {
        let path = uri_encode_path(&format!("/{}", name.trim()));
        let timestamp = Self::now();
        let empty = sha256_hex(b"");
        let auth = authorization(
            &self.creds(),
            &Request {
                method: "PUT",
                canonical_uri: &path,
                canonical_query: "",
                headers: vec![
                    ("host".to_string(), self.host()),
                    ("x-amz-content-sha256".to_string(), empty.clone()),
                    ("x-amz-date".to_string(), timestamp.clone()),
                ],
                payload_sha256: &empty,
            },
            &timestamp,
        );

        let res = self
            .client
            .put(format!("{}{}", self.cfg.endpoint, path))
            .header("x-amz-content-sha256", &empty)
            .header("x-amz-date", &timestamp)
            .header("Authorization", auth)
            .send()
            .await
            .map_err(|e| self.unreachable(e))?;

        if res.status().is_success() {
            return Ok(());
        }
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        // Already ours is the state the caller asked for, not a failure.
        if tag(&body, "Code").as_deref() == Some("BucketAlreadyOwnedByYou") {
            return Ok(());
        }
        Err(self.refused(&format!("create the bucket \"{}\"", name.trim()), status, &body))
    }

    async fn delete(&self, key: &str) -> Result<(), AppError> {
        let path =
            uri_encode_path(&format!("/{}/{}", self.bucket()?, key.trim_start_matches('/')));
        let timestamp = Self::now();
        let empty = sha256_hex(b"");
        let host = self.host();

        let auth = authorization(
            &self.creds(),
            &Request {
                method: "DELETE",
                canonical_uri: &path,
                canonical_query: "",
                headers: vec![
                    ("host".to_string(), host),
                    ("x-amz-content-sha256".to_string(), empty.clone()),
                    ("x-amz-date".to_string(), timestamp.clone()),
                ],
                payload_sha256: &empty,
            },
            &timestamp,
        );

        let res = self
            .client
            .delete(format!("{}{}", self.cfg.endpoint, path))
            .header("x-amz-content-sha256", &empty)
            .header("x-amz-date", &timestamp)
            .header("Authorization", auth)
            .send()
            .await
            .map_err(|e| self.unreachable(e))?;

        // S3 answers 204 whether or not the object was there, and a 404 from a proxy in front
        // of it means the same thing: the caller asked for it to be absent, and it is.
        if res.status().is_success() || res.status().as_u16() == 404 {
            return Ok(());
        }
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        Err(self.refused("delete the file", status, &body))
    }
}

/// The first `<Tag>…</Tag>` in `xml`, entity-decoded.
fn tag(xml: &str, name: &str) -> Option<String> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(unescape(&xml[start..end]))
}

/// XML's five predefined entities. A key from `sanitise` contains none of them, but a bucket
/// may hold objects this app did not put there.
fn unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        // Last, or an escaped `&amp;lt;` would decode twice.
        .replace("&amp;", "&")
}

/// Pull the objects out of a ListObjectsV2 response.
///
/// Directory markers — a key ending in `/`, which minio's console creates — are dropped: they
/// are not files and a zero-byte row called nothing helps no one.
fn parse_list(xml: &str, prefix: &str, reference: impl Fn(&str) -> String) -> Vec<StoredFile> {
    let mut out = Vec::new();
    for chunk in xml.split("<Contents>").skip(1) {
        let block = chunk.split("</Contents>").next().unwrap_or(chunk);
        let Some(key) = tag(block, "Key") else { continue };
        if key.ends_with('/') {
            continue;
        }
        let name = key.strip_prefix(prefix).unwrap_or(&key).to_string();
        out.push(StoredFile {
            reference: reference(&key),
            name: if name.is_empty() { key.clone() } else { name },
            size: tag(block, "Size").and_then(|s| s.trim().parse().ok()).unwrap_or(0),
            uploaded_at: tag(block, "LastModified"),
            key,
        });
    }
    out
}

fn snippet(body: &str) -> String {
    let t = body.trim();
    if t.is_empty() {
        return "no message".to_string();
    }
    if t.chars().count() > 200 {
        format!("{}…", t.chars().take(200).collect::<String>())
    } else {
        t.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::StoreKind;

    fn cfg(reference: Reference, prefix: &str) -> StoreConfig {
        StoreConfig {
            kind: StoreKind::S3,
            endpoint: "http://127.0.0.1:9000".into(),
            bucket: Some("sat-fixtures".into()),
            prefix: prefix.into(),
            access_key: Some("minioadmin".into()),
            secret_key: Some("minioadmin".into()),
            token: None,
            reference,
            region: "us-east-1".into(),
        }
    }

    const LIST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>sat-fixtures</Name>
  <Prefix>fixtures/</Prefix>
  <KeyCount>3</KeyCount>
  <Contents>
    <Key>fixtures/</Key><Size>0</Size><LastModified>2026-08-04T09:00:00.000Z</LastModified>
  </Contents>
  <Contents>
    <Key>fixtures/nums100.csv</Key>
    <LastModified>2026-08-04T10:05:00.000Z</LastModified>
    <Size>4198</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
  <Contents>
    <Key>fixtures/a &amp; b.csv</Key><Size>12</Size><LastModified>2026-08-04T10:06:00.000Z</LastModified>
  </Contents>
</ListBucketResult>"#;

    #[test]
    fn the_list_yields_files_and_drops_directory_markers() {
        let c = cfg(Reference::Key, "fixtures/");
        let files = parse_list(LIST, &c.prefix, |k| format!("sat-fixtures/{k}"));
        // `fixtures/` is a marker minio's console creates, not a file.
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].name, "nums100.csv");
        assert_eq!(files[0].key, "fixtures/nums100.csv");
        assert_eq!(files[0].size, 4198);
        assert_eq!(files[0].uploaded_at.as_deref(), Some("2026-08-04T10:05:00.000Z"));
        // The prefix is stripped for display — it is configuration, not part of the name.
        assert_eq!(files[0].reference, "sat-fixtures/fixtures/nums100.csv");
        // Entity-decoded, because a bucket may hold objects this app did not put there.
        assert_eq!(files[1].name, "a & b.csv");
    }

    #[test]
    fn tags_are_read_in_order_and_decoded() {
        assert_eq!(tag("<Code>NoSuchBucket</Code>", "Code").as_deref(), Some("NoSuchBucket"));
        assert_eq!(tag("<Message>a &amp; b</Message>", "Message").as_deref(), Some("a & b"));
        assert_eq!(tag("<Other>x</Other>", "Code"), None);
        // An unterminated tag is missing, not a panic.
        assert_eq!(tag("<Code>oops", "Code"), None);
    }

    #[test]
    fn unescaping_amp_last_does_not_double_decode() {
        // `&amp;lt;` is a literal "&lt;", not a "<". Decoding `&amp;` first would turn it into
        // one, which is how an escaper corrupts data it was meant to preserve.
        assert_eq!(unescape("&amp;lt;"), "&lt;");
        assert_eq!(unescape("&lt;tag&gt;"), "<tag>");
    }

    #[test]
    fn the_reference_is_a_key_by_default_and_a_url_on_request() {
        let key_store = S3Store::new(cfg(Reference::Key, "fixtures/")).unwrap();
        // A URL to an in-cluster minio is RFC1918, which is what the platform's SSRF guard
        // rejects — so the default hands over something the API resolves itself.
        assert_eq!(
            key_store.reference("sat-fixtures", "fixtures/nums100.csv"),
            "sat-fixtures/fixtures/nums100.csv"
        );

        let url_store = S3Store::new(cfg(Reference::Url, "fixtures/")).unwrap();
        assert_eq!(
            url_store.reference("sat-fixtures", "fixtures/nums100.csv"),
            "http://127.0.0.1:9000/sat-fixtures/fixtures/nums100.csv"
        );
    }

    #[test]
    fn the_signed_host_matches_the_url_that_is_sent() {
        // If these disagree the signature covers a different request than the one on the
        // wire, and minio answers 403 with nothing to point at.
        let store = S3Store::new(cfg(Reference::Key, "")).unwrap();
        assert_eq!(store.host(), "127.0.0.1:9000");

        let mut https = cfg(Reference::Key, "");
        https.endpoint = "https://minio.example.com/".into();
        assert_eq!(S3Store::new(https).unwrap().host(), "minio.example.com");
    }

    #[test]
    fn a_signature_failure_says_where_to_look() {
        let store = S3Store::new(cfg(Reference::Key, "")).unwrap();
        let body = "<Error><Code>SignatureDoesNotMatch</Code><Message>bad sig</Message></Error>";
        let msg = format!("{}", store.refused("store the file", 403, body));
        // The two causes are entirely different places to look, and S3 says neither.
        assert!(msg.contains("clock"), "{msg}");
        assert!(msg.contains("access key"), "{msg}");
        assert!(msg.contains("bad sig"), "{msg}");
    }

    #[test]
    fn a_store_with_no_bucket_can_still_be_asked_which_buckets_exist() {
        // The bug this replaces: the constructor demanded a bucket, so the one call whose whole
        // purpose is to *find* a bucket could never be made. Someone filling in the form has not
        // typed one yet — that is the moment the list is worth having.
        let mut no_bucket = cfg(Reference::Key, "");
        no_bucket.bucket = None;
        let store = S3Store::new(no_bucket).expect("a bucket is not needed to list buckets");
        // …but anything addressing an object says what is missing, and says it as a fixable
        // configuration rather than an internal fault.
        let e = store.bucket().unwrap_err();
        assert!(format!("{e}").contains("Bucket field"), "{e}");
        assert!(matches!(e, AppError::BadRequest(_)));
    }

    #[test]
    fn credentials_are_still_required() {
        let mut no_key = cfg(Reference::Key, "");
        no_key.secret_key = None;
        assert!(S3Store::new(no_key).is_err());
    }
}
