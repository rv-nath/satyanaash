use quick_js::Context;
use serde_json::Value;

// A convenient struct for packing the arguments for testcase::run.
// In future, we may be able to add more params, without changing the run method signature.
pub struct TestSuiteCtx<'a> {
    pub client: &'a reqwest::blocking::Client,
    pub jwt_token: Option<String>,
    pub runtime: &'a mut quick_js::Context,

    // More fields as necessary
    exec_duration: std::time::Duration,
}

impl<'a> TestSuiteCtx<'a> {
    pub fn new(
        client: &'a reqwest::blocking::Client,
        _jwt_token: Option<String>,
        runtime: &'a mut Context,
    ) -> Self {
        // Initialize SAT as an empty object
        runtime.eval("var SAT = {}").unwrap();

        // define the 'SAT.test' function
        runtime
            .eval(
                r#"
                SAT.test = function (name, fn) {
                    SAT.testName = name;
                    let result = false;
                    try {
                        result = fn();
                        if (typeof result !== 'boolean') {
                            result = false;
                        }
                    } catch (e) {
                        // Handle error
                       result = false;
                    }
                    return result;
                }
            "#,
            )
            .unwrap();
        TestSuiteCtx {
            client,
            jwt_token: None,
            runtime,
            exec_duration: std::time::Duration::new(0, 0),
        }
    }

    pub fn update_token(&mut self, token: Option<String>) {
        self.jwt_token = token;
    }

    pub fn exec(&mut self, request: reqwest::blocking::RequestBuilder, is_authorizer: bool) {
        let start = std::time::Instant::now();
        let response = request.send();
        //println!("DEBUG: response: {:?}", response);
        self.exec_duration = start.elapsed();
        match response {
            Ok(response) => {
                // Get the status
                let status = response.status().as_u16();

                // Get the body as a string
                let body = response
                    .text()
                    .unwrap_or_else(|_| String::from("Failed to read response body"));
                //println!("DEBUG: body: {:?}", body);

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
                //eprintln!("error: {}", e);
                // Clear the response in the JavaScript context
                //self.runtime.eval("SAT.response = {}").unwrap();
                self.runtime
                    .eval(&format!("SAT.response = {{ status: 0, body: `{}` }}", e))
                    .unwrap();
            }
        }
    }

    // Verify if the test has passed or failed.
    pub fn verify_result(&self, script: Option<&str>) -> bool {
        // Debug and see if the SAT.test function exists in the runtime.
        //println!("DEBUG: SAT.test: {:?}", self.runtime.eval("SAT.test"));
        if let Some(script) = script {
            match self.runtime.eval_as::<bool>(script) {
                Ok(result) => result,
                Err(e) => {
                    eprintln!("Error: {}", e);
                    false
                }
            }
        } else {
            false
        }
    }

    pub fn get_test_name(&self) -> String {
        self.runtime
            .eval("SAT.testName")
            .unwrap_or(quick_js::JsValue::Null)
            .as_str()
            .unwrap_or_default()
            .to_owned()
    }
    pub fn get_http_status(&self) -> i32 {
        match self.runtime.eval("SAT.response.status") {
            Ok(quick_js::JsValue::Int(status)) => status,
            _ => 0, // return a default value in case of error or if the value is not an integer
        }
    }

    pub fn get_response_body(&self) -> String {
        self.runtime
            .eval("SAT.response.body")
            .unwrap()
            .as_str()
            .unwrap_or("None")
            .to_owned()
    }

    pub fn print_response_info(&self) {
        println!("Response Info:");
        println!("\tStatus: {}", self.get_http_status());
        let body = self.get_response_body();

        println!("\tBody: {}", self.get_response_body());
        println!("\tExecution Time: {:?}", self.exec_duration);
    }
}
