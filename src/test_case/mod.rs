pub mod data;
pub mod excel_parser;
pub mod keywords;
pub mod placeholders;
pub mod progress;

pub use data::*;
pub use excel_parser::*;
// pub use keywords::*; // Not needed as substitute_keywords is used directly
pub use placeholders::*;
pub use progress::*;

use crate::test_events::{TestCaseBegin, TestCaseEnd, TestEvent};
use crate::{config::Config, test_context::TestCtx};
use colored::Colorize;
use indicatif::ProgressBar;
use reqwest::blocking::multipart;
use serde_json::Value;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::{sync::mpsc::Sender, time::Duration};
use mime_guess::from_path;

#[derive(Debug, Clone)]
pub struct TestCase {
    pub data: TestCaseData,
    pub execution_state: ExecutionState,
    pub errors: Vec<(String, String)>, // Legacy error format for compatibility
}

impl TestCase {

    /// Initializes a test case object with a row of data from excel sheet.
    pub fn new(row: &[calamine::Data], config: &Config) -> Self {
        match ExcelRowParser::parse_test_case_data(row, config) {
            Ok(data) => TestCase {
                data,
                execution_state: ExecutionState::new(),
                errors: Vec::new(),
            },
            Err(parse_errors) => {
                // Convert ParseErrors to legacy format for compatibility
                let errors: Vec<(String, String)> = parse_errors.errors
                    .into_iter()
                    .map(|e| (e.field, e.message))
                    .collect();
                
                TestCase {
                    data: TestCaseData {
                        id: 0,
                        name: String::new(),
                        given: String::new(),
                        when: String::new(),
                        then: String::new(),
                        url: String::new(),
                        method: reqwest::Method::GET,
                        headers: Vec::new(),
                        payload: String::new(),
                        config: Default::default(),
                        scripts: TestScripts {
                            pre_test: None,
                            post_test: None,
                        },
                    },
                    execution_state: ExecutionState::new(),
                    errors,
                }
            }
        }
    }

    /// Executes the test case, by using the provided http client and an optional JWT token.
    pub fn run(
        &mut self,
        ts_ctx: &mut TestCtx,
        sys_config: &Config,
        tx: &Sender<TestEvent>,
    ) -> TestResult {
        // Fire an event indicating that the test case execution has started.
        self.fire_start_evt(tx);

        println!("Running the test case: {}", self.data.name);

        // Verify if the test case has errors, if so return without executing.
        if !self.errors.is_empty() {
            println!(
                "Skipping test case: {} due to errors: {:?}",
                self.data.name, self.errors
            );
            return TestResult::Skipped;
        }

        let mut overall_result = TestResult::Passed;

        // Execute the test case as per the configuration found in the test case.
        println!("Test case configurations {:?}", self.data.config);
        for _ in 0..self.data.config.repeat_count {
            let req = self.pre_run_ops(ts_ctx, sys_config);
            let spinner = ProgressBar::new_spinner();
            ProgressDisplay::show_progress(&self.execution_state.effective_url, &spinner);
            self.execute_request(ts_ctx, req, sys_config, tx);
            if self.execution_state.result == TestResult::Failed {
                overall_result = TestResult::Failed;
                ProgressDisplay::stop_progress(&spinner);
                self.post_run_ops(ts_ctx, sys_config);
                break;
            }
            ProgressDisplay::stop_progress(&spinner);
            self.post_run_ops(ts_ctx, sys_config);
        }

        overall_result
    }

    fn prepare_request(
        &mut self,
        ts_ctx: &mut TestCtx,
        _config: &Config,
    ) -> reqwest::blocking::RequestBuilder {
        let placeholder_resolver = PlaceholderResolver;
        
        // 1. Retrieve global variables and substitute placeholders in test case parameters
        self.execution_state.effective_name = placeholder_resolver.substitute_placeholders(&self.data.name, ts_ctx);
        self.execution_state.effective_url = placeholder_resolver.substitute_placeholders(&self.data.url, ts_ctx);
        self.execution_state.effective_payload = placeholder_resolver.substitute_placeholders(&self.data.payload, ts_ctx);

        // 2. if the test case is authorized, then add the jwt token to the headers.
        let mut headers = self.data.headers.clone();
        if self.data.config.is_authorized() {
            if let Some(token) = ts_ctx.jwt_token.as_ref() {
                headers.push(("Authorization".to_owned(), format!("Bearer {}", token)));
            }
        }

        // 3. Frame the request based on Method type, add headers.
        let mut request = ts_ctx
            .client
            .request(self.data.method.clone(), &self.execution_state.effective_url);

        // Finally, add the headers to the request.
        for (key, value) in &headers {
            // Ignore the content-type header, as it will be handled separately.
            if key.to_lowercase() == "content-type" {
                continue;
            }
            request = request.header(key, value);
        }

        // Prepare payload and return.
        self.prepare_payload(request, &headers)
    }

