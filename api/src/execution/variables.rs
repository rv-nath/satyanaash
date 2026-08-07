//! Variable interpolation and execution context management
//!
//! Resolution order (highest priority first):
//! 1. Execution variables (passed in execute request)
//! 2. Data row variables (this row's values for the request's own {{names}})
//! 3. Node input variables (static per-node overrides set in flow editor)
//! 4. Context variables (exports from previous test cases + pre-test script vars)
//! 5. Flow variables (scoped to the flow)
//! 6. Environment variables (from project settings)
//! 7. Built-in variables ($UUID, $Timestamp, etc.)

use std::collections::HashMap;
use regex::Regex;
use serde_json::Value;
use chrono::Utc;
use uuid::Uuid;

use crate::error::AppError;

/// Execution context that holds all variables during flow execution
#[derive(Debug, Clone)]
pub struct ExecutionContext {
    /// Variables passed in the execute request
    execution_vars: HashMap<String, Value>,
    /// This data row's own values (set per row by `run_rows`, on that row's own
    /// clone of the context, so one row's values cannot reach the next)
    row_vars: HashMap<String, Value>,
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
            execution_vars,
            row_vars: HashMap::new(),
            context: HashMap::new(),
            node_input_vars: HashMap::new(),
            flow_vars,
            environment,
        }
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

    /// Set this data row's values, replacing any previous row's.
    ///
    /// Above `node_input_vars` on purpose: a row is more specific than the node it
    /// runs in. A fan-out node supplying `expected_count` for the whole set and a row
    /// supplying its own `channel` is the normal case, and where they name the same
    /// thing the row is the one that changes per iteration.
    pub fn set_row_vars(&mut self, vars: HashMap<String, Value>) {
        self.row_vars = vars;
    }

    /// Resolve a variable by name using the resolution order
    /// Most specific wins. `node_input_vars` sits above `context` deliberately: it
    /// is what the author typed on *this* node, while `context` is inherited from
    /// whatever ran earlier. With it below, a node that set my_email explicitly
    /// still sent the value a previous step's script happened to leave behind —
    /// an override that cannot override.
    pub fn resolve(&self, name: &str) -> Option<&Value> {
        self.resolve_with_source(name).map(|(value, _)| value)
    }

    /// The same lookup, saying which tier answered. `resolve` delegates here so the
    /// order can't be stated twice and drift.
    pub fn resolve_with_source(&self, name: &str) -> Option<(&Value, VarSource)> {
        // A JSON null is an absent value, not a value of "null" — otherwise a null
        // sitting in one tier shadows a real value in the next, and interpolates
        // into a request as the four letters n-u-l-l.
        let present = |v: &&Value| !v.is_null();
        let tiers: [(&HashMap<String, Value>, VarSource); 6] = [
            (&self.execution_vars, VarSource::Request),
            (&self.row_vars, VarSource::Row),
            (&self.node_input_vars, VarSource::Node),
            (&self.context, VarSource::EarlierStep),
            (&self.flow_vars, VarSource::Flow),
            (&self.environment, VarSource::Environment),
        ];
        tiers
            .into_iter()
            .find_map(|(map, source)| map.get(name).filter(present).map(|v| (v, source)))
    }

    /// Every `{{name}}` in this template, where its value came from, and a preview
    /// of that value. Debug-mode only: the point is to answer "why did it send
    /// *that*?" when a name resolves to something plausible but wrong — the one
    /// failure a warning can't detect, because nothing about it looks wrong.
    pub fn provenance(&self, template: &str) -> Vec<(String, VarSource, String)> {
        self.provenance_all(template)
            .into_iter()
            .filter_map(|(name, source, value)| source.map(|s| (name, s, value)))
            .collect()
    }

    /// The same, keeping names that resolved to nothing (`None`). A caller deciding
    /// whether a request is safe to send needs those too — they are the ones that
    /// would go out as a literal `{{name}}`.
    pub fn provenance_all(&self, template: &str) -> Vec<(String, Option<VarSource>, String)> {
        let mut found: Vec<(String, Option<VarSource>, String)> = Vec::new();
        for name in template_names(template) {
            // Built-ins are generated per use; there is no tier to name.
            if name.starts_with('$') || found.iter().any(|(n, _, _)| n == &name) {
                continue;
            }
            match self.resolve_with_source(&name) {
                Some((value, source)) => {
                    found.push((name, Some(source), preview(&value_to_string(value))))
                }
                None => found.push((name, None, String::new())),
            }
        }
        found
    }

    /// Names in this template that resolve to the *text* "null" or "undefined".
    ///
    /// These interpolate cleanly, so the unresolved-variable warning can't see
    /// them: the request goes out with /wallet/null/balance and the server answers
    /// with something unhelpful. They come from a leftover in Globals or an
    /// environment — a value nobody meant to send.
    pub fn placeholder_values(&self, template: &str) -> Vec<String> {
        let mut found: Vec<String> = Vec::new();
        for name in template_names(template) {
            if name.starts_with('$') || found.contains(&name) {
                continue;
            }
            if let Some(value) = self.resolve(&name) {
                let text = value_to_string(value);
                if text == "null" || text == "undefined" {
                    found.push(name);
                }
            }
        }
        found
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
/// Which tier answered a lookup, named the way a test author thinks about it
/// rather than after the field that holds it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VarSource {
    Request,
    Row,
    Node,
    EarlierStep,
    Flow,
    Environment,
}

