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

/// Result of a post-test/assertion script: its verdict plus any SAT.vars
/// (transient) and SAT.env (persisted) writes it performed — side effects apply
/// even when the verdict is false, or when there is no verdict at all.
#[derive(Debug)]
pub struct AssertionOutcome {
    /// The script's last expression, when it was a boolean. `None` when the script
    /// ends in something else (e.g. an assignment) — legitimate for a script whose
    /// job is only to capture values, with the verdict coming from elsewhere.
    pub passed: Option<bool>,
    pub vars: HashMap<String, Value>,
    pub env: HashMap<String, Value>,
    /// Whatever the script printed, in order — surfaced in the run's log.
    pub output: Vec<String>,
}

/// Everything an assertion script can read. A struct rather than positional
/// arguments because `script`/`body` are both &str and `env`/`data` are both
/// maps — swapping either pair would compile and fail silently.
pub struct AssertionInput<'a> {
    pub script: &'a str,
    pub status: u16,
    pub body: &'a str,
    pub json: &'a Option<Value>,
    pub headers: &'a HashMap<String, String>,
    /// Current environment, readable and writable as `SAT.env.*`.
    pub env: &'a HashMap<String, Value>,
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

        // Send print()/debug() to the run's log instead of the server's stdout.
        super::script_log::capture(&mut engine);

        Self { engine }
    }

    /// Evaluate a post-test/assertion script.
    /// The last expression is the pass/fail boolean; `SAT.env.x = …` writes are
    /// captured as side-effects (applied even when the assertion returns false).
    pub fn evaluate(&self, input: AssertionInput<'_>) -> Result<AssertionOutcome, AppError> {
        let AssertionInput { script, status, body, json, headers, env: env_in } = input;
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

        // Rewrite SAT.env. → env., SAT.vars. → vars.
        let rewritten = script
            .replace("SAT.env.", "env.")
            .replace("SAT.vars.", "vars.");

        // Evaluated as a Dynamic rather than a bool: a script may exist purely for
        // its side effects (capturing values into SAT.env), in which case its last
        // expression isn't a verdict. The caller decides whether it needed one.
        super::script_log::start();
        let value = match self.engine.eval_with_scope::<Dynamic>(&mut scope, &rewritten) {
            Ok(v) => v,
            Err(e) => {
                // Bare Rhai message; the caller says which script and what it means.
                // Anything printed before the throw is kept — that's the debugging
                // aid the author reached for — as is advice for a JS habit.
                let mut message = e.to_string();
                if let Some(hint) = super::script_log::hint_for(&message) {
                    message.push_str("  ");
                    message.push_str(hint);
                }
                let printed = super::script_log::take();
                if !printed.is_empty() {
                    message.push_str(&format!("  [printed: {}]", printed.join(" | ")));
                }
                return Err(AppError::AssertionError(message));
            }
        };
        let output = super::script_log::take();
        let passed = value.try_cast::<bool>();

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

        Ok(AssertionOutcome { passed, vars, env, output })
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

        let result = engine.evaluate(AssertionInput {
            script: "response.status == 200",
            status: 200,
            body: "",
            json: &None,
            headers: &headers,
            env: &HashMap::new(),
        }).unwrap().passed.unwrap();
        assert!(result);

        let result = engine.evaluate(AssertionInput {
            script: "response.status == 200",
            status: 404,
            body: "",
            json: &None,
            headers: &headers,
            env: &HashMap::new(),
        }).unwrap().passed.unwrap();
        assert!(!result);
    }

    #[test]
    fn test_json_field_check() {
        let engine = AssertionEngine::new();
        let headers = HashMap::new();
        let json = make_json(r#"{"success": true, "data": {"id": 42}}"#);

        let result = engine.evaluate(AssertionInput {
            script: "response.json.success == true",
            status: 200,
            body: "",
            json: &json,
            headers: &headers,
            env: &HashMap::new(),
        }).unwrap().passed.unwrap();
        assert!(result);

        let result = engine.evaluate(AssertionInput {
            script: "response.json.data.id == 42",
            status: 200,
            body: "",
            json: &json,
            headers: &headers,
            env: &HashMap::new(),
        }).unwrap().passed.unwrap();
        assert!(result);
    }

    #[test]
    fn test_array_check() {
        let engine = AssertionEngine::new();
        let headers = HashMap::new();
        let json = make_json(r#"{"items": [1, 2, 3]}"#);

        let result = engine.evaluate(AssertionInput {
            script: "response.json.items.len() == 3",
            status: 200,
            body: "",
            json: &json,
            headers: &headers,
            env: &HashMap::new(),
        }).unwrap().passed.unwrap();
        assert!(result);
    }

    #[test]
    fn test_string_contains() {
        let engine = AssertionEngine::new();
        let headers = HashMap::new();
        let json = make_json(r#"{"message": "User created successfully"}"#);

        let result = engine.evaluate(AssertionInput {
            script: r#"response.json.message.contains("created")"#,
            status: 201,
            body: "",
            json: &json,
            headers: &headers,
            env: &HashMap::new(),
        }).unwrap().passed.unwrap();
        assert!(result);
    }

    #[test]
    fn test_complex_assertion() {
        let engine = AssertionEngine::new();
        let headers = HashMap::new();
        let json = make_json(r#"{"user": {"email": "test@example.com", "id": 123}}"#);

        let result = engine.evaluate(AssertionInput {
            script: r#"response.status == 200 && response.json.user.email.contains("@") && response.json.user.id > 0"#,
            status: 200,
            body: "",
            json: &json,
            headers: &headers,
            env: &HashMap::new(),
        }).unwrap().passed.unwrap();
        assert!(result);
    }

    #[test]
    fn test_script_without_a_verdict_still_reports_its_writes() {
        // A post-test script often exists only to capture values, ending in an
        // assignment rather than a boolean. That must not be an error, and the
        // writes must survive — the verdict can come from the row's status instead.
        let engine = AssertionEngine::new();
        let outcome = engine
            .evaluate(AssertionInput {
                script: r#"SAT.env.token = "abc"; SAT.vars.uid = 7;"#,
                status: 201,
                body: "",
                json: &None,
                headers: &HashMap::new(),
                env: &HashMap::new(),
            })
            .unwrap();

        assert_eq!(outcome.passed, None, "an assignment is not a verdict");
        assert_eq!(outcome.env.get("token"), Some(&Value::String("abc".into())));
        assert_eq!(outcome.vars.get("uid"), Some(&Value::Number(7.into())));
    }

    #[test]
    fn test_script_ending_in_a_boolean_yields_a_verdict() {
        let engine = AssertionEngine::new();
        let outcome = engine
            .evaluate(AssertionInput {
                script: r#"SAT.env.token = "abc"; response.status == 201"#,
                status: 201,
                body: "",
                json: &None,
                headers: &HashMap::new(),
                env: &HashMap::new(),
            })
            .unwrap();

        assert_eq!(outcome.passed, Some(true));
        assert_eq!(outcome.env.get("token"), Some(&Value::String("abc".into())));
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