    fn execute_request(
        &mut self,
        ts_ctx: &mut TestCtx,
        req: reqwest::blocking::RequestBuilder,
        config: &Config,
        tx: &Sender<TestEvent>,
    ) {
        // Fire the request using blocking call.
        ts_ctx.exec(req, self.data.config.is_authorizer(), &config);

        // Execute the post test script and verify the result.
        let result = ts_ctx.verify_result(self.data.scripts.post_test.as_deref());

        // store the test result as an enum.
        let test_result = match result {
            true => TestResult::Passed,
            false => TestResult::Failed,
        };
        self.execution_state.result = test_result;

        // Fire test case end evt.
        self.fire_end_evt(tx, ts_ctx);
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
            testcase_id: self.data.id,
            testcase_name: self.data.name.clone(),
            given: self.data.given.clone(),
            when: self.data.when.clone(),
            then: self.data.then.clone(),
            url: self.data.url.clone(),
            method: self.data.method.to_string(),
            headers: self.data.headers.clone(),
            payload: self.data.payload.clone(),
            pre_test_script: self.data.scripts.pre_test.clone(),
            post_test_script: self.data.scripts.post_test.clone(),
        }
    }

    fn get_end_evt_data(&self, ts_ctx: &mut TestCtx) -> TestCaseEnd {
        TestCaseEnd {
            timestamp: std::time::Instant::now(),
            iteration_id: "1".to_string(),
            testcase_id: self.data.id,
            exec_duration: Duration::from_secs(0),
            status: self.get_exec_status(ts_ctx),
            response: self.get_exec_response(ts_ctx),
            response_json: self.get_exec_response_json(ts_ctx),
        }
    }

    fn get_exec_status(&self, ts_ctx: &mut TestCtx) -> i64 {
        ts_ctx
            .runtime
            .eval("SAT.response.status")
            .unwrap_or_default()
            .as_i64()
            .unwrap_or_default()
    }

    fn get_exec_response(&self, ts_ctx: &mut TestCtx) -> String {
        ts_ctx
            .runtime
            .eval("SAT.response.body")
            .unwrap_or_default()
            .as_str()
            .unwrap_or_default()
            .to_string()
    }

    fn get_exec_response_json(&self, ts_ctx: &mut TestCtx) -> Option<serde_json::Value> {
        match serde_json::from_str::<serde_json::Value>(&self.get_exec_response(ts_ctx)) {
            Ok(json) => Some(json),
            Err(_) => None,
        }
    }

    pub fn print_result(&self, ts_ctx: &mut TestCtx, verbose: bool) {
        println!("{:<15}: {}", "Test Case ID", self.data.id);
        println!("{:<15}: {}", "Test Case", self.data.name);
        println!("{:<15}: {}", "Given", self.data.given);
        println!("{:<15}: {}", "When", self.data.when);
        println!("{:<15}: {}", "Then", self.data.then);
        println!("{:<15}: {}", "Expected", ts_ctx.get_test_name());
        println!("{:<15}: {}", "Actual", ts_ctx.get_http_status());

        // print the below, if only verbose flag is enabled.
        if verbose {
            self.print_request_info();
            ts_ctx.print_response_info();
        }

        // finally print the pass / fail / skip status with symbols.
        match self.execution_state.result {
            TestResult::Passed => println!("{:<15}: {}", "Result", "✅ PASSED".green()),
            TestResult::Failed => println!("{:<15}: {}", "Result", "❌ FAILED".red()),
            TestResult::Skipped => println!("{:<15}: {}", "Result", "⚠️ SKIPPED".yellow()),
            _ => (),
        }
    }

    pub fn print_request_info(&self) {
        println!("Request Info: ");
        println!("\tMethod: {:?}", self.data.method);
        println!("\tURL: {}", self.execution_state.effective_url);
        if !self.data.headers.is_empty() {
            println!("\tHeaders: ");
            for (key, value) in &self.data.headers {
                let value = value.replace("\n", "");
                println!("\t\t{}: {}", key, value);
            }
        }
        self.print_payload();
    }

    // Performs the following steps:
    // 1. Execute the pre-test-script if it exists.
    // 2. Retrieve global vars and substitute placeholders in test case parameters.
    // 3. if the test case is an "authorized" one, then add the JWT token to the headers.
    // 4. Setup delay between test cases.
    fn pre_run_ops(
        &mut self,
        ts_ctx: &mut TestCtx,
        sys_config: &Config,
    ) -> reqwest::blocking::RequestBuilder {
        // Execute pre_test script, if present.
        if let Some(pre_test_script) = &self.data.scripts.pre_test {
            // Execute pre-test-script if it exists.
            match ts_ctx.runtime.eval(&pre_test_script) {
                Ok(_) => (),
                Err(e) => eprintln!("Error executing pre_test_script: {}", e),
            }
        }
        
        // Prepare request object (vars substitution, auth handling, etc.)
        let req = self.prepare_request(ts_ctx, sys_config);

        // Setup delay between test cases.
        if self.data.config.delay > 0 {
            println!("Sleeping for {} ms", self.data.config.delay);
            std::thread::sleep(Duration::from_millis(self.data.config.delay));
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
        if self.data.config.delay > 0 {
            println!("Sleeping for {} ms", self.data.config.delay);
            std::thread::sleep(Duration::from_millis(self.data.config.delay));
        }
    }

    fn prepare_payload(
        &mut self,
        request: reqwest::blocking::RequestBuilder,
        headers: &[(String, String)],
    ) -> reqwest::blocking::RequestBuilder {
        let ct_lower = headers
            .iter()
            .find(|(k, _)| k.to_lowercase() == "content-type")
            .map(|(_, v)| v.to_lowercase());

        match ct_lower.as_deref() {
            Some("application/json") => {
                self.execution_state.content_type = "application/json".to_string();
                let payload_json: Value =
                    serde_json::from_str(&self.execution_state.effective_payload).unwrap_or(serde_json::json!({}));
                request.json(&payload_json)
            }
            Some("application/x-www-form-urlencoded") => {
                self.execution_state.content_type = "application/x-www-form-urlencoded".to_string();
                let url_encoded_data =
                    serde_json::from_str(&self.execution_state.effective_payload).unwrap_or(serde_json::json!({}));
                request.form(&url_encoded_data)
            }
            Some("multipart/form-data") => {
                self.execution_state.content_type = "multipart/form-data".to_string();
                let form_data =
                    serde_json::from_str(&self.execution_state.effective_payload).unwrap_or(serde_json::json!({}));
                self.prepare_multipart_data(request, &form_data)
            }
            None if self.execution_state.effective_payload.contains("form-data") => {
                self.execution_state.content_type = "multipart/form-data".to_string();
                let form_data =
                    serde_json::from_str(&self.execution_state.effective_payload).unwrap_or(serde_json::json!({}));
                self.prepare_multipart_data(request, &form_data)
            }
            other => {
                eprintln!(
                    "Unsupported or missing Content-Type: {:?}, defaulting to application/json",
                    other
                );
                self.execution_state.content_type = "application/json".to_string();
                let payload_json: Value =
                    serde_json::from_str(&self.execution_state.effective_payload).unwrap_or(serde_json::json!({}));
                request.json(&payload_json)
            }
        }
    }

    fn prepare_multipart_data(
        &mut self,
        req: reqwest::blocking::RequestBuilder,
        data: &Value,
    ) -> reqwest::blocking::RequestBuilder {
        let mut form = reqwest::blocking::multipart::Form::new();
        let mut effective_payload_parts = Vec::new();

        // Define the boundary marker
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

                let filename = Path::new(file_path)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .to_string();
                let mime_type = from_path(file_path).first_or_octet_stream();

                // Create a multipart part from the file content
                let file_part = multipart::Part::bytes(buffer.clone())
                    .file_name(filename.clone())
                    .mime_str(mime_type.as_ref())
                    .unwrap();
                form = form.part(field_name.to_string(), file_part);

                // Add to effective payload parts representation
                effective_payload_parts.push(format!(
                    "--boundary-placeholder\r\n\
                    Content-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\n\
                    Content-Type: application/octet-stream\r\n\r\n\
                    <binary content omitted for display>",
                    field_name, file_path
                ));
            }
        }

        // Final boundary for ending the multipart form
        effective_payload_parts.push(format!("--{}--", boundary));

        // Store the complete payload in 'effective_payload' field.
        self.execution_state.effective_payload = effective_payload_parts.join("\r\n");

        req.multipart(form)
    }

    fn print_payload(&self) {
        match self.execution_state.content_type.as_str() {
            "application/json" => {
                match serde_json::from_str::<serde_json::Value>(&self.execution_state.effective_payload) {
                    Ok(json) => {
                        let pretty_json = serde_json::to_string_pretty(&json).unwrap();
                        let indented_json = pretty_json.replace("\n", "\n\t\t");
                        println!("\tPayload: {}", indented_json);
                    }
                    Err(e) => eprintln!("Error parsing JSON: {}", e),
                }
            }
            "application/x-www-form-urlencoded" => {
                let form_data = serde_json::from_str(self.execution_state.effective_payload.as_str())
                    .unwrap_or(serde_json::json!({}));
                println!("\tPayload: {:?}", form_data);
            }
            "multipart/form-data" => {
                print_first_n_lines(&self.execution_state.effective_payload, 100);
            }
            content_type if content_type.starts_with("text/") => {
                print_first_n_lines(&self.execution_state.effective_payload, 100);
            }
            _ => {
                // Assume its binary.
                println!("\tBinary data (Base64 encoded, first 1024 bytes):");
                let max_bytes = 1024.min(self.execution_state.effective_payload.len());
                let payload_bytes = &self.execution_state.effective_payload.as_bytes()[..max_bytes];

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

// Keep the original tests but update them to use the new structure
#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use crate::test_context::TestCtx;

    #[test]
    fn test_env_vars() {
        let mut ts_ctx = TestCtx::new().unwrap();
        let resolver = PlaceholderResolver;
        env::set_var("TEST_VAR", "test_value");
        let input = "Hello {{env:TEST_VAR}}";
        let output = resolver.substitute_placeholders(input, &mut ts_ctx);
        assert_eq!(output, "Hello test_value");
    }

    // Additional tests from the original file can be added here...
}