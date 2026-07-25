//! Rhai-based assertion engine for evaluating test assertions
//!
//! The `response` object is exposed to scripts with:
//! - response.status (HTTP status code)
//! - response.body (raw response body string)
//! - response.json (parsed JSON as dynamic map)
//! - response.headers (response headers map)

use rhai::{Engine, Scope, Dynamic, Map, Array};
use serde_json::Value;

use std::collections::HashMap;

use crate::error::AppError;

/// Result of a post-test/assertion script: the pass/fail boolean plus any
/// SAT.vars (transient) and SAT.env (persisted) writes the script performed
/// (side-effects, applied even when the assertion returns false).
#[derive(Debug)]
pub struct AssertionOutcome {
    pub passed: bool,
    pub vars: HashMap<String, Value>,
    pub env: HashMap<String, Value>,
}

/// Assertion engine using Rhai for script evaluation
pub struct AssertionEngine {
    engine: Engine,
}

impl AssertionEngine {
    /// Create a new assertion engine
    pub fn new() -> Self {
        let mut engine = Engine::new();

        // Disable potentially dangerous features for sandboxing
        engine.set_max_expr_depths(64, 64);
        engine.set_max_call_levels(32);
        engine.set_max_operations(10_000);
        engine.set_max_string_size(1_000_000);
        engine.set_max_array_size(10_000);
        engine.set_max_map_size(10_000);

        // Expose randomEmail(), randomPhone(), randomInt(min,max), etc.
        super::generators::register(&mut engine);

        Self { engine }
    }

    /// Evaluate a post-test/assertion script.
    /// The last expression is the pass/fail boolean; `SAT.env.x = …` writes are
    /// captured as side-effects (applied even when the assertion returns false).
    pub fn evaluate(
        &self,
        script: &str,
        status: u16,
        body: &str,
        json: &Option<Value>,
        headers: &HashMap<String, String>,
        env_in: &HashMap<String, Value>,
    ) -> Result<AssertionOutcome, AppError> {
        let mut scope = Scope::new();

        // Build response object
        let mut response = Map::new();
        response.insert("status".into(), Dynamic::from(status as i64));
        response.insert("body".into(), Dynamic::from(body.to_string()));

        if let Some(json_val) = json {
            response.insert("json".into(), json_to_rhai(json_val));
        } else {
            response.insert("json".into(), Dynamic::UNIT);
        }

        // Convert headers to Rhai map
        let mut headers_map = Map::new();
        for (k, v) in headers {
            headers_map.insert(k.clone().into(), Dynamic::from(v.clone()));
        }
        response.insert("headers".into(), Dynamic::from(headers_map));

        scope.push("response", response);

        // Expose `env`, seeded with the current environment so scripts can read + write
        let mut env_map = Map::new();
        for (k, v) in env_in {
            env_map.insert(k.as_str().into(), json_to_rhai(v));
        }
        scope.push("env", env_map);

        // `vars` — a fresh mutable map for transient (this-run) values
        scope.push("vars", Map::new());

        // Rewrite SAT.env. → env. and SAT.vars. → vars. (side-effects run as the script does)
        let rewritten = script.replace("SAT.env.", "env.").replace("SAT.vars.", "vars.");

        // Evaluate: last expression is the pass/fail boolean; var/env writes are side-effects
        let passed = match self.engine.eval_with_scope::<bool>(&mut scope, &rewritten) {
            Ok(result) => result,
            Err(e) => return Err(AppError::AssertionError(format!("Assertion script error: {}", e))),
        };

        // Read back writes (applied even if `passed` is false)
        let vars_out: Map = scope.get_value("vars").unwrap_or_default();
        let mut vars = HashMap::new();
        for (k, v) in vars_out {
            vars.insert(k.to_string(), rhai_to_json(&v));
        }

        let env_out: Map = scope.get_value("env").unwrap_or_default();
        let mut env = HashMap::new();
        for (k, v) in env_out {
            let json = rhai_to_json(&v);
            let key = k.to_string();
            if env_in.get(&key) != Some(&json) {
                env.insert(key, json);
            }
        }

        Ok(AssertionOutcome { passed, vars, env })
    }

    /// Default assertion: pass if status is 2xx
    pub fn default_assertion(status: u16) -> bool {
        (200..300).contains(&status)
    }
}

