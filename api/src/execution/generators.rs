//! Random / dynamic data generators.
//!
//! The same generators are reachable two ways:
//! - as `{{$Macros}}` in interpolation (see `variables.rs`), and
//! - as callable Rhai functions in pre-test / assertion scripts (registered here),
//!   e.g. `SAT.vars.phone = randomPhone();`.

use rhai::{Engine, ImmutableString};

use super::variables::{rand_simple, generate_random_string, generate_random_password};

/// Register generator functions on a Rhai engine.
pub fn register(engine: &mut Engine) {
    engine.register_fn("randomEmail", || bharat_cafe::random_email(None));
    engine.register_fn("randomEmail", |domain: ImmutableString| {
        bharat_cafe::random_email(Some(domain.as_str()))
    });
    engine.register_fn("randomName", || bharat_cafe::random_name());
    engine.register_fn("randomCompany", || bharat_cafe::generate_company_name());
    engine.register_fn("randomPhone", || bharat_cafe::random_phone());
    engine.register_fn("randomAddress", || bharat_cafe::random_address());
    engine.register_fn("randomUsername", || {
        format!("user_{}", generate_random_string(8).to_lowercase())
    });
    engine.register_fn("randomString", || generate_random_string(10));
    engine.register_fn("randomString", |len: i64| generate_random_string(len.max(0) as usize));
    engine.register_fn("randomPassword", || generate_random_password(16));
    engine.register_fn("randomPassword", |len: i64| generate_random_password(len.max(0) as usize));
    engine.register_fn("randomInt", || rand_simple() % 1000);
    engine.register_fn("randomInt", |min: i64, max: i64| {
        if max <= min {
            min
        } else {
            min + (rand_simple() % (max - min + 1))
        }
    });
    engine.register_fn("uuid", || uuid::Uuid::new_v4().to_string());
    engine.register_fn("timestamp", || chrono::Utc::now().timestamp());
    engine.register_fn("timestampMs", || chrono::Utc::now().timestamp_millis());
    engine.register_fn("isoDate", || chrono::Utc::now().to_rfc3339());
    // Not random, but the one encoding a script can't express itself: without it
    // there is no way to build a Basic auth header from a username and password.
    engine.register_fn("base64Encode", |s: ImmutableString| {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(s.as_bytes())
    });
}

#[cfg(test)]
mod tests {
    use super::super::pre_test_script::PreTestScriptEngine;
    use serde_json::Value;
    use std::collections::HashMap;

    /// Every pre-test snippet offered in the GUI, verbatim from
    /// `gui-lov/src/lib/testSnippets.ts`. They used to be JavaScript — `btoa`,
    /// `crypto.randomUUID()`, `new Date()` — none of which Rhai has, so pasting one
    /// failed. Pin them here: a snippet that doesn't run is worse than no snippet.
    const GUI_SNIPPETS: &[(&str, &str)] = &[
        ("bearer header", r#"SAT.vars.authHeader = "Bearer " + SAT.env.authToken;"#),
        (
            "basic auth",
            r#"SAT.vars.authHeader = "Basic " + base64Encode(SAT.env.username + ":" + SAT.env.password);"#,
        ),
        ("unique id", "SAT.vars.uniqueId = uuid();"),
        (
            "timestamps",
            "SAT.vars.createdAt = isoDate();\nSAT.vars.epoch = timestamp();\nSAT.vars.epochMs = timestampMs();",
        ),
        ("random email", "SAT.vars.testEmail = randomEmail();"),
        (
            "signup identity",
            "SAT.vars.myName = randomName();\nSAT.vars.myEmail = randomEmail();\n\
             SAT.vars.myPhone = randomPhone();\nSAT.vars.myCompany = randomCompany();\n\
             SAT.vars.myPassword = randomPassword(16);",
        ),
        (
            "string and number",
            "SAT.vars.suffix = randomString(8);\nSAT.vars.amount = randomInt(100, 9999);",
        ),
        ("persisted value", "SAT.env.deviceId = uuid();"),
    ];

    fn seeded() -> HashMap<String, Value> {
        let mut env = HashMap::new();
        for k in ["authToken", "username", "password"] {
            env.insert(k.to_string(), Value::String(format!("{}-value", k)));
        }
        env
    }

    #[test]
    fn every_gui_snippet_runs() {
        let engine = PreTestScriptEngine::new();
        for (label, code) in GUI_SNIPPETS {
            let out = engine
                .execute(code, &seeded())
                .unwrap_or_else(|e| panic!("snippet {:?} failed: {}", label, e));
            assert!(
                !out.vars.is_empty() || !out.env.is_empty(),
                "snippet {:?} set nothing",
                label
            );
        }
    }

    #[test]
    fn base64_encode_builds_a_basic_auth_header() {
        let engine = PreTestScriptEngine::new();
        let out = engine
            .execute(
                r#"SAT.vars.h = "Basic " + base64Encode("aladdin:opensesame");"#,
                &HashMap::new(),
            )
            .unwrap();
        // The value a server would decode back to "aladdin:opensesame".
        assert_eq!(
            out.vars.get("h"),
            Some(&Value::String("Basic YWxhZGRpbjpvcGVuc2VzYW1l".to_string()))
        );
    }

    #[test]
    fn generators_vary_between_calls() {
        let engine = PreTestScriptEngine::new();
        let out = engine
            .execute("SAT.vars.a = uuid();\nSAT.vars.b = uuid();", &HashMap::new())
            .unwrap();
        assert_ne!(out.vars.get("a"), out.vars.get("b"));
    }

    #[test]
    fn random_int_respects_its_range() {
        let engine = PreTestScriptEngine::new();
        for _ in 0..25 {
            let out = engine
                .execute("SAT.vars.n = randomInt(10, 12);", &HashMap::new())
                .unwrap();
            let n = out.vars.get("n").and_then(|v| v.as_i64()).expect("a number");
            assert!((10..=12).contains(&n), "randomInt gave {}", n);
        }
    }
}
