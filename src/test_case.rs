use crate::test_events::{TestCaseBegin, TestCaseEnd, TestEvent};
use crate::{config::Config, test_context::TestCtx};
use base64;
use bharat_cafe as bc;
use calamine::DataType;
use colored::Colorize;
use indicatif::ProgressBar;
use regex::Regex;
use reqwest::blocking::multipart;
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::default;
use std::env;
use std::fs::File;
use std::io::Read;
use std::io::{self, Write};
use std::sync::Arc;
use std::{sync::mpsc::Sender, time::Duration};

// Possible test case results.
#[derive(Debug, Clone, PartialEq)]
pub enum TestResult {
    NotYetTested,
    Passed,
    Failed,
    Skipped,
}

// How authentication should be handled for a given test case.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum AuthType {
    None,
    Authorizer,
    Authorized,
}
// Advanced configuration for tweaking the test case behavior
// for repeated execution, delay between requests, etc.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestCaseConfig {
    #[serde(default = "default_repeat_count")]
    repeat_count: u32, // Indicates if this test case shd be repeated
    //#[serde(default = "default_data_source")]
    //data_source: String, // For repeating the test case with different data sets. A csv file path that cotnains
    #[serde(default = "default_auth_type")]
    auth_type: AuthType, // Indicates if the test case generates or consumes a JWT
    #[serde(default = "default_delay")]
    delay: u64, // Delay between test case execution (in millis).
}

impl Default for TestCaseConfig {
    fn default() -> Self {
        TestCaseConfig {
            repeat_count: default_repeat_count(),
            //data_source: default_data_source(),
            auth_type: default_auth_type(),
            delay: default_delay(),
        }
    }
}

fn default_repeat_count() -> u32 {
    1
}

fn default_data_source() -> String {
    "".to_string()
}

fn default_auth_type() -> AuthType {
    AuthType::None
}

fn default_delay() -> u64 {
    0
}

#[derive(Debug, Clone)]
pub struct TestCase {
    pub id: u32,                          // test case identifier (typically a number)
    pub name: String,                     // human readable name for the test case.
    pub given: String,                    // test case description for the given condition (Given)
    pub when: String,                     // test case description for the then condition  (When)
    pub then: String,                     // test case description. for resulting condition. (Then)
    pub url: String,                      // URL of the request
    pub method: Method,                   // http method for the request.
    pub headers: Vec<(String, String)>,   // http headers for the request, if any.
    pub payload: String,                  // payload to be sent with the request.
    config: TestCaseConfig,               // advanced configuration for the test case.
    pub pre_test_script: Option<String>,  // script to be executed before the test case.
    pub post_test_script: Option<String>, // script to be executed after the test case.

    pub errors: Vec<(String, String)>, // List of errors found while reading excel data.

    // Shadow fields to track the substituted values for name, url, payload, headers, ...
    effective_name: String,
    effective_url: String,
    effective_payload: String,
    content_type: String, // will be filled by `prepare_payload` method.

    // fields that will be filled after test case is executed..
    //exec_duration: std::time::Duration,
    result: TestResult,
}