impl Default for AssertionEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// Convert JSON Value to Rhai Dynamic type
fn json_to_rhai(value: &Value) -> Dynamic {
    match value {
        Value::Null => Dynamic::UNIT,
        Value::Bool(b) => Dynamic::from(*b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Dynamic::from(i)
            } else if let Some(f) = n.as_f64() {
                Dynamic::from(f)
            } else {
                Dynamic::UNIT
            }
        }
        Value::String(s) => Dynamic::from(s.clone()),
        Value::Array(arr) => {
            let rhai_arr: Array = arr.iter().map(json_to_rhai).collect();
            Dynamic::from(rhai_arr)
        }
        Value::Object(obj) => {
            let mut map = Map::new();
            for (k, v) in obj {
                map.insert(k.clone().into(), json_to_rhai(v));
            }
            Dynamic::from(map)
        }
    }
}

/// Convert a Rhai Dynamic value back to serde_json::Value (for session write-back).
fn rhai_to_json(dynamic: &Dynamic) -> Value {
    if dynamic.is_unit() {
        Value::Null
    } else if let Some(s) = dynamic.clone().try_cast::<rhai::ImmutableString>() {
        Value::String(s.to_string())
    } else if let Some(i) = dynamic.clone().try_cast::<i64>() {
        Value::Number(i.into())
    } else if let Some(f) = dynamic.clone().try_cast::<f64>() {
        serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null)
    } else if let Some(b) = dynamic.clone().try_cast::<bool>() {
        Value::Bool(b)
    } else if let Some(arr) = dynamic.clone().try_cast::<Array>() {
        Value::Array(arr.iter().map(rhai_to_json).collect())
    } else if let Some(map) = dynamic.clone().try_cast::<Map>() {
        let obj: serde_json::Map<String, Value> = map.iter()
            .map(|(k, v)| (k.to_string(), rhai_to_json(v)))
            .collect();
        Value::Object(obj)
    } else {
        Value::String(dynamic.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn make_json(s: &str) -> Option<Value> {
        serde_json::from_str(s).ok()
    }

    #[test]
    fn test_simple_status_check() {
        let engine = AssertionEngine::new();
        let headers = HashMap::new();

        let result = engine.evaluate(
            "response.status == 200",
            200,
            "",
            &None,
            &headers,
            &HashMap::new(),
        ).unwrap().passed;
        assert!(result);

        let result = engine.evaluate(
            "response.status == 200",
            404,
            "",
            &None,
            &headers,
            &HashMap::new(),
        ).unwrap().passed;
        assert!(!result);
    }

    #[test]
    fn test_json_field_check() {
        let engine = AssertionEngine::new();
        let headers = HashMap::new();
        let json = make_json(r#"{"success": true, "data": {"id": 42}}"#);

        let result = engine.evaluate(
            "response.json.success == true",
            200,
            "",
            &json,
            &headers,
            &HashMap::new(),
        ).unwrap().passed;
        assert!(result);

        let result = engine.evaluate(
            "response.json.data.id == 42",
            200,
            "",
            &json,
            &headers,
            &HashMap::new(),
        ).unwrap().passed;
        assert!(result);
    }

    #[test]
    fn test_array_check() {
        let engine = AssertionEngine::new();
        let headers = HashMap::new();
        let json = make_json(r#"{"items": [1, 2, 3]}"#);

        let result = engine.evaluate(
            "response.json.items.len() == 3",
            200,
            "",
            &json,
            &headers,
            &HashMap::new(),
        ).unwrap().passed;
        assert!(result);
    }

    #[test]
    fn test_string_contains() {
        let engine = AssertionEngine::new();
        let headers = HashMap::new();
        let json = make_json(r#"{"message": "User created successfully"}"#);

        let result = engine.evaluate(
            r#"response.json.message.contains("created")"#,
            201,
            "",
            &json,
            &headers,
            &HashMap::new(),
        ).unwrap().passed;
        assert!(result);
    }

    #[test]
    fn test_complex_assertion() {
        let engine = AssertionEngine::new();
        let headers = HashMap::new();
        let json = make_json(r#"{"user": {"email": "test@example.com", "id": 123}}"#);

        let result = engine.evaluate(
            r#"response.status == 200 && response.json.user.email.contains("@") && response.json.user.id > 0"#,
            200,
            "",
            &json,
            &headers,
            &HashMap::new(),
        ).unwrap().passed;
        assert!(result);
    }

    #[test]
    fn test_default_assertion() {
        assert!(AssertionEngine::default_assertion(200));
        assert!(AssertionEngine::default_assertion(201));
        assert!(AssertionEngine::default_assertion(299));
        assert!(!AssertionEngine::default_assertion(400));
        assert!(!AssertionEngine::default_assertion(500));
    }
}
