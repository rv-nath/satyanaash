//! Variable interpolation and execution context management
//!
//! Resolution order (highest priority first):
//! 0. Data-row variables (the current data-driven iteration's cells)
//! 1. Execution variables (passed in execute request)
//! 2. Context variables (exports from previous test cases + pre-test script vars)
//! 3. Node input variables (static per-node overrides set in flow editor)
//! 4. Flow variables (scoped to the flow)
//! 5. Environment variables (from project settings)
//! 6. Built-in variables ($UUID, $Timestamp, etc.)

use std::collections::HashMap;
use regex::Regex;
use serde_json::Value;
use chrono::Utc;
use uuid::Uuid;

use crate::error::AppError;

/// Execution context that holds all variables during flow execution
#[derive(Debug, Clone)]
pub struct ExecutionContext {
    /// Cells of the data row being run right now. Highest priority: a row's value
    /// is the explicit input for that iteration, so it must beat exports, script
    /// vars and the environment. Empty for a normal (non-data-driven) run.
    row_vars: HashMap<String, Value>,
    /// Variables passed in the execute request
    execution_vars: HashMap<String, Value>,
    /// Accumulated exports from test cases during execution
    context: HashMap<String, Value>,
    /// Static per-node input variables (replaced before each node runs)
    node_input_vars: HashMap<String, Value>,
    /// Flow-scoped variables
    flow_vars: HashMap<String, Value>,
    /// Environment variables from project settings
    environment: HashMap<String, Value>,
}

impl ExecutionContext {
    /// Create a new execution context
    pub fn new(
        execution_vars: HashMap<String, Value>,
        environment: HashMap<String, Value>,
        flow_vars: HashMap<String, Value>,
    ) -> Self {
        Self {
            row_vars: HashMap::new(),
            execution_vars,
            context: HashMap::new(),
            node_input_vars: HashMap::new(),
            flow_vars,
            environment,
        }
    }

    /// Replace the current iteration's row values (wholesale, like node input vars).
    pub fn set_row_vars(&mut self, vars: HashMap<String, Value>) {
        self.row_vars = vars;
    }

    /// Set an environment variable at run time (from SAT.env writes in scripts).
    /// Available immediately as {{name}} for the rest of this run.
    pub fn set_environment_var(&mut self, name: &str, value: Value) {
        self.environment.insert(name.to_string(), value);
    }

    /// A copy of the current environment — passed into scripts so `SAT.env.x`
    /// can read existing values.
    pub fn environment_snapshot(&self) -> HashMap<String, Value> {
        self.environment.clone()
    }

    /// Set node input variables (fully replaces previous node's vars)
    pub fn set_node_input_vars(&mut self, vars: HashMap<String, Value>) {
        self.node_input_vars = vars;
    }

    /// Resolve a variable by name using the resolution order
    pub fn resolve(&self, name: &str) -> Option<&Value> {
        self.row_vars.get(name)
            .or_else(|| self.execution_vars.get(name))
            .or_else(|| self.context.get(name))
            .or_else(|| self.node_input_vars.get(name))
            .or_else(|| self.flow_vars.get(name))
            .or_else(|| self.environment.get(name))
    }

    /// Set a context variable (from test case exports)
    pub fn set(&mut self, name: &str, value: Value) {
        self.context.insert(name.to_string(), value);
    }

    /// Get all context variables (accumulated exports)
    pub fn get_context(&self) -> &HashMap<String, Value> {
        &self.context
    }

