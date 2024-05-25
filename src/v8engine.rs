use deno_core::anyhow::Ok;
use deno_core::error::AnyError;
use deno_core::v8;
use deno_core::{JsRuntime, RuntimeOptions};
use serde_json::Value;

pub struct JsEngine {
    runtime: JsRuntime,
}

impl JsEngine {
    pub fn new() -> Self {
        let runtime = JsRuntime::new(RuntimeOptions::default());
        JsEngine { runtime }
    }

    pub fn eval(&mut self, js_code: &str) -> Result<Value, AnyError> {
        let scope = &mut self.runtime.handle_scope();
        let code = v8::String::new(scope, js_code).unwrap();
        let script = v8::Script::compile(scope, code, None).unwrap();
        let result = script.run(scope);

        match result {
            Some(value) => v8_value_to_serde_json(scope, value),
            None => Ok(Value::Null), // Handle `undefined` as `null`
        }
    }

    pub fn initialize_globals(&mut self) -> Result<(), AnyError> {
        self.eval(
            r#"
            var SAT = {};
            SAT.globals = {};
            //console.log("global object created", global);
            SAT.tester = function(name, cb) { 
                console.log(`Executing '${name}'...`);
                let result = cb(); 
                return result === true ? true : false;
            };
            console.log("Done with initialization.");
        "#,
        )?;
        Ok(())
    }
}

fn v8_value_to_serde_json(
    scope: &mut v8::HandleScope,
    value: v8::Local<v8::Value>,
) -> Result<Value, AnyError> {
    if value.is_null_or_undefined() {
        Ok(Value::Null)
    } else if value.is_boolean() {
        let boolean = value.boolean_value(scope);
        Ok(Value::Bool(boolean))
    //} else if let Some(number) = value.number_value(scope) {
    } else if value.is_number() {
        let number = value.number_value(scope).unwrap();
        Ok(Value::Number(serde_json::Number::from_f64(number).unwrap()))
    } else if let Some(string) = value.to_rust_string_lossy(scope).parse::<String>().ok() {
        Ok(Value::String(string))
    } else if value.is_object() {
        let json_string = v8::json::stringify(scope, value)
            .ok_or_else(|| AnyError::msg("Failed to stringify JSON object"))?
            .to_rust_string_lossy(scope);
        let json_value: Value = serde_json::from_str(&json_string)?;
        Ok(json_value)
    } else {
        Err(AnyError::msg("Unsupported JavaScript value type"))
    }
}

/*
fn main() -> Result<(), AnyError> {
    let mut engine = JsEngine::new();

    // Initialize global functions
    engine.initialize_globals()?;

    println!("main: done with engine initialization and global setup");
    // Execute a script that calls the global tester function
    engine.eval(
        r#"
        global.tester("Should succeed with 200", () => {
            console.log("Inside callback");
            return true;
        });
    "#,
    )?;

    Ok(())
}
*/

// Add test cases here
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_for_truth_value() {
        let mut engine = JsEngine::new();
        engine.initialize_globals().unwrap();
        let result = engine
            .eval(
                r#"
            SAT.tester("Should succeed with 200", () => { 
                return true; 
            });
        "#,
            )
            .unwrap();
        println!("Result: {:?}", result);
        assert_eq!(result, Value::Bool(true));
    }

    #[test]
    fn test_for_false_value() {
        let mut engine = JsEngine::new();
        engine.initialize_globals().unwrap();
        let result = engine
            .eval(
                r#"
            SAT.tester("Should return false ", () => { 
                return false; 
            });
        "#,
            )
            .unwrap();
        println!("Result: {:?}", result);
        assert_eq!(result, Value::Bool(false));
    }

    #[test]
    fn test_for_non_boolean_value() {
        let mut engine = JsEngine::new();
        engine.initialize_globals().unwrap();
        let result = engine
            .eval(
                r#"
            SAT.tester("A string type should evaluate to false value.", () => { 
                return "Hello World"; 
            });
        "#,
            )
            .unwrap();
        println!("Result: {:?}", result);
        assert_eq!(result, Value::Bool(false));
    }

    #[test]
    fn test_for_void() {
        let mut engine = JsEngine::new();
        engine.initialize_globals().unwrap();
        let result = engine
            .eval(
                r#"
            SAT.tester("Anything other than explicit true is false.", () => { 
                return; 
            });
        "#,
            )
            .unwrap();
        println!("Result: {:?}", result);
        assert_eq!(result, Value::Bool(false));
    }
}