impl TestCase {
    pub fn dummy() -> Self {
        TestCase {
            id: 0,
            name: "".to_string(),
            given: "".to_string(),
            when: "".to_string(),
            then: "".to_string(),
            url: "".to_string(),
            method: Method::GET,
            headers: Vec::new(),
            payload: "".to_string(),
            config: TestCaseConfig::default(),
            pre_test_script: None,
            post_test_script: None,
            errors: Vec::new(),
            effective_name: "".to_string(),
            effective_url: "".to_string(),
            effective_payload: "".to_string(),
            content_type: "".to_string(),
            result: TestResult::NotYetTested,
        }
    }
    // Initializes a test case object with a row of data from excel sheet.
    pub fn new(row: &[calamine::Data], config: &Config) -> Self {
        let mut errors = Vec::new();

        // Retrieve and evaluate the pre-test-script as the very first step,
        // as it may contain the code to setup JS runtime vars,
        // which may be consumed in other columns.
        let pre_test_script = match row[10].get_string() {
            Some(s) => Some(s.to_owned()),
            //Some(s) => Some(substitute_keywords(s)),
            None => None,
        };

        // Read the test case id.
        let id = match row[0].get_float() {
            Some(f) => f as u32,
            None => {
                errors.push(("id".to_owned(), "ID is not a number.".to_owned()));
                0
            }
        };

        // Test case name
        let name = match row[1].get_string() {
            //Some(s) => s.to_owned(),
            Some(s) => substitute_keywords(s),
            None => {
                errors.push(("name".to_owned(), "Invalid name field".to_owned()));
                "".to_string()
            }
        };

        // Test case's given condition
        let given = match row[2].get_string() {
            //Some(s) => s.to_owned(),
            Some(s) => substitute_keywords(s),
            None => {
                errors.push((
                    "given".to_owned(),
                    "Invalid data for 'given' field.".to_string(),
                ));
                "".to_string()
            }
        };

        // Testcase when condition
        let when = match row[3].get_string() {
            //Some(s) => s.to_owned(),
            Some(s) => substitute_keywords(s),
            None => {
                errors.push((
                    "when".to_owned(),
                    "Invalid data for 'when' field.".to_string(),
                ));
                "".to_string()
            }
        };

        // Test case's then result
        let then = match row[4].get_string() {
            //Some(s) => s.to_owned(),
            Some(s) => substitute_keywords(s),
            None => {
                errors.push((
                    "then".to_string(),
                    "Invalid data for 'then' field.".to_string(),
                ));
                "".to_string()
            }
        };

        // Test case URL
        let url = match row[5].get_string() {
            Some(s) => {
                let s = substitute_keywords(s);
                let full_url = if s.starts_with("http://") || s.starts_with("https://") {
                    s.to_string()
                } else {
                    format!("{}{}", config.base_url.clone().unwrap_or_default(), s)
                };
                match Url::parse(&full_url) {
                    Ok(_) => full_url,
                    Err(_) => {
                        errors.push(("url".to_string(), "Invalid URL format.".to_string()));
                        "".to_string()
                    }
                }
            }
            None => {
                errors.push(("url".to_string(), "No data for 'url' field.".to_string()));
                "".to_string()
            }
        };

        // Test case HTTP method
        let method = match row[6].get_string() {
            Some(s) => match s.parse::<reqwest::Method>() {
                Ok(m) => m,
                Err(_) => {
                    errors.push(("method".to_string(), "Invalid HTTP method.".to_string()));
                    Method::GET
                }
            },
            None => {
                errors.push((
                    "method".to_string(),
                    "No data for 'method' field.".to_string(),
                ));
                Method::GET
            }
        };

        // http headers if any for the request.
        let headers = match row[7].get_string() {
            Some(s) => s
                .split(',')
                .filter_map(|header| {
                    let parts: Vec<&str> = header.split(':').collect();
                    if parts.len() == 2 {
                        Some((parts[0].trim().to_owned(), parts[1].trim().to_owned()))
                    } else {
                        None
                    }
                })
                .collect(),
            None => Vec::new(),
        };

        // INput payload for the request, if the method is post, put or patch.
        let payload = match row[8].get_string() {
            Some(s) => {
                let substituted_s = substitute_keywords(s);
                match serde_json::from_str::<serde_json::Value>(&substituted_s) {
                    Ok(_) => substituted_s,
                    Err(_) => {
                        errors.push(("payload".to_string(), "Invalid JSON payload.".to_string()));
                        "".to_string()
                    }
                }
            }
            None => "".to_owned(),
        };

        // Initialize config with row[9] json data.
        let config = match row[9].get_string() {
            Some(s) => match serde_json::from_str::<TestCaseConfig>(&s) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("Error parsing test case config: {}", e);
                    TestCaseConfig::default()
                }
            },
            None => TestCaseConfig::default(),
        };

        /*
        // This column is read in the beginning. So no need here.
        let pre_test_script = match row[10].get_string() {
            //Some(s) => Some(s.to_owned()),
            Some(s) => Some(substitute_keywords(s)),
            None => None,
        };
        */

        let post_test_script = match row[11].get_string() {
            //Some(s) => Some(s.to_owned()),
            Some(s) => Some(substitute_keywords(s)),
            None => None,
        };

        let tc = TestCase {
            id,
            name,
            given,
            when,
            then,
            url,
            method,
            headers,
            payload,
            errors,
            pre_test_script,
            post_test_script,
            result: TestResult::NotYetTested,
            config,
            effective_name: "".to_string(),
            effective_url: "".to_string(),
            effective_payload: "".to_string(),
            content_type: "".to_string(),
        };
        tc
    }

    // Executes the test case, by using the provided http client  and an optional JWT token.
    // Returns an optional JWT token (if it was an authorization endpoint).
    pub fn run(
        &mut self,
        ts_ctx: &mut TestCtx,
        sys_config: &Config,
        tx: &Sender<TestEvent>,
    ) -> TestResult {
        // Fire an event indicating that the test case execution has started.
        self.fire_start_evt(tx);

        println!("Running the test case: {}", self.name);

        // Verify if the test case has errors, if so return without executing.
        if self.errors.len() > 0 {
            println!(
                "Skipping test case: {} due to errors: {:?}",
                self.name, self.errors
            );
            return TestResult::Skipped;
        }

        let mut overall_result = TestResult::Passed;

        // Execute the test case as per the configuration found in the test case.
        println!("Test case configurations {:?}", self.config);
        for _ in 0..self.config.repeat_count {
            let req = self.pre_run_ops(ts_ctx, sys_config);
            let spinner = ProgressBar::new_spinner();
            show_progress(&mut self.effective_url, &spinner);
            self.execute_request(ts_ctx, req, sys_config, tx);
            if self.result == TestResult::Failed {
                overall_result = TestResult::Failed;
                stop_progress(&spinner);
                self.post_run_ops(ts_ctx, sys_config);
                break;
            }
            stop_progress(&spinner);
            self.post_run_ops(ts_ctx, sys_config);
        }

        //self.result.clone()
        overall_result
    }

    fn prepare_request(
        &mut self,
        ts_ctx: &mut TestCtx,
        _config: &Config,
    ) -> reqwest::blocking::RequestBuilder {
        // 1. Retrieve global variables and substitute placeholders in test case parameters
        //    Retrieve global variables and substitute placeholders in test case parameters
        self.effective_name =
            self.substitute_placeholders(&substitute_keywords(&self.name), ts_ctx);

        self.effective_url = self.substitute_placeholders(&substitute_keywords(&self.url), ts_ctx);
        self.effective_payload =
            self.substitute_placeholders(&substitute_keywords(&self.payload), ts_ctx);

        // 2. if the test case is authorized, then add the jwt token to the headers.
        if self.is_authorized() {
            if let Some(token) = ts_ctx.jwt_token.as_ref() {
                self.headers
                    .push(("Authorization".to_owned(), format!("Bearer {}", token)));
            }
        }

        // 3. Frame the request based on Method type, add headers.
        let mut request = ts_ctx
            .client
            .request(self.method.clone(), &self.effective_url);

        // Finally, add the headers to the request.
        for (key, value) in &self.headers {
            // Ignore the content-type header, as it will be handled separately.
            if key.to_lowercase() == "content-type" {
                continue;
            }
            request = request.header(key, value);
        }

        // Prepare payload and return.
        self.prepare_payload(request)
    }

    fn execute_request(
        &mut self,
        ts_ctx: &mut TestCtx,
        req: reqwest::blocking::RequestBuilder,
        config: &Config,
        tx: &Sender<TestEvent>,
    ) {
        // Fire the request using blocking call.
        ts_ctx.exec(req, self.is_authorizer(), &config);

        // Execute the post test script and verify the result.
        let result = ts_ctx.verify_result(self.post_test_script.as_deref());

        // store the test result as an enum.
        let test_result = match result {
            true => TestResult::Passed,
            false => TestResult::Failed,
        };
        self.result = test_result;

        // Fire test case end evt.
        self.fire_end_evt(tx, ts_ctx);
    }

    fn is_authorized(&self) -> bool {
        match self.config.auth_type {
            AuthType::Authorized => true,
            _ => false,
        }
    }

    fn is_authorizer(&self) -> bool {
        match self.config.auth_type {
            AuthType::Authorizer => true,
            _ => false,
        }
    }

    fn fire_start_evt(&self, tx: &Sender<TestEvent>) {
        tx.send(TestEvent::EvtTestCaseBegin(self.get_start_evt_data()))
            .unwrap();
    }

    fn fire_end_evt(&self, tx: &Sender<TestEvent>, ts_ctx: &mut TestCtx) {
        tx.send(TestEvent::EvtTestCaseEnd(self.get_end_evt_data(ts_ctx)))
            .unwrap();
    }

    fn get_start_evt_data(&self) -> TestCaseBegin {
        TestCaseBegin {
            timestamp: std::time::Instant::now(),
            iteration_id: "1".to_string(),
            testcase_id: self.id,
            testcase_name: self.name.clone(),
            given: self.given.clone(),
            when: self.when.clone(),
            then: self.then.clone(),
            url: self.url.clone(),
            method: self.method.to_string(),
            headers: self.headers.clone(),
            payload: self.payload.clone(),
            pre_test_script: self.pre_test_script.clone(),
            post_test_script: self.post_test_script.clone(),
        }
    }

    fn get_end_evt_data(&self, ts_ctx: &mut TestCtx) -> TestCaseEnd {
        TestCaseEnd {
            timestamp: std::time::Instant::now(),
            iteration_id: "1".to_string(),
            testcase_id: self.id,
            exec_duration: Duration::from_secs(0),
            //TODO: Fix these below fields, to return properly filled values.
            status: self.get_exec_status(ts_ctx),
            response: self.get_exec_response(ts_ctx),
            response_json: self.get_exec_response_json(ts_ctx),
        }
    }

    fn get_exec_status(&self, ts_ctx: &mut TestCtx) -> i64 {
        ts_ctx
            .runtime
            .eval("SAT.response.status")
            .unwrap_or(default::Default::default())
            .as_i64()
            .unwrap_or(default::Default::default())
    }

    fn get_exec_response(&self, ts_ctx: &mut TestCtx) -> String {
        ts_ctx
            .runtime
            .eval("SAT.response.body")
            .unwrap_or(default::Default::default())
            .as_str()
            .unwrap_or(default::Default::default())
            .to_string()
    }

    fn get_exec_response_json(&self, ts_ctx: &mut TestCtx) -> Option<serde_json::Value> {
        match serde_json::from_str::<serde_json::Value>(&self.get_exec_response(ts_ctx)) {
            Ok(json) => Some(json),
            Err(_) => None,
        }
    }

    pub fn print_result(&self, ts_ctx: &mut TestCtx, verbose: bool) {
        println!("{:<15}: {}", "Test Case ID", self.id);
        println!("{:<15}: {}", "Test Case", self.name);
        println!("{:<15}: {}", "Given", self.given);
        println!("{:<15}: {}", "When", self.when);
        println!("{:<15}: {}", "Then", self.then);
        println!("{:<15}: {}", "Expected", ts_ctx.get_test_name());
        println!("{:<15}: {}", "Actual", ts_ctx.get_http_status());

        // print the below, if only verbose flag is enabled.
        if verbose {
            self.print_request_info();
            ts_ctx.print_response_info();
        }

        // finally print the pass / fail / skip status with symbols.
        match self.result {
            TestResult::Passed => println!("{:<15}: {}", "Result", "✅ PASSED".green()),
            TestResult::Failed => println!("{:<15}: {}", "Result", "❌ FAILED".red()),
            TestResult::Skipped => println!("{:<15}: {}", "Result", "⚠️ SKIPPED".yellow()),
            _ => (),
        }
    }

    pub fn print_request_info(&self) {
        println!("Request Info: ");
        println!("\tMethod: {:?}", self.method);
        println!("\tURL: {}", self.effective_url);
        if !self.headers.is_empty() {
            println!("\tHeaders: ");
            for (key, value) in &self.headers {
                let value = value.replace("\n", "");
                println!("\t\t{}: {}", key, value);
            }
        }
        self.print_payload();
    }

    /*
    fn substitute_placeholders(&self, original: &str, ts_ctx: &mut TestCtx) -> String {
        let mut result = original.to_string();
        let re = Regex::new(r"\{\{(.*?)\}\}").unwrap();
        for cap in re.captures_iter(original) {
            let var_name = &cap[1];
            match ts_ctx.runtime.eval(&format!("SAT.globals.{}", var_name)) {
                Ok(value) => {
                    if let Some(value_str) = value.as_str() {
                        result = result.replace(&format!("{{{{{}}}}}", var_name), &value_str);
                    }
                }
                Err(_) => (),
            }
        }
        result
    }
    */

    /// Substitutes placeholders in the input string with corresponding values.
    ///
    /// - `{{env:VAR_NAME}}` will be replaced with the value of the environment variable `VAR_NAME`.
    /// - `{{var}}` will be replaced with the value of the JS context variable `var`.
    /// - If a substitution is not possible, the placeholder remains unchanged.
    ///
    /// # Arguments
    ///
    /// * `original` - The original string containing placeholders.
    /// * `ts_ctx` - Mutable reference to the test context containing the JS runtime.
    ///
    /// # Returns
    ///
    /// A new `String` with placeholders substituted where possible.
    fn substitute_placeholders(&self, original: &str, ts_ctx: &mut TestCtx) -> String {
        // Compile the regex once for efficiency
        let re = Regex::new(r"\{\{(.*?)\}\}").unwrap();

        // Perform substitution using Regex::replace_all with a closure
        re.replace_all(original, |caps: &regex::Captures| {
            let var_expression = &caps[1].trim();

            // Check if the placeholder is an environment variable
            if var_expression.starts_with("env:") {
                let env_var_name = var_expression.trim_start_matches("env:").trim();
                match env::var(env_var_name) {
                    Ok(env_value) => env_value,
                    Err(_) => {
                        /*
                        eprintln!(
                            "Warning: Environment variable '{}' is not set. Leaving placeholder unchanged.",
                            env_var_name
                        );
                        */
                        caps[0].to_string() // Return the original placeholder
                    }
                }
             } else if var_expression.starts_with("input:") {
            // Handle user input for variables
            let input_var_name = var_expression.trim_start_matches("input:").trim();
            let mut user_input = String::new();

            print!("Enter value for '{}': ", input_var_name);
            io::stdout().flush().expect("Failed to flush stdout");
            io::stdin()
                .read_line(&mut user_input)
                .expect("Failed to read input");

            user_input.trim().to_string()

             } else {
                // Handle JS context variable substitution
                let var_name = var_expression;
                match ts_ctx.runtime.eval(&format!("SAT.globals.{}", var_name)) {
                    Ok(value) => {
                        if let Some(value_str) = value.as_str() {
                            value_str.to_string()
                        } else {
                            eprintln!(
                                "Warning: JS context variable '{}' is not a string. Leaving placeholder unchanged.",
                                var_name
                            );
                            caps[0].to_string() // Return the original placeholder
                        }
                    }
                    Err(_) => {
                        /*
                        eprintln!(
                            "Warning: JS context variable '{}' could not be evaluated. Leaving placeholder unchanged.",
                            var_name
                        );
                        */
                        caps[0].to_string() // Return the original placeholder
                    }
                }
            }
        })
        .to_string()
    }

    // Performs the following steps:
    // 1. Execute the pre-test-script if it exists.
    // 2. Retrieve global vars and substitute placeholders in test case parameters.
    // 3. if the test case is an "authorized" one, then add the JWT token to the headers.
    // 4. Setup delay between test cases.
    fn pre_run_ops(
        &mut self,
        ts_ctx: &mut TestCtx,
        sys_conifg: &Config,
    ) -> reqwest::blocking::RequestBuilder {
        // Execute pre_test script, if present.
        if let Some(pre_test_script) = &self.pre_test_script {
            // substitute keywords with values
            let pre_test_script = substitute_keywords(pre_test_script);

            // Execute pre-test-script if it exists.
            match ts_ctx.runtime.eval(&pre_test_script) {
                Ok(_) => (),
                Err(e) => eprintln!("Error executing pre_test_script: {}", e),
            }
        }
        // Prepare request object (vars substitution, auth handling, etc.)
        let req = self.prepare_request(ts_ctx, sys_conifg);

        // Setup delay between test cases.
        if self.config.delay > 0 {
            println!("Sleeping for {} ms", self.config.delay);
            std::thread::sleep(Duration::from_millis(self.config.delay));
        }
        req
    }

    // Performs the following steps:
    // 1. Execute the post-test-script if it exists.
    // 2. if the test case is an authorizer, then store the JWT token in the context.

    fn post_run_ops(&self, ts_ctx: &mut TestCtx, sys_config: &Config) {
        // Print test results.
        self.print_result(ts_ctx, sys_config.verbose);

        // Setup delay between test cases.
        if self.config.delay > 0 {
            println!("Sleeping for {} ms", self.config.delay);
            std::thread::sleep(Duration::from_millis(self.config.delay));
        }
    }

    fn prepare_payload(
        &mut self,
        request: reqwest::blocking::RequestBuilder,
    ) -> reqwest::blocking::RequestBuilder {
        let mut content_type_found = false;
        for (key, value) in self.headers.iter() {
            if key.to_lowercase() == "content-type" {
                content_type_found = true;
                match value.as_str() {
                    "application/json" => {
                        self.content_type = value.clone();
                        let payload_json: Value = serde_json::from_str(&self.effective_payload)
                            .unwrap_or(serde_json::json!({}));
                        return request.json(&payload_json);
                    }
                    "application/x-www-form-urlencoded" => {
                        self.content_type = value.clone();
                        let url_encoded_data =
                            serde_json::from_str(self.effective_payload.as_str())
                                .unwrap_or(serde_json::json!({}));
                        return request.form(&url_encoded_data);
                    }
                    "multipart/form-data" => {
                        self.content_type = value.clone();
                        let form_data = serde_json::from_str(self.effective_payload.as_str())
                            .unwrap_or(serde_json::json!({}));
                        return self.prepare_multipart_data(request, &form_data);
                    }
                    _ => {
                        eprintln!("Unsupported content type: {}", value);
                    }
                }
                break;
            }
        }
        // Default to JSON if no matching content type is found
        if !content_type_found {
            self.content_type = "application/json".to_string();
            let payload_json: Value =
                serde_json::from_str(&self.effective_payload).unwrap_or(serde_json::json!({}));
            return request.json(&payload_json);
        }
        request
    }

    fn prepare_multipart_data(
        &mut self,
        req: reqwest::blocking::RequestBuilder,
        data: &Value,
    ) -> reqwest::blocking::RequestBuilder {
        let mut form = reqwest::blocking::multipart::Form::new();
        let mut effective_payload_parts = Vec::new();

        // Define the boundary marker (you could use a unique value here)
        let boundary = "--boundary-placeholder";

        // Add fields
        if let Some(fields) = data["form-data"]["fields"].as_object() {
            for (key, value) in fields.clone() {
                if let Some(string_value) = value.as_str() {
                    // Add to form
                    form = form.text(key.clone(), string_value.to_string());

                    // Add to effective payload parts representation
                    effective_payload_parts.push(format!(
                        "--{}\r\nContent-Disposition: form-data; name=\"{}\"\r\n\r\n{}",
                        boundary, key, string_value
                    ));
                } else if value.is_object() || value.is_array() {
                    let serialized_value = serde_json::to_string(&value).unwrap();
                    // Add to form
                    form = form.text(key.clone(), serialized_value.clone());

                    // Add to the effective payload parts
                    effective_payload_parts.push(format!(
                        "--{}\r\nContent-Disposition: form-data; name=\"{}\"\r\n\r\n{}",
                        boundary, key, serialized_value
                    ));
                }
            }
        }

        // Add files
        if let Some(files) = data["form-data"]["files"].as_array() {
            for file_info in files {
                let field_name = file_info["fieldname"].as_str().unwrap();
                let file_path = file_info["filepath"].as_str().unwrap();

                println!("Adding file: {} as {}", file_path, field_name);
                let mut file = File::open(file_path).expect("file not found");
                let mut buffer = Vec::new();
                file.read_to_end(&mut buffer).expect("Error reading file");

                // Encode file contennt in base64
                let encoded = base64::encode(&buffer);

                // Create a multipart part from the file content
                let file_part =
                    multipart::Part::bytes(buffer.clone()).file_name(file_path.to_string());
                form = form.part(field_name.to_string(), file_part);

                // Add to effective payload parts representation
                effective_payload_parts.push(format!(
                "--boundary-placeholder\r\n\t\tContent-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\n\t\tContent-Type: application/octet-stream\r\n\r\n\t\t{}",
                field_name, file_path, encoded));
            }
        }

        // Final boundary for ending the multipart form
        effective_payload_parts.push(format!("--{}--", boundary));

        // Store the complete payload in 'effective_payload' field.
        self.effective_payload = effective_payload_parts.join("\r\n");

        //println!("Form: {:?}", form);
        return req.multipart(form);
    }

    fn print_payload(&self) {
        match self.content_type.as_str() {
            "application/json" => {
                match serde_json::from_str::<serde_json::Value>(&self.effective_payload) {
                    Ok(json) => {
                        let pretty_json = serde_json::to_string_pretty(&json).unwrap();
                        let indented_json = pretty_json.replace("\n", "\n\t\t");
                        println!("\tPayload: {}", indented_json);
                    }
                    Err(e) => eprintln!("Error parsing JSON: {}", e),
                }
            }
            "application/x-www-form-urlencoded" => {
                let form_data = serde_json::from_str(self.effective_payload.as_str())
                    .unwrap_or(serde_json::json!({}));
                println!("\tPayload: {:?}", form_data);
            }
            "multipart/form-data" => {
                //println!("\tPayload: {}", self.effective_payload);
                print_first_10_lines(&self.effective_payload);
            }
            content_type if content_type.starts_with("text/") => {
                //let text = String::from_utf8_lossy(&self.effective_payload);
                // Print the first 10 lines if possible
                print_first_10_lines(&self.effective_payload);
            }

            _ => {
                // Assume its binary.
                println!("\tBinary data (Base64 encoded, first 1024 bytes):");
                let max_bytes = 1024.min(self.effective_payload.len());
                let payload_bytes = &self.effective_payload.as_bytes()[..max_bytes];

                // Define the indentation string
                let indent = "\t\t";

                // Print the data in chunks of 80 characters
                for chunk in payload_bytes[..max_bytes].chunks(80) {
                    println!("{}{}", indent, String::from_utf8_lossy(chunk));
                }
            }
        }
    }
}

