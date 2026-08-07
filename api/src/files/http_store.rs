//! A plain upload/fetch service — the Ngage file-service pod.
//!
//! The contract, which this defines so the pod can be built to match:
//!
//! ```text
//! POST   {endpoint}/files            multipart, part name "file"
//!        → 200/201 { name, key, url?, size?, uploaded_at? }
//! GET    {endpoint}/files            → { files: [ … ] }  or a bare [ … ]
//! DELETE {endpoint}/files/{key}      → 200/204
//! ```
//!
//! `Authorization: Bearer …` is sent when a token is configured, and omitted when it is not —
//! a file service for a test rig may legitimately have no auth.
//!
//! **Parsing is deliberately tolerant.** The pod does not exist yet, so a response that says
//! `reference` instead of `url`, or omits the URL entirely, still works: the URL is rebuilt
//! from the endpoint and the key. Being strict here would mean the first version of the pod
//! failing on a field name rather than on anything that matters.

use async_trait::async_trait;
use serde_json::Value;

use super::{key_for, FileStore, Reference, StoreConfig, StoredFile};
use crate::error::AppError;

pub struct HttpStore {
    cfg: StoreConfig,
    client: reqwest::Client,
}

impl HttpStore {
    pub fn new(cfg: StoreConfig) -> Self {
        Self { cfg, client: reqwest::Client::new() }
    }

    fn files_url(&self) -> String {
        format!("{}/files", self.cfg.endpoint)
    }

    fn auth(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match self.cfg.token.as_deref() {
            Some(t) => req.header("Authorization", format!("Bearer {t}")),
            None => req,
        }
    }

    /// Where the store is, in a sentence an author can act on.
    ///
    /// A refused connection here almost always means a port-forward that is not running, and
    /// "error sending request" on its own has sent people looking in the wrong place.
    fn unreachable(&self, e: reqwest::Error) -> AppError {
        AppError::HttpError(format!(
            "could not reach the file store at {} — {}",
            self.cfg.endpoint,
            plain(&e)
        ))
    }

    fn parse_one(&self, v: &Value, fallback_name: &str) -> StoredFile {
        let name = v.get("name").and_then(Value::as_str).unwrap_or(fallback_name).to_string();
        let key = v
            .get("key")
            .or_else(|| v.get("path"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| key_for(&self.cfg, &name));
        let url = v
            .get("url")
            .or_else(|| v.get("reference"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("{}/{}", self.files_url(), key));
        StoredFile {
            reference: match self.cfg.reference {
                Reference::Url => url,
                // Asking a file service for a key is unusual but the setting is honoured
                // rather than overridden — the author knows their platform.
                Reference::Key => key.clone(),
            },
            name,
            key,
            size: v.get("size").and_then(Value::as_u64).unwrap_or(0),
            uploaded_at: v
                .get("uploaded_at")
                .or_else(|| v.get("uploadedAt"))
                .or_else(|| v.get("created_at"))
                .and_then(Value::as_str)
                .map(str::to_string),
        }
    }
}

#[async_trait]
impl FileStore for HttpStore {
    async fn put(&self, name: &str, bytes: Vec<u8>, mime: Option<&str>) -> Result<StoredFile, AppError> {
        let mut part = reqwest::multipart::Part::bytes(bytes.clone()).file_name(name.to_string());
        if let Some(m) = mime {
            // `mime_str` consumes the part and can reject a header the browser sent, so a
            // failure falls back to the unset content type rather than the whole upload.
            part = part
                .mime_str(m)
                .unwrap_or_else(|_| reqwest::multipart::Part::bytes(bytes).file_name(name.to_string()));
        }
        let form = reqwest::multipart::Form::new().part("file", part);

        let res = self
            .auth(self.client.post(self.files_url()))
            .multipart(form)
            .send()
            .await
            .map_err(|e| self.unreachable(e))?;

        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(AppError::HttpError(format!(
                "the file store refused the upload ({}) — {}",
                status.as_u16(),
                snippet(&body)
            )));
        }
        let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        Ok(self.parse_one(&v, name))
    }

    async fn list(&self) -> Result<Vec<StoredFile>, AppError> {
        let res = self
            .auth(self.client.get(self.files_url()))
            .send()
            .await
            .map_err(|e| self.unreachable(e))?;
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(AppError::HttpError(format!(
                "the file store could not list its files ({}) — {}",
                status.as_u16(),
                snippet(&body)
            )));
        }
        let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        let items = v
            .get("files")
            .and_then(Value::as_array)
            .or_else(|| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(items.iter().map(|it| self.parse_one(it, "file")).collect())
    }

    async fn delete(&self, key: &str) -> Result<(), AppError> {
        let url = format!("{}/{}", self.files_url(), key.trim_start_matches('/'));
        let res = self
            .auth(self.client.delete(url))
            .send()
            .await
            .map_err(|e| self.unreachable(e))?;
        if res.status().is_success() || res.status().as_u16() == 404 {
            // A 404 means it is already gone, which is the state the caller asked for.
            return Ok(());
        }
        let status = res.status().as_u16();
        let body = res.text().await.unwrap_or_default();
        Err(AppError::HttpError(format!(
            "the file store refused the delete ({}) — {}",
            status,
            snippet(&body)
        )))
    }
}

fn plain(e: &reqwest::Error) -> String {
    let mut s = e.to_string();
    if let Some(src) = std::error::Error::source(e) {
        s = format!("{s}: {src}");
    }
    s
}

/// Enough of a body to diagnose, not enough to fill a log line.
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
    use crate::files::{Reference, StoreKind};
    use std::sync::{Arc, Mutex};

    fn cfg(endpoint: &str, token: Option<&str>) -> StoreConfig {
        StoreConfig {
            kind: StoreKind::Http,
            endpoint: endpoint.trim_end_matches('/').to_string(),
            bucket: None,
            prefix: String::new(),
            access_key: None,
            secret_key: None,
            token: token.map(str::to_string),
            reference: Reference::Url,
            region: "us-east-1".into(),
        }
    }

    /// A stub file service. Answers each request from `replies` in turn and records what it
    /// was asked, so a test can assert on the method, the path and the headers.
    async fn stub(replies: Vec<(u16, &'static str)>) -> (String, Arc<Mutex<Vec<String>>>) {
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let log = seen.clone();
        tokio::spawn(async move {
            for (status, body) in replies {
                let Ok((mut socket, _)) = listener.accept().await else { break };
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = vec![0u8; 65536];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..n]).to_string();
                log.lock().unwrap().push(head);
                let res = format!(
                    "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    status,
                    body.len(),
                    body
                );
                let _ = socket.write_all(res.as_bytes()).await;
                let _ = socket.flush().await;
            }
        });
        (format!("http://{}", addr), seen)
    }

    #[tokio::test]
    async fn an_upload_returns_what_the_author_pastes() {
        let (url, seen) = stub(vec![(
            201,
            r#"{"name":"nums100.csv","key":"f/nums100.csv","url":"https://files.internal/f/nums100.csv","size":4198,"uploaded_at":"2026-08-04T10:00:00Z"}"#,
        )])
        .await;
        let store = HttpStore::new(cfg(&url, Some("t0ken")));

        let f = store.put("nums100.csv", b"a,b,c\n".to_vec(), Some("text/csv")).await.unwrap();
        assert_eq!(f.name, "nums100.csv");
        assert_eq!(f.reference, "https://files.internal/f/nums100.csv");
        assert_eq!(f.size, 4198);

        let req = seen.lock().unwrap()[0].clone();
        assert!(req.starts_with("POST /files "), "{req}");
        assert!(req.contains("multipart/form-data"), "{req}");
        assert!(req.contains("name=\"file\""), "{req}");
        // Lower-cased before matching: header names are case-insensitive and reqwest sends
        // them lowercase, so a case-sensitive assertion here tests reqwest, not us.
        assert!(req.to_ascii_lowercase().contains("authorization: bearer t0ken"), "{req}");
    }

    #[tokio::test]
    async fn no_token_means_no_authorization_header() {
        // A test rig's file service may have no auth at all, and sending `Bearer ` would be
        // worse than sending nothing.
        let (url, seen) = stub(vec![(201, r#"{"name":"a.csv","key":"a.csv"}"#)]).await;
        let store = HttpStore::new(cfg(&url, None));
        store.put("a.csv", b"x".to_vec(), None).await.unwrap();
        assert!(!seen.lock().unwrap()[0].to_ascii_lowercase().contains("authorization"));
    }

    #[tokio::test]
    async fn a_response_without_a_url_still_yields_one() {
        // The pod does not exist yet. Failing on a missing field would mean its first version
        // breaking on a name rather than on anything that matters.
        let (url, _) = stub(vec![(200, r#"{"name":"nums10.csv","key":"f/nums10.csv"}"#)]).await;
        let store = HttpStore::new(cfg(&url, None));
        let f = store.put("nums10.csv", b"x".to_vec(), None).await.unwrap();
        assert_eq!(f.reference, format!("{}/files/f/nums10.csv", url));
    }

    #[tokio::test]
    async fn a_list_reads_either_shape() {
        let wrapped = r#"{"files":[{"name":"a.csv","key":"a.csv","url":"https://h/a.csv","size":10}]}"#;
        let (url, _) = stub(vec![(200, wrapped)]).await;
        assert_eq!(HttpStore::new(cfg(&url, None)).list().await.unwrap().len(), 1);

        let bare = r#"[{"name":"a.csv","key":"a.csv"},{"name":"b.csv","key":"b.csv"}]"#;
        let (url2, _) = stub(vec![(200, bare)]).await;
        let files = HttpStore::new(cfg(&url2, None)).list().await.unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[1].name, "b.csv");
    }

    #[tokio::test]
    async fn deleting_something_already_gone_is_success() {
        // The caller asked for it to be absent, and it is. Reporting an error would make a
        // double-click look like a failure.
        let (url, seen) = stub(vec![(404, r#"{"error":"no such file"}"#)]).await;
        HttpStore::new(cfg(&url, None)).delete("f/a.csv").await.unwrap();
        assert!(seen.lock().unwrap()[0].starts_with("DELETE /files/f/a.csv "), "{:?}", seen.lock().unwrap()[0]);
    }

    #[tokio::test]
    async fn a_refusal_carries_the_stores_own_message() {
        let (url, _) = stub(vec![(413, r#"{"error":"file too large"}"#)]).await;
        let e = HttpStore::new(cfg(&url, None)).put("big.csv", b"x".to_vec(), None).await.unwrap_err();
        let msg = format!("{e}");
        assert!(msg.contains("413"), "{msg}");
        // The store's own words, not ours — it knows why it said no.
        assert!(msg.contains("file too large"), "{msg}");
    }

    #[tokio::test]
    async fn an_unreachable_store_names_the_endpoint() {
        // Almost always a port-forward that is not running. "error sending request" alone has
        // sent people looking in the wrong place.
        let store = HttpStore::new(cfg("http://127.0.0.1:1", None));
        let e = store.list().await.unwrap_err();
        let msg = format!("{e}");
        assert!(msg.contains("could not reach the file store at http://127.0.0.1:1"), "{msg}");
    }
}
