//! Where the file store for an environment is described.
//!
//! **Environment variables only.** Nothing about a store — least of all its credentials —
//! is kept in the project or sent to the browser. The cost, accepted deliberately: adding a
//! store means editing a shell profile and restarting, and the configuration does not travel
//! with the project when it is shared.
//!
//! One set of variables per environment, named after it:
//!
//! ```text
//! SAT_FILESTORE_DEV_KIND=s3            # s3 | http
//! SAT_FILESTORE_DEV_ENDPOINT=http://127.0.0.1:9000
//! SAT_FILESTORE_DEV_BUCKET=sat-fixtures
//! SAT_FILESTORE_DEV_PREFIX=fixtures/
//! SAT_FILESTORE_DEV_ACCESS_KEY=…
//! SAT_FILESTORE_DEV_SECRET_KEY=…
//! SAT_FILESTORE_DEV_TOKEN=…            # http only
//! SAT_FILESTORE_DEV_REFERENCE=key      # key | url
//! ```

/// Which protocol the store speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StoreKind {
    /// S3, i.e. minio. SigV4-signed.
    S3,
    /// A plain upload/fetch service — the Ngage file-service pod.
    Http,
}

/// What the author pastes into a test.
///
/// A URL is the obvious answer and often the wrong one here: an in-cluster minio lives on an
/// RFC1918 address, and a URL pointing at it is rejected by the very SSRF guard this feature
/// works around. `Key` hands over `bucket/prefix/name` instead, which the API resolves
/// against the store it already knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Reference {
    Key,
    Url,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreConfig {
    pub kind: StoreKind,
    pub endpoint: String,
    pub bucket: Option<String>,
    pub prefix: String,
    pub access_key: Option<String>,
    pub secret_key: Option<String>,
    pub token: Option<String>,
    pub reference: Reference,
    /// The region SigV4 signs for. MinIO ignores it but the signature must agree with itself.
    pub region: String,
}

impl StoreConfig {
    /// Short label for the UI — never includes a credential.
    pub fn label(&self) -> String {
        let host = self.endpoint.trim_end_matches('/');
        match (&self.kind, &self.bucket) {
            (StoreKind::S3, Some(b)) => format!("minio · {} @ {}", b, strip_scheme(host)),
            (StoreKind::S3, None) => format!("minio · {}", strip_scheme(host)),
            (StoreKind::Http, _) => format!("file service · {}", strip_scheme(host)),
        }
    }

    /// Missing pieces, named the way the author would have to fix them.
    ///
    /// Returned rather than logged, and never guessed at: a store built from half a
    /// configuration would fail later with a message about the store instead of about the
    /// two variables nobody exported.
    pub fn missing(&self, env: Option<&str>) -> Vec<String> {
        let p = prefix_for(env);
        let mut out = Vec::new();
        if self.endpoint.trim().is_empty() {
            out.push(format!("{p}_ENDPOINT"));
        }
        match self.kind {
            StoreKind::S3 => {
                if self.bucket.as_deref().unwrap_or("").trim().is_empty() {
                    out.push(format!("{p}_BUCKET"));
                }
                if self.access_key.as_deref().unwrap_or("").trim().is_empty() {
                    out.push(format!("{p}_ACCESS_KEY"));
                }
                if self.secret_key.as_deref().unwrap_or("").trim().is_empty() {
                    out.push(format!("{p}_SECRET_KEY"));
                }
            }
            // A file service may legitimately need no auth at all, so a missing token is not
            // a missing setting.
            StoreKind::Http => {}
        }
        out
    }
}

fn strip_scheme(url: &str) -> &str {
    url.trim_start_matches("https://").trim_start_matches("http://")
}

/// `Some("Staging QA")` → `SAT_FILESTORE_STAGING_QA`, `None` → `SAT_FILESTORE`.
///
/// The unnamed set is the fallback, which covers both a single-store rig and running with
/// **Env: None** — where there is no environment to name but files still have to go somewhere.
pub fn prefix_for(env: Option<&str>) -> String {
    match env.map(str::trim).filter(|e| !e.is_empty()) {
        Some(name) => {
            let slug: String = name
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' })
                .collect();
            format!("SAT_FILESTORE_{slug}")
        }
        None => "SAT_FILESTORE".to_string(),
    }
}