impl VarSource {
    pub fn label(&self) -> &'static str {
        match self {
            VarSource::Request => "the run request",
            VarSource::Row => "this row",
            VarSource::Node => "this node",
            VarSource::EarlierStep => "an earlier step",
            VarSource::Flow => "flow variables",
            VarSource::Environment => "environment/globals",
        }
    }
}

/// Names inside `{{...}}`, in the order they appear.
/// The `{{names}}` a template declares, built-ins included — the caller decides what to do
/// with `$`-prefixed ones.
///
/// `pub(crate)` so an item fan-out can ask what the request needs before sending it. One
/// regex, so "which names does this request declare" cannot come to mean two things.
pub(crate) fn declared_names(template: &str) -> Vec<String> {
    template_names(template)
}

fn template_names(template: &str) -> Vec<String> {
    let re = match Regex::new(r"\{\{(\$?[\w]+)(?:\(([^)]*)\))?\}\}") {
        Ok(re) => re,
        Err(_) => return Vec::new(),
    };
    re.captures_iter(template)
        .filter_map(|caps| caps.get(1).map(|m| m.as_str().to_string()))
        .collect()
}

/// Short enough to read in a log line — a JWT is a thousand characters and only
/// its shape matters here.
fn preview(value: &str) -> String {
    const MAX: usize = 44;
    if value.chars().count() <= MAX {
        return value.to_string();
    }
    let head: String = value.chars().take(MAX).collect();
    format!("{}… ({} chars)", head, value.chars().count())
}

