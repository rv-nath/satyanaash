use crate::test_events::{TestCaseBegin, TestCaseEnd, TestEvent};
use crate::{config::Config, test_context::TestCtx};
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
use std::fs::File;
use std::io::Read;
use std::{sync::mpsc::Sender, time::Duration};

// Possible test case results.
#[derive(Debug, Clone)]
pub enum TestResult {
    NotYetTested,
    Passed,
    Failed,
    Skipped,
}

/*
#[derive(Debug, Clone)]
enum PayloadType {
    Json,
    FormData,
    UrlEncoded,
}
*/

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
    #[serde(default = "default_data_source")]
    data_source: String, // For repeating the test case with different data sets. A csv file path that cotnains
    #[serde(default = "default_auth_type")]
    auth_type: AuthType, // Indicates if the test case generates or consumes a JWT
    #[serde(default = "default_delay")]
    delay: u64, // Delay between test case execution (in millis).
}

impl Default for TestCaseConfig {
    fn default() -> Self {
        TestCaseConfig {
            repeat_count: default_repeat_count(),
            data_source: default_data_source(),
            auth_type: default_auth_type(),
            delay: default_delay(),
        }
    }
}

/*
impl TestCaseConfig {
    // A `new` method for creating instances of `TestCaseConfig` with custom values.
    pub fn new(repeat_count: u32, data_source: String, auth_type: AuthType, delay: u64) -> Self {
        TestCaseConfig {
            repeat_count,
            data_source,
            auth_type,
            delay,
        }
    }
}
*/

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

    // fields that will be filled after test case is executed..
    //exec_duration: std::time::Duration,
    result: TestResult,
}

impl TestCase {
    // Initializes a test case object with a row of data from excel sheet.
    //pub fn new(row: &[&dyn calamine::DataType], config: &Config) -> Self {
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
                let full_url = format!(
                    "{}{}",
                    <std::option::Option<std::string::String> as Clone>::clone(&config.base_url)
                        .unwrap_or_default(),
                    s
                );
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

        let overall_result = TestResult::Passed;

        // Execute the test case as per the configuration found in the test case.
        println!("Test case configurations {:?}", self.config);
        for _ in 0..self.config.repeat_count {
            let req = self.pre_run_ops(ts_ctx, sys_config);
            let spinner = ProgressBar::new_spinner();
            show_progress(&mut self.url, &spinner);
            let _test_result = self.execute_request(ts_ctx, req, sys_config, tx);
            stop_progress(&spinner);
            self.post_run_ops(ts_ctx, sys_config);
        }

        self.result.clone()
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
            //is_authorizer: self.is_authorizer,
            //is_authorized: self.is_authorized,
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
        match self.method {
            reqwest::Method::POST | reqwest::Method::PUT | reqwest::Method::PATCH => {
                match serde_json::from_str::<serde_json::Value>(&self.effective_payload) {
                    Ok(json) => {
                        let pretty_json = serde_json::to_string_pretty(&json).unwrap();
                        let indented_json = pretty_json.replace("\n", "\n\t\t");
                        println!("\tPayload: {}", indented_json);
                    }
                    Err(_) => println!("\tPayload: {}", &self.effective_payload),
                }
            }
            _ => {}
        }
    }

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
        &self,
        request: reqwest::blocking::RequestBuilder,
    ) -> reqwest::blocking::RequestBuilder {
        let mut content_type_found = false;
        for (key, value) in self.headers.iter() {
            if key.to_lowercase() == "content-type" {
                content_type_found = true;
                match value.as_str() {
                    "application/json" => {
                        let payload_json: Value = serde_json::from_str(&self.effective_payload)
                            .unwrap_or(serde_json::json!({}));
                        return request.json(&payload_json);
                    }
                    "application/x-www-form-urlencoded" => {
                        let url_encoded_data =
                            serde_json::from_str(self.effective_payload.as_str())
                                .unwrap_or(serde_json::json!({}));
                        return request.form(&url_encoded_data);
                    }
                    "multipart/form-data" => {
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
            let payload_json: Value =
                serde_json::from_str(&self.effective_payload).unwrap_or(serde_json::json!({}));
            return request.json(&payload_json);
        }
        request
    }

    fn prepare_multipart_data(
        &self,
        req: reqwest::blocking::RequestBuilder,
        data: &Value,
    ) -> reqwest::blocking::RequestBuilder {
        let mut form = reqwest::blocking::multipart::Form::new();

        // Add fields
        if let Some(fields) = data["form-data"]["fields"].as_object() {
            for (key, value) in fields.clone() {
                form = form.text(key.clone(), value.as_str().unwrap().to_string());
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

                // Create a multipart part from the file content
                let file_part = multipart::Part::bytes(buffer).file_name(file_path.to_string());
                form = form.part(field_name.to_string(), file_part);
            }
        }
        println!("Form: {:?}", form);
        return req.multipart(form);
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
