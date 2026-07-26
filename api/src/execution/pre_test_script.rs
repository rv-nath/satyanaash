//! Rhai-based pre-test script engine
//!
//! Executes scripts before HTTP requests. Scripts can set variables
//! via `SAT.vars.variableName = "value"` which are then available
//! for {{variableName}} interpolation in URLs, headers, and payloads.

use rhai::{Engine, Scope, Dynamic, Map};
use std::collections::HashMap;
use serde_json::Value;

use crate::error::AppError;

/// What a pre-test script produced: transient run vars (SAT.vars, this run only)
/// and environment writes (SAT.env, persisted to the active environment).
#[derive(Debug, Default)]
pub struct PreTestOutcome {
    pub vars: HashMap<String, Value>,
    pub env: HashMap<String, Value>,
}

/// Pre-test script engine using Rhai for variable setup
pub struct PreTestScriptEngine {
    engine: Engine,
}

impl PreTestScriptEngine {
    /// Create a new pre-test script engine with sandbox limits
    pub fn new() -> Self {
        let mut engine = Engine::new();

        // Sandbox limits matching AssertionEngine
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

    /// Execute a pre-test script.
    ///
    /// Rhai can't mutate a nested map in place, so we expose `vars` and `env` as
    /// top-level mutable maps and rewrite `SAT.vars.` / `SAT.env.` references.
    /// `SAT.vars` is transient (this run); `SAT.env` writes get persisted.
    /// Only genuinely new/changed `env` keys are returned (diffed against `env_in`).
    pub fn execute(
        &self,
        script: &str,
        env_in: &HashMap<String, Value>,
        data: &HashMap<String, Value>,
    ) -> Result<PreTestOutcome, AppError> {
        let mut scope = Scope::new();

        // `vars` — a fresh mutable map for transient values
        scope.push("vars", Map::new());

        // `env` — seeded with the current environment so scripts can read existing values
        let mut env_map = Map::new();
        for (k, v) in env_in {
            env_map.insert(k.as_str().into(), json_to_rhai(v));
        }
        scope.push("env", env_map);

        // `data` is the current data row — read-only, never read back out.
        let mut data_map = Map::new();
        for (k, v) in data {
            data_map.insert(k.as_str().into(), json_to_rhai(v));
        }
        scope.push("data", data_map);

        // Rewrite SAT.env.xxx → env.xxx and SAT.vars.xxx → vars.xxx
        let rewritten = script
            .replace("SAT.env.", "env.")
            .replace("SAT.vars.", "vars.")
            .replace("SAT.data.", "data.");

        // Run the script (we only care about side effects on `vars` / `env`)
        self.engine.run_with_scope(&mut scope, &rewritten)
            .map_err(|e| AppError::Internal(format!("Pre-test script error: {}", e)))?;

        let vars_map: Map = scope.get_value("vars").unwrap_or_default();
        let env_out: Map = scope.get_value("env").unwrap_or_default();

        let mut outcome = PreTestOutcome::default();
        for (k, v) in vars_map {
            outcome.vars.insert(k.to_string(), rhai_to_json(&v));
        }
        // Only return env keys the script actually added or changed
        for (k, v) in env_out {
            let json = rhai_to_json(&v);
            let key = k.to_string();
            if env_in.get(&key) != Some(&json) {
                outcome.env.insert(key, json);
            }
        }
        Ok(outcome)
    }
}

/// Convert serde_json::Value to a Rhai Dynamic (for seeding the session map).
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
            let a: rhai::Array = arr.iter().map(json_to_rhai).collect();
            Dynamic::from(a)
        }
        Value::Object(obj) => {
            let mut m = Map::new();
            for (k, v) in obj {
                m.insert(k.as_str().into(), json_to_rhai(v));
            }
            Dynamic::from(m)
        }
    }
}

