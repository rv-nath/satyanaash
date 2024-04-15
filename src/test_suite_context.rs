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

pub enum TestResult {
    NotYetTested,
    Passed,
    Failed,
    Skipped,
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
                    try {
                        fn();
                        //console.log(`✔ ${name}`);
                    } catch (e) {
                        //console.error(`✘ ${name}: ${e}`);
                    }
                    SAT.testName = name;
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

    //pub fn set_response(&mut self, response: Result<Response, reqwest::Error>) {
    pub fn exec(&mut self, request: reqwest::blocking::RequestBuilder) {
        let start = std::time::Instant::now();
        let response = request.send();
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
                let body_json: Value = match serde_json::from_str(&body) {
                    Ok(json) => json,
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
                eprintln!("Network error: {}", e);
                // Clear the response in the JavaScript context
                self.runtime.eval("SAT.response = {}").unwrap();
            }
        }
    }

    // Verify if the test has passed or failed.
    //pub fn verify_result(&self, script: &str) -> bool {
    pub fn verify_result(&self, script: Option<&str>) -> bool {
        if let Some(script) = script {
            match self.runtime.eval_as::<bool>(script) {
                Ok(result) => result,
                Err(_) => false,
            }
        } else {
            false
        }
    }

    pub fn get_test_name(&self) -> String {
        self.runtime
            .eval("SAT.testName")
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned()
    }
    pub fn get_http_status(&self) -> String {
        self.runtime
            .eval("SAT.response.status")
            .unwrap()
            .as_str()
            .unwrap_or("None")
            .to_owned()
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
        println!("\tBody: {}", self.get_response_body());
        println!("\tExecution Time: {:?}", self.exec_duration);
    }

    // Return the test result as an enum of TestResult options.
    pub fn get_test_result(&self) -> TestResult {}
}