/// Read one named set.
///
/// `None` means that set is not configured — reported as such rather than as an empty file
/// list, because "no files" and "no store" are different answers.
pub fn read(env: Option<&str>, vars: &dyn Fn(&str) -> Option<String>) -> Option<StoreConfig> {
    from_prefix(&prefix_for(env), vars)
}

/// Every store the environment defines, named after the variable prefix that defines it.
///
/// The name is the prefix itself — `SAT_FILESTORE_DEV` rather than `DEV` — so a picker entry
/// says exactly where it came from, and so the message refusing to edit it can name the
/// variables without a second naming scheme to invert.
///
/// A set exists when its `_ENDPOINT` is set. Sorted, so the picker's order does not depend on
/// however the process happened to receive its environment.
pub fn enumerate(vars: &[(String, String)]) -> Vec<(String, StoreConfig)> {
    let lookup = |k: &str| -> Option<String> {
        vars.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone())
    };

    let mut prefixes: Vec<String> = vars
        .iter()
        .filter_map(|(name, value)| {
            let prefix = name.strip_suffix("_ENDPOINT")?;
            // `SAT_FILESTORE_ENDPOINT` (the unnamed set) or `SAT_FILESTORE_<LABEL>_ENDPOINT`.
            if prefix == "SAT_FILESTORE" || prefix.starts_with("SAT_FILESTORE_") {
                (!value.trim().is_empty()).then(|| prefix.to_string())
            } else {
                None
            }
        })
        .collect();
    prefixes.sort();
    prefixes.dedup();

    prefixes
        .into_iter()
        .filter_map(|prefix| from_prefix(&prefix, &lookup).map(|cfg| (prefix, cfg)))
        .collect()
}

/// `enumerate` over the real process environment.
pub fn from_environment() -> Vec<(String, StoreConfig)> {
    enumerate(&std::env::vars().collect::<Vec<_>>())
}

fn from_prefix(prefix: &str, vars: &dyn Fn(&str) -> Option<String>) -> Option<StoreConfig> {
    let get = |k: &str| vars(&format!("{prefix}_{k}")).filter(|v| !v.trim().is_empty());

    // The endpoint is what makes a set exist. Without it there is nothing to talk to, and a
    // stray `SAT_FILESTORE_DEV_PREFIX` left in a shell should not conjure a store.
    let endpoint = get("ENDPOINT")?;

    let kind = match get("KIND").as_deref().map(str::to_ascii_lowercase).as_deref() {
        Some("http") => StoreKind::Http,
        Some("s3") => StoreKind::S3,
        // Guessing from the shape of the rest is better than defaulting blindly: a bucket
        // and a secret key mean S3 whatever the author forgot to write.
        _ if get("BUCKET").is_some() || get("SECRET_KEY").is_some() => StoreKind::S3,
        _ => StoreKind::Http,
    };

    let reference = match get("REFERENCE").as_deref().map(str::to_ascii_lowercase).as_deref() {
        Some("url") => Reference::Url,
        Some("key") => Reference::Key,
        // An HTTP store answers with a URL of its own, so that is its natural form. An S3
        // store defaults to a key, because a URL to an in-cluster minio is the case the SSRF
        // guard rejects.
        None | Some(_) => match kind {
            StoreKind::Http => Reference::Url,
            StoreKind::S3 => Reference::Key,
        },
    };

    Some(StoreConfig {
        kind,
        endpoint: endpoint.trim_end_matches('/').to_string(),
        bucket: get("BUCKET"),
        // Normalised to end in exactly one slash when set, so keys never come out with `//`
        // or run the prefix into the filename.
        prefix: match get("PREFIX") {
            Some(p) => format!("{}/", p.trim_matches('/')),
            None => String::new(),
        },
        access_key: get("ACCESS_KEY"),
        secret_key: get("SECRET_KEY"),
        token: get("TOKEN"),
        reference,
        region: get("REGION").unwrap_or_else(|| "us-east-1".to_string()),
    })
}

/// Reads the real process environment. Split out so the tests never touch it — `set_var` is
/// process-global and would make them order-dependent.
pub fn from_process_env(env: Option<&str>) -> Option<StoreConfig> {
    read(env, &|k| std::env::var(k).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn vars(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }
    fn lookup(m: HashMap<String, String>) -> impl Fn(&str) -> Option<String> {
        move |k: &str| m.get(k).cloned()
    }

    #[test]
    fn an_environment_name_becomes_a_variable_prefix() {
        assert_eq!(prefix_for(Some("Dev")), "SAT_FILESTORE_DEV");
        // Spaces and punctuation are not valid in a variable name, so they become underscores
        // rather than silently producing a set nobody can export.
        assert_eq!(prefix_for(Some("Staging QA")), "SAT_FILESTORE_STAGING_QA");
        assert_eq!(prefix_for(Some("pre-prod.2")), "SAT_FILESTORE_PRE_PROD_2");
        // No environment selected is a real state — Env: None — and still needs somewhere
        // for files to go.
        assert_eq!(prefix_for(None), "SAT_FILESTORE");
        assert_eq!(prefix_for(Some("   ")), "SAT_FILESTORE");
    }

    #[test]
    fn every_set_in_the_environment_is_found_and_named_after_its_prefix() {
        // Several at once is the point: migrating from minio to a file service means having
        // both, and the name says which variables define each.
        let found = enumerate(&[
            ("SAT_FILESTORE_ENDPOINT".into(), "https://shared.example".into()),
            ("SAT_FILESTORE_DEV_ENDPOINT".into(), "http://127.0.0.1:9000".into()),
            ("SAT_FILESTORE_DEV_BUCKET".into(), "sat-fixtures".into()),
            // Not a store: no endpoint, so nothing to talk to.
            ("SAT_FILESTORE_STAGING_BUCKET".into(), "leftover".into()),
            // Nothing to do with us.
            ("DATABASE_URL".into(), "sqlite:x".into()),
            ("PATH".into(), "/usr/bin".into()),
        ]);
        let names: Vec<&str> = found.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, vec!["SAT_FILESTORE", "SAT_FILESTORE_DEV"]);
        // Sorted, so the picker's order does not depend on how the process received its
        // environment.
        assert_eq!(found[1].1.kind, StoreKind::S3);
        assert_eq!(found[1].1.bucket.as_deref(), Some("sat-fixtures"));
    }

    #[test]
    fn a_blank_endpoint_does_not_conjure_a_store() {
        assert!(enumerate(&[("SAT_FILESTORE_ENDPOINT".into(), "   ".into())]).is_empty());
        assert!(enumerate(&[]).is_empty());
    }

    #[test]
    fn nothing_configured_is_none_not_an_empty_store() {
        // The UI has to tell "no files" from "no store", so this cannot return a default.
        assert!(read(Some("Dev"), &lookup(vars(&[]))).is_none());
        // A leftover variable with no endpoint does not conjure one either.
        assert!(read(Some("Dev"), &lookup(vars(&[("SAT_FILESTORE_DEV_PREFIX", "x/")]))).is_none());
    }

    #[test]
    fn the_kind_is_inferred_from_the_shape_when_unstated() {
        let s3 = read(
            Some("Dev"),
            &lookup(vars(&[
                ("SAT_FILESTORE_DEV_ENDPOINT", "http://127.0.0.1:9000"),
                ("SAT_FILESTORE_DEV_BUCKET", "sat-fixtures"),
            ])),
        )
        .unwrap();
        assert_eq!(s3.kind, StoreKind::S3);

        let http = read(
            Some("Dev"),
            &lookup(vars(&[("SAT_FILESTORE_DEV_ENDPOINT", "https://files.internal")])),
        )
        .unwrap();
        assert_eq!(http.kind, StoreKind::Http);

        // An explicit KIND always wins over the guess.
        let forced = read(
            Some("Dev"),
            &lookup(vars(&[
                ("SAT_FILESTORE_DEV_ENDPOINT", "http://127.0.0.1:9000"),
                ("SAT_FILESTORE_DEV_BUCKET", "b"),
                ("SAT_FILESTORE_DEV_KIND", "http"),
            ])),
        )
        .unwrap();
        assert_eq!(forced.kind, StoreKind::Http);
    }

    #[test]
    fn the_reference_form_defaults_to_what_each_store_can_actually_deliver() {
        // minio: a key. A URL to an in-cluster minio is RFC1918, which is exactly what the
        // platform's SSRF guard rejects — so defaulting to a URL would default to broken.
        let s3 = read(
            Some("Dev"),
            &lookup(vars(&[
                ("SAT_FILESTORE_DEV_ENDPOINT", "http://127.0.0.1:9000"),
                ("SAT_FILESTORE_DEV_BUCKET", "b"),
            ])),
        )
        .unwrap();
        assert_eq!(s3.reference, Reference::Key);

        // A file service hands back its own URL, so that is its natural form.
        let http = read(
            Some("Dev"),
            &lookup(vars(&[("SAT_FILESTORE_DEV_ENDPOINT", "https://files.internal")])),
        )
        .unwrap();
        assert_eq!(http.reference, Reference::Url);

        // And it is overridable either way.
        let forced = read(
            Some("Dev"),
            &lookup(vars(&[
                ("SAT_FILESTORE_DEV_ENDPOINT", "http://127.0.0.1:9000"),
                ("SAT_FILESTORE_DEV_BUCKET", "b"),
                ("SAT_FILESTORE_DEV_REFERENCE", "URL"),
            ])),
        )
        .unwrap();
        assert_eq!(forced.reference, Reference::Url);
    }

    #[test]
    fn a_prefix_ends_in_one_slash_and_an_endpoint_in_none() {
        let cfg = read(
            Some("Dev"),
            &lookup(vars(&[
                ("SAT_FILESTORE_DEV_ENDPOINT", "http://127.0.0.1:9000/"),
                ("SAT_FILESTORE_DEV_PREFIX", "/fixtures/"),
            ])),
        )
        .unwrap();
        // Otherwise keys come out as `fixtures//nums.csv` or `fixturesnums.csv`, and the
        // second one is a different object that happens to look right in a log.
        assert_eq!(cfg.prefix, "fixtures/");
        assert_eq!(cfg.endpoint, "http://127.0.0.1:9000");

        let bare = read(
            Some("Dev"),
            &lookup(vars(&[("SAT_FILESTORE_DEV_ENDPOINT", "http://h")])),
        )
        .unwrap();
        assert_eq!(bare.prefix, "");
    }

    #[test]
    fn missing_pieces_are_named_as_variables_to_export() {
        let cfg = read(
            Some("Dev"),
            &lookup(vars(&[
                ("SAT_FILESTORE_DEV_ENDPOINT", "http://127.0.0.1:9000"),
                ("SAT_FILESTORE_DEV_KIND", "s3"),
            ])),
        )
        .unwrap();
        // The author's next action is an export, so the message is a list of variables.
        assert_eq!(
            cfg.missing(Some("Dev")),
            vec![
                "SAT_FILESTORE_DEV_BUCKET",
                "SAT_FILESTORE_DEV_ACCESS_KEY",
                "SAT_FILESTORE_DEV_SECRET_KEY"
            ]
        );

        // A file service with no auth is complete, not half-configured.
        let http = read(
            Some("Dev"),
            &lookup(vars(&[("SAT_FILESTORE_DEV_ENDPOINT", "https://files.internal")])),
        )
        .unwrap();
        assert!(http.missing(Some("Dev")).is_empty());
    }

    #[test]
    fn the_label_never_carries_a_credential() {
        let cfg = read(
            Some("Dev"),
            &lookup(vars(&[
                ("SAT_FILESTORE_DEV_ENDPOINT", "http://127.0.0.1:9000"),
                ("SAT_FILESTORE_DEV_BUCKET", "sat-fixtures"),
                ("SAT_FILESTORE_DEV_ACCESS_KEY", "minioadmin"),
                ("SAT_FILESTORE_DEV_SECRET_KEY", "supersecret"),
            ])),
        )
        .unwrap();
        let label = cfg.label();
        assert_eq!(label, "minio · sat-fixtures @ 127.0.0.1:9000");
        // It is shown in the UI and logged, so this is the assertion that matters.
        assert!(!label.contains("supersecret"));
        assert!(!label.contains("minioadmin"));
    }
}