impl Default for PreTestScriptEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// Convert a Rhai Dynamic value to serde_json::Value
fn rhai_to_json(dynamic: &Dynamic) -> Value {
    if dynamic.is_unit() {
        Value::Null
    } else if let Some(s) = dynamic.clone().try_cast::<rhai::ImmutableString>() {
        Value::String(s.to_string())
    } else if let Some(i) = dynamic.clone().try_cast::<i64>() {
        Value::Number(i.into())
    } else if let Some(f) = dynamic.clone().try_cast::<f64>() {
        serde_json::Number::from_f64(f)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    } else if let Some(b) = dynamic.clone().try_cast::<bool>() {
        Value::Bool(b)
    } else if let Some(arr) = dynamic.clone().try_cast::<rhai::Array>() {
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

    fn empty() -> HashMap<String, Value> { HashMap::new() }

    #[test]
    fn test_simple_var_assignment() {
        let engine = PreTestScriptEngine::new();
        let out = engine.execute(r#"SAT.vars.baseUrl = "http://localhost:3000";"#, &empty(), &HashMap::new()).unwrap();
        assert_eq!(out.vars.get("baseUrl"), Some(&Value::String("http://localhost:3000".to_string())));
    }

    #[test]
    fn test_multiple_vars() {
        let engine = PreTestScriptEngine::new();
        let out = engine.execute(r#"
            SAT.vars.baseUrl = "http://localhost:3000";
            SAT.vars.apiKey = "secret123";
            SAT.vars.timeout = 5000;
        "#, &empty(), &HashMap::new()).unwrap();
        assert_eq!(out.vars.get("baseUrl"), Some(&Value::String("http://localhost:3000".to_string())));
        assert_eq!(out.vars.get("apiKey"), Some(&Value::String("secret123".to_string())));
        assert_eq!(out.vars.get("timeout"), Some(&Value::Number(5000.into())));
    }

    #[test]
    fn test_computed_var() {
        let engine = PreTestScriptEngine::new();
        let out = engine.execute(r#"
            let base = "http://localhost";
            let port = 8080;
            SAT.vars.url = base + ":" + port.to_string();
        "#, &empty(), &HashMap::new()).unwrap();
        assert_eq!(out.vars.get("url"), Some(&Value::String("http://localhost:8080".to_string())));
    }

    #[test]
    fn test_empty_script() {
        let engine = PreTestScriptEngine::new();
        let out = engine.execute("", &empty(), &HashMap::new()).unwrap();
        assert!(out.vars.is_empty());
        assert!(out.env.is_empty());
    }

    #[test]
    fn test_direct_vars_syntax() {
        let engine = PreTestScriptEngine::new();
        let out = engine.execute(r#"vars.baseUrl = "http://localhost:3000";"#, &empty(), &HashMap::new()).unwrap();
        assert_eq!(out.vars.get("baseUrl"), Some(&Value::String("http://localhost:3000".to_string())));
    }

    #[test]
    fn test_script_error() {
        let engine = PreTestScriptEngine::new();
        let result = engine.execute("this is not valid rhai", &empty(), &HashMap::new());
        assert!(result.is_err());
    }

    #[test]
    fn test_env_write_and_read_diff() {
        let engine = PreTestScriptEngine::new();
        let mut seed = HashMap::new();
        seed.insert("existing".to_string(), Value::String("v1".to_string()));
        let out = engine.execute(
            r#"SAT.env.token = "abc"; SAT.env.copied = SAT.env.existing;"#,
            &seed,
            &HashMap::new(),
        ).unwrap();
        // Only new/changed keys are returned — not the untouched seed value
        assert_eq!(out.env.get("token"), Some(&Value::String("abc".to_string())));
        assert_eq!(out.env.get("copied"), Some(&Value::String("v1".to_string())));
        assert_eq!(out.env.get("existing"), None);
    }

    #[test]
    fn test_generator_functions() {
        let engine = PreTestScriptEngine::new();
        let out = engine
            .execute(r#"SAT.vars.n = randomInt(5, 5); SAT.vars.u = randomUsername();"#, &empty(), &HashMap::new())
            .unwrap();
        assert_eq!(out.vars.get("n"), Some(&Value::Number(5.into())));
        assert!(matches!(out.vars.get("u"), Some(Value::String(s)) if s.starts_with("user_")));
    }
}