    /// Interpolate variables in a string template
    /// Syntax: {{variableName}} or {{$BuiltIn}}
    pub fn interpolate(&self, template: &str) -> Result<String, AppError> {
        let re = Regex::new(r"\{\{(\$?[\w]+)(?:\(([^)]*)\))?\}\}")
            .map_err(|e| AppError::Internal(format!("Regex error: {}", e)))?;

        let result = re.replace_all(template, |caps: &regex::Captures| {
            let name = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            let args = caps.get(2).map(|m| m.as_str());

            if name.starts_with('$') {
                // Built-in variable
                self.generate_builtin(name, args)
            } else {
                // Regular variable
                match self.resolve(name) {
                    Some(value) => value_to_string(value),
                    None => format!("{{{{{}}}}}", name), // Keep as-is if not found
                }
            }
        });

        Ok(result.to_string())
    }

    /// Interpolate variables in a JSON value
    pub fn interpolate_json(&self, value: &Value) -> Result<Value, AppError> {
        match value {
            Value::String(s) => {
                let interpolated = self.interpolate(s)?;
                // Try to parse as JSON in case it was a number/bool placeholder
                match serde_json::from_str(&interpolated) {
                    Ok(v) => Ok(v),
                    Err(_) => Ok(Value::String(interpolated)),
                }
            }
            Value::Object(map) => {
                let mut result = serde_json::Map::new();
                for (k, v) in map {
                    let key = self.interpolate(k)?;
                    let value = self.interpolate_json(v)?;
                    result.insert(key, value);
                }
                Ok(Value::Object(result))
            }
            Value::Array(arr) => {
                let result: Result<Vec<Value>, AppError> = arr.iter()
                    .map(|v| self.interpolate_json(v))
                    .collect();
                Ok(Value::Array(result?))
            }
            // Other types pass through unchanged
            _ => Ok(value.clone()),
        }
    }

    /// Generate a built-in variable value
    fn generate_builtin(&self, name: &str, args: Option<&str>) -> String {
        match name {
            "$UUID" => Uuid::new_v4().to_string(),
            "$Timestamp" => Utc::now().timestamp().to_string(),
            "$TimestampMs" => Utc::now().timestamp_millis().to_string(),
            "$ISODate" => Utc::now().to_rfc3339(),
            "$RandomEmail" => bharat_cafe::random_email(args),
            "$RandomInt" => {
                if let Some(args) = args {
                    let parts: Vec<&str> = args.split(',').collect();
                    if parts.len() == 2 {
                        if let (Ok(min), Ok(max)) = (parts[0].trim().parse::<i64>(), parts[1].trim().parse::<i64>()) {
                            return (min + (rand_simple() % (max - min + 1))).to_string();
                        }
                    }
                }
                (rand_simple() % 1000).to_string()
            }
            "$RandomString" => {
                let len = args.and_then(|a| a.parse::<usize>().ok()).unwrap_or(10);
                generate_random_string(len)
            }
            "$RandomPassword" => {
                let len = args.and_then(|a| a.parse::<usize>().ok()).unwrap_or(16);
                generate_random_password(len)
            }
            "$RandomUsername" => {
                format!("user_{}", generate_random_string(8).to_lowercase())
            }
            "$RandomName" => bharat_cafe::random_name(),
            "$RandomPhone" => bharat_cafe::random_phone(),
            "$RandomAddress" => bharat_cafe::random_address(),
            "$RandomCompany" => bharat_cafe::generate_company_name(),
            _ => format!("{{{{{}}}}}", name), // Unknown built-in, keep as-is
        }
    }
}

/// Convert a JSON value to a string for interpolation
fn value_to_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_string(),
        _ => value.to_string(), // Arrays/objects become JSON strings
    }
}

/// Simple random number generator (no external dependency)
pub(crate) fn rand_simple() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    use std::sync::atomic::{AtomicU64, Ordering};
    // A per-call counter decorrelates consecutive calls (nanosecond time alone
    // repeats when called in a tight loop); splitmix64 spreads the bits.
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let c = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut x = nanos.wrapping_add(c.wrapping_mul(0x9E37_79B9_7F4A_7C15));
    x ^= x >> 30;
    x = x.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x ^= x >> 27;
    x = x.wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^= x >> 31;
    (x >> 1) as i64 // always non-negative
}