/// How a value reads once it is text. `pub(crate)` because a row variable synthesised
/// from a collected record must render exactly as it would anywhere else — one function,
/// so `{{campaignId}}` cannot mean two things.
pub(crate) fn value_to_string(value: &Value) -> String {
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
        // Context is reachable when nothing more specific claims the name
        assert_eq!(ctx.resolve("userId"), Some(&Value::String("123".to_string())));
        // The node's own value beats one inherited from an earlier step
        assert_eq!(ctx.resolve("nodeVar"), Some(&Value::String("node_value".to_string())));
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
    fn provenance_names_the_tier_each_value_came_from() {
        let mut exec = HashMap::new();
        exec.insert("one_off".to_string(), Value::String("from-request".to_string()));
        let mut env = HashMap::new();
        env.insert("my_user_id".to_string(), Value::String("stale-from-env".to_string()));
        let mut flow = HashMap::new();
        flow.insert("region".to_string(), Value::String("in".to_string()));
        let mut ctx = ExecutionContext::new(exec, env, flow);
        ctx.set("signup_token", Value::String("from-earlier-step".to_string()));
        let mut node = HashMap::new();
        node.insert("my_email".to_string(), Value::String("admin@x.com".to_string()));
        ctx.set_node_input_vars(node);

        let listed = ctx.provenance(
            "{{one_off}}/{{my_email}}/{{signup_token}}/{{region}}/{{my_user_id}}/{{missing}}/{{$UUID}}",
        );
        let seen: Vec<(&str, &str)> = listed
            .iter()
            .map(|(n, s, _)| (n.as_str(), s.label()))
            .collect();
        assert_eq!(seen, vec![
            ("one_off", "the run request"),
            ("my_email", "this node"),
            ("signup_token", "an earlier step"),
            ("region", "flow variables"),
            // The one that matters: this run should have produced it.
            ("my_user_id", "environment/globals"),
        ]);
    }

    #[test]
    fn provenance_shortens_a_long_value_and_lists_a_name_once() {
        let jwt = "e".repeat(900);
        let mut env = HashMap::new();
        env.insert("token".to_string(), Value::String(jwt));
        let ctx = ExecutionContext::new(HashMap::new(), env, HashMap::new());

        let listed = ctx.provenance("{{token}} and again {{token}}");
        assert_eq!(listed.len(), 1);
        let (_, _, preview) = &listed[0];
        assert!(preview.ends_with("(900 chars)"), "{}", preview);
        assert!(preview.chars().count() < 70, "{}", preview);
    }

    #[test]
    fn a_null_is_an_absent_value_not_the_word_null() {
        let mut env = HashMap::new();
        env.insert("my_user_id".to_string(), Value::Null);
        let mut ctx = ExecutionContext::new(HashMap::new(), env, HashMap::new());

        // Nothing else has it: the name stays unresolved rather than becoming "null".
        assert_eq!(ctx.resolve("my_user_id"), None);
        assert_eq!(
            ctx.interpolate("/wallet/{{my_user_id}}/balance").unwrap(),
            "/wallet/{{my_user_id}}/balance"
        );

        // And a null in one tier doesn't shadow a real value in another.
        ctx.set("my_user_id", Value::String("u-1".to_string()));
        assert_eq!(
            ctx.interpolate("/wallet/{{my_user_id}}/balance").unwrap(),
            "/wallet/u-1/balance"
        );
    }

    /// The text "null" left in Globals resolves cleanly and sends nonsense.
    #[test]
    fn placeholder_values_finds_a_leftover_null() {
        let mut env = HashMap::new();
        env.insert("my_user_id".to_string(), Value::String("null".to_string()));
        env.insert("other".to_string(), Value::String("undefined".to_string()));
        env.insert("real".to_string(), Value::String("u-1".to_string()));
        let ctx = ExecutionContext::new(HashMap::new(), env, HashMap::new());

        assert_eq!(
            ctx.placeholder_values("/wallet/{{my_user_id}}/x/{{real}}/{{other}}"),
            vec!["my_user_id".to_string(), "other".to_string()]
        );
        // Nothing to say about a name that resolves to something real, a name that
        // doesn't resolve at all, or a built-in.
        assert!(ctx.placeholder_values("/x/{{real}}/{{missing}}/{{$UUID}}").is_empty());
    }

    /// A flow signed up a user, whose pre-test script left my_email in the context,
    /// then logged in as an admin on a node that set my_email explicitly. With
    /// context ranked above the node, the login sent the new user's address and came
    /// back 403. The node's own value has to win.
    #[test]
    fn a_nodes_own_value_beats_one_inherited_from_an_earlier_step() {
        let mut ctx = ExecutionContext::new(HashMap::new(), HashMap::new(), HashMap::new());
        ctx.set("my_email", Value::String("newuser@example.com".to_string()));

        let mut node_vars = HashMap::new();
        node_vars.insert("my_email".to_string(), Value::String("admin@example.com".to_string()));
        ctx.set_node_input_vars(node_vars);
        assert_eq!(
            ctx.resolve("my_email"),
            Some(&Value::String("admin@example.com".to_string()))
        );

        // Once that node is done, the inherited value is visible again — the
        // override is scoped to the node, not a permanent overwrite.
        ctx.set_node_input_vars(HashMap::new());
        assert_eq!(
            ctx.resolve("my_email"),
            Some(&Value::String("newuser@example.com".to_string()))
        );
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
