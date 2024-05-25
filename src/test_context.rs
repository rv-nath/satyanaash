use std::error::Error;

use crate::v8engine::JsEngine;
use serde_json::Value;

// A convenient struct for packing the arguments for testcase::run.
// In future, we may be able to add more params, without changing the run method signature.
pub struct TestCtx {
    pub client: reqwest::blocking::Client,
    pub jwt_token: Option<String>,
    pub runtime: JsEngine,

    // More fields as necessary
    exec_duration: std::time::Duration,
}

impl TestCtx {
    pub fn new() -> Result<Self, Box<dyn Error>> {
        let mut runtime = JsEngine::new();
        runtime.initialize_globals().unwrap();

        let client = reqwest::blocking::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .expect("Failed to build client");

        Ok(TestCtx {
            client,
            jwt_token: None,
            runtime,
            exec_duration: std::time::Duration::new(0, 0),
        })
    }

    pub fn update_token(&mut self, token: Option<String>) {
        self.jwt_token = token;
    }

    pub fn exec(&mut self, request: reqwest::blocking::RequestBuilder, is_authorizer: bool) {
        let start = std::time::Instant::now();
        let response = request.send();
        println!("DEBUG: response: {:?}", response);
        self.exec_duration = start.elapsed();
        match response {
            Ok(response) => {
                // Get the status
                let status = response.status().as_u16();

                // Get the body as a string
                let body = response
                    .text()
                    .unwrap_or_else(|_| String::from("Failed to read response body"));

                // Parse the body string as JSON
                let body_json: Value = match serde_json::from_str::<Value>(&body) {
                    Ok(json) => {
                        // if is_authorizer is true, extract and store the token
                        if is_authorizer {
                            let token = json["token"].as_str().unwrap_or("");
                            self.update_token(Some(token.to_owned()));
                        }
                        json
                    }
                    Err(_) => Value::Null,
                };

                // Pass the status, body, and body_json to the JavaScript context
                self.runtime
                    .eval(&format!(
                        "SAT.response = {{ status: {}, body: `{}`, json: {} }}",
                        status, body, body_json
                    ))
                    .unwrap();
            }
            Err(e) => {
                // Clear the response in the JavaScript context
                self.runtime
                    .eval(&format!("SAT.response = {{ status: 0, body: `{}` }}", e))
                    .unwrap();
            }
        }
    }

    // Verify if the test has passed or failed.
    pub fn verify_result(&mut self, script: Option<&str>) -> bool {
        // Debug and see if the SAT.test function exists in the runtime.
        //println!("DEBUG: SAT.test: {:?}", self.runtime.eval("SAT.test"));
        if let Some(script) = script {
            match self.runtime.eval(script) {
                Ok(result) => match result.as_bool() {
                    Some(true) => true,
                    _ => false,
                },
                Err(e) => {
                    eprintln!("Error: {}", e);
                    false
                }
            }
        } else {
            false
        }
    }

    pub fn get_test_name(&mut self) -> String {
        self.runtime
            .eval("SAT.testName")
            .unwrap_or(Value::String("".to_string()))
            .as_str()
            .unwrap_or_default()
            .to_owned()
    }

    pub fn get_http_status(&mut self) -> i64 {
        match self.runtime.eval("SAT.response.status") {
            //Ok(quick_js::JsValue::Int(status)) => status,
            Ok(val) => val.as_i64().unwrap_or(0),
            _ => 0, // return a default value in case of error or if the value is not an integer
        }
    }

    pub fn get_response_body(&mut self) -> String {
        self.runtime
            .eval("SAT.response.body")
            .unwrap()
            .as_str()
            .unwrap_or("None")
            .to_owned()
    }

    pub fn print_response_info(&mut self) {
        println!("Response Info:");
        println!("\tStatus: {}", self.get_http_status());

        match serde_json::from_str::<Value>(&self.get_response_body()) {
            Ok(json) => {
                let pretty_json = serde_json::to_string_pretty(&json).unwrap_or_default();
                let indented_json = pretty_json.replace("\n", "\n\t");
                println!("\tBody: {}", indented_json);
            }
            Err(_) => {
                println!("\tBody: {}", self.get_response_body());
            }
        }
    }

    pub fn exec_duration(&self) -> std::time::Duration {
        self.exec_duration
    }
}

#[cfg(test)]
mod tests {
    //use crate::test_context::TestCtx;
    use super::*;

    #[test]
    fn test_new() {
        let mut ts_ctx = TestCtx::new().unwrap();
        let typeof_sat = ts_ctx
            .runtime
            .eval("console.log('type of SAT.tester is:', typeof SAT.tester); typeof SAT.tester")
            .unwrap();
        assert_eq!(typeof_sat, Value::String("function".to_string()));
    }

    #[test]
    fn test_sat_test_for_true() {
        // Create a new TestCtx instance
        let mut tctx = TestCtx::new().unwrap();

        // Create a mock function that returns true
        let mock_fn = "function() { return true; }";

        // Call SAT.test with the mock function
        let result = tctx
            .runtime
            .eval(&format!("SAT.tester('test', {})", mock_fn))
            .unwrap();

        // Check if the return value is true
        assert_eq!(result, Value::Bool(true));
    }

    #[test]
    fn test_sat_test_non_boolean() {
        // Create a new TestCtx instance
        let mut tctx = TestCtx::new().unwrap();

        // Create a mock function that returns a non-boolean value
        let mock_fn = "function() { return 'non-boolean'; }";

        // Call SAT.test with the mock function
        let result = tctx
            .runtime
            .eval(&format!("SAT.tester('test', {})", mock_fn))
            .unwrap();

        // Check if the return value is false
        assert_eq!(result, Value::Bool(false));
    }

    /*
    #[test]
    fn test_sat_test_error() {
        // Create a new TestCtx instance
        let tctx = TestCtx::new();

        // Create a mock function that throws an error
        let mock_fn = "function() { throw new Error('error'); }";

        // Call SAT.test with the mock function
        let result = tctx
            .runtime
            .eval(&format!("SAT.test('test', {})", mock_fn))
            .unwrap();

        // Check if the return value is false
        let expected = quick_js::JsValue::Bool(false);

        assert_eq!(result, expected);
    }
    */
}

//oO08
//ProFont: Nerd Font.
//