/// Generate a random alphanumeric string
pub(crate) fn generate_random_string(len: usize) -> String {
    const CHARSET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    (0..len)
        .map(|_| {
            let idx = (rand_simple() as usize) % CHARSET.len();
            CHARSET[idx] as char
        })
        .collect()
}

/// Generate a random password with mixed case, digits, and special chars
pub(crate) fn generate_random_password(len: usize) -> String {
    const LOWER: &[u8] = b"abcdefghijklmnopqrstuvwxyz";
    const UPPER: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const DIGITS: &[u8] = b"0123456789";
    const SPECIAL: &[u8] = b"!@#$%^&*";
    const ALL: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";

    if len == 0 {
        return String::new();
    }

    let pick = |set: &[u8]| set[(rand_simple() as usize) % set.len()];

    // Guarantee at least one from each category (as far as the length allows),
    // so the result satisfies "must contain a letter and a number" policies.
    let mut chars: Vec<u8> = [LOWER, UPPER, DIGITS, SPECIAL]
        .iter()
        .take(len)
        .map(|set| pick(set))
        .collect();
    while chars.len() < len {
        chars.push(pick(ALL));
    }

    // Fisher–Yates shuffle so the guaranteed chars aren't always in front.
    for i in (1..chars.len()).rev() {
        let j = (rand_simple() as usize) % (i + 1);
        chars.swap(i, j);
    }

    chars.iter().map(|&b| b as char).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_priority() {
        let mut exec_vars = HashMap::new();
        exec_vars.insert("token".to_string(), Value::String("exec_token".to_string()));

        let mut env_vars = HashMap::new();
        env_vars.insert("token".to_string(), Value::String("env_token".to_string()));
        env_vars.insert("baseUrl".to_string(), Value::String("http://api.test".to_string()));

        let mut flow_vars = HashMap::new();
        flow_vars.insert("token".to_string(), Value::String("flow_token".to_string()));
        flow_vars.insert("flowVar".to_string(), Value::String("flow_value".to_string()));

        let mut ctx = ExecutionContext::new(exec_vars, env_vars, flow_vars);
        ctx.set("token", Value::String("ctx_token".to_string()));
        ctx.set("userId", Value::String("123".to_string()));

        let mut node_vars = HashMap::new();
        node_vars.insert("token".to_string(), Value::String("node_token".to_string()));
        node_vars.insert("nodeVar".to_string(), Value::String("node_value".to_string()));
        ctx.set_node_input_vars(node_vars);

        // Execution vars have highest priority
        assert_eq!(ctx.resolve("token"), Some(&Value::String("exec_token".to_string())));
        // Context (exports) beats node input vars
        assert_eq!(ctx.resolve("userId"), Some(&Value::String("123".to_string())));
        // Node input vars beat flow vars
        assert_eq!(ctx.resolve("nodeVar"), Some(&Value::String("node_value".to_string())));
        // Flow vars beat environment vars
        assert_eq!(ctx.resolve("flowVar"), Some(&Value::String("flow_value".to_string())));
        // Environment vars are last
        assert_eq!(ctx.resolve("baseUrl"), Some(&Value::String("http://api.test".to_string())));
        // Not found returns None
        assert_eq!(ctx.resolve("notfound"), None);
    }

    #[test]
    fn test_node_input_vars_cleared_between_nodes() {
        let mut ctx = ExecutionContext::new(HashMap::new(), HashMap::new(), HashMap::new());

        let mut vars1 = HashMap::new();
        vars1.insert("login_user".to_string(), Value::String("admin".to_string()));
        ctx.set_node_input_vars(vars1);
        assert_eq!(ctx.resolve("login_user"), Some(&Value::String("admin".to_string())));

        // Simulate next node with different vars (full replacement)
        let mut vars2 = HashMap::new();
        vars2.insert("login_user".to_string(), Value::String("viewer".to_string()));
        ctx.set_node_input_vars(vars2);
        assert_eq!(ctx.resolve("login_user"), Some(&Value::String("viewer".to_string())));

        // Empty replacement clears all node vars
        ctx.set_node_input_vars(HashMap::new());
        assert_eq!(ctx.resolve("login_user"), None);
    }

    #[test]
    fn test_interpolate() {
        let mut env_vars = HashMap::new();
        env_vars.insert("baseUrl".to_string(), Value::String("http://api.test".to_string()));
        env_vars.insert("userId".to_string(), Value::Number(42.into()));

        let ctx = ExecutionContext::new(HashMap::new(), env_vars, HashMap::new());

        let result = ctx.interpolate("{{baseUrl}}/users/{{userId}}").unwrap();
        assert_eq!(result, "http://api.test/users/42");

        // Unknown variables stay as-is
        let result = ctx.interpolate("{{unknown}}/test").unwrap();
        assert_eq!(result, "{{unknown}}/test");
    }

    #[test]
    fn test_row_vars_beat_every_other_scope() {
        // A data row's cell is the explicit input for that iteration, so it must
        // win over exports, execution vars, node vars, flow vars and the env.
        let mut env = HashMap::new();
        env.insert("email".to_string(), Value::String("from_env".into()));
        let mut flow = HashMap::new();
        flow.insert("email".to_string(), Value::String("from_flow".into()));
        let mut exec = HashMap::new();
        exec.insert("email".to_string(), Value::String("from_exec".into()));

        let mut ctx = ExecutionContext::new(exec, env, flow);
        ctx.set("email", Value::String("from_export".into()));
        let mut node = HashMap::new();
        node.insert("email".to_string(), Value::String("from_node".into()));
        ctx.set_node_input_vars(node);

        // Without a row, the normal order applies (execution vars first).
        assert_eq!(ctx.interpolate("{{email}}").unwrap(), "from_exec");

        let mut row = HashMap::new();
        row.insert("email".to_string(), Value::String("from_row".into()));
        ctx.set_row_vars(row);
        assert_eq!(ctx.interpolate("{{email}}").unwrap(), "from_row");

        // Clearing the row restores the lower scopes.
        ctx.set_row_vars(HashMap::new());
        assert_eq!(ctx.interpolate("{{email}}").unwrap(), "from_exec");
    }

    #[test]
    fn test_builtin_uuid() {
        let ctx = ExecutionContext::new(HashMap::new(), HashMap::new(), HashMap::new());
        let result = ctx.interpolate("id={{$UUID}}").unwrap();
        assert!(result.starts_with("id="));
        assert!(result.len() > 10); // UUID is 36 chars
    }

    #[test]
    fn test_builtin_random_password() {
        let ctx = ExecutionContext::new(HashMap::new(), HashMap::new(), HashMap::new());
        let result = ctx.interpolate("pw={{$RandomPassword}}").unwrap();
        assert!(result.starts_with("pw="));
        assert!(result.len() >= 19); // "pw=" + 16 chars
    }

    #[test]
    fn test_password_has_letter_and_digit() {
        // Every generated password must satisfy "at least 1 letter and 1 number".
        for _ in 0..200 {
            let pw = generate_random_password(16);
            assert!(pw.chars().any(|c| c.is_ascii_alphabetic()), "no letter in {pw}");
            assert!(pw.chars().any(|c| c.is_ascii_digit()), "no digit in {pw}");
            assert_eq!(pw.chars().count(), 16);
        }
    }

    #[test]
    fn test_builtin_random_username() {
        let ctx = ExecutionContext::new(HashMap::new(), HashMap::new(), HashMap::new());
        let result = ctx.interpolate("{{$RandomUsername}}").unwrap();
        assert!(result.starts_with("user_"));
        assert_eq!(result.len(), 13); // "user_" + 8 chars
    }
}