fn substitute_keywords(input: &str) -> String {
    let mut output = input.to_string();
    if output.contains("$RandomName") {
        output = output.replace("$RandomName", &bc::random_name());
    }
    if output.contains("$RandomPhone") {
        output = output.replace("$RandomPhone", &bc::random_phone());
    }
    if output.contains("$RandomAddress") {
        output = output.replace("$RandomAddress", &bc::random_address());
    }
    if output.contains("$RandomCompany") {
        output = output.replace("$RandomCompany", &bc::generate_company_name());
    }
    if output.contains("$RandomEmail()") {
        output = output.replace("$RandomEmail()", &bc::random_email(None));
    }
    let re = Regex::new(r#"\$RandomEmail\("(.+?)"\)"#).unwrap();
    if let Some(captures) = re.captures(&output) {
        if let Some(domain) = captures.get(1) {
            let placeholder = format!("$RandomEmail(\"{}\")", domain.as_str());
            let replacement = bc::random_email(Some(domain.as_str()));
            output = output.replace(&placeholder, &replacement);
        }
    }
    output
}

fn show_progress<'a>(url: &'a str, pb: &'a ProgressBar) -> &'a ProgressBar {
    // Display a message to the user
    pb.set_message(format!("Fetching {}...", url));
    pb.enable_steady_tick(Duration::from_millis(100));
    pb
}

fn stop_progress(pb: &ProgressBar) {
    // Stop progress animation
    pb.disable_steady_tick();
    pb.finish_with_message("Done");
}

fn print_first_10_lines(text: &str) {
    let mut lines = text.lines();
    for _ in 0..10 {
        if let Some(line) = lines.next() {
            println!("{}", line);
        } else {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Ok;
    use calamine::{open_workbook, Data, Reader, Xlsx};
    //use std::io::{self, Read};
    use std::sync::{Arc, Mutex};

    fn read_excel_row(file: &str, sheet: &str, row: usize) -> Result<Vec<Data>, anyhow::Error> {
        let mut workbook: Xlsx<_> = open_workbook(file).unwrap();
        let sheet = workbook.worksheet_range(sheet).unwrap();
        let row_data = sheet
            .rows()
            .nth(row)
            .ok_or(anyhow::anyhow!("Row not found"))?;
        Ok(row_data.to_vec())
    }

    #[test]
    fn test_env_vars() {
        let mut ts_ctx = TestCtx::new().unwrap();
        env::set_var("TEST_VAR", "test_value");
        let input = "Hello {{env:TEST_VAR}}";
        let tc = TestCase::dummy();
        let output = tc.substitute_placeholders(input, &mut ts_ctx);
        assert_eq!(output, "Hello test_value");
    }
    #[test]
    fn test_substitute_keywords() {
        let input = "Hello $RandomName, your phone number is $RandomPhone";
        let output = substitute_keywords(input);
        assert!(output.contains("Hello "));
        assert!(!output.contains("$RandomName"));
        assert!(output.contains(", your phone number is "));
        assert!(!output.contains("$RandomPhone"));
    }
}
