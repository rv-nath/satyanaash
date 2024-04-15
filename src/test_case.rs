use colored::Colorize;
use regex::Regex;
use reqwest::{Method, StatusCode, Url};
use serde_json::Value;
use std::time::Duration;

use indicatif::ProgressBar;

use crate::{config::Config, test_suite_context::TestSuiteCtx};

//#[derive(Debug)]

pub struct TestCase {
    id: u32,                        // test case identifier (typically a number)
    name: String,                   // human readable name for the test case.
    given: String,                  // test case description for the given condition (Given)
    when: String,                   // test case description for the then condition  (When)
    then: String,                   // test case description. for resulting condition. (Then)
    url: String,                    // URL of the request
    method: Method,                 // http method for the request.
    headers: Vec<(String, String)>, // http headers for the request, if any.
    //payload: Value,                 // payload (json) to be sent with the request.
    payload: String, // payload to be sent with the request.
    //expected_status: StatusCode,    // expected http status code.
    expected_status: i32,             // expected http status code.
    is_authorizer: bool,              // indicates if this is an authorization endpoint.
    is_authorized: bool,              // indicates if this requires authorization.
    pre_test_script: Option<String>,  // script to be executed before the test case.
    post_test_script: Option<String>, // script to be executed after the test case.

    errors: Vec<(String, String)>, // List of errors found while reading excel data.

    // fields that will be filled after test case is executed..
    actual_status: i32, // Received http status, else a negative number, for some failure.
    response_body: String,
    exec_duration: Option<Duration>, // time taken for executing the request.
    script_result: Option<bool>,     // result of the post-test script.
}

impl TestCase {
    // Initializes a test case object with a row of data from excel sheet.
    pub fn new(row: &[&dyn calamine::DataType], config: &Config) -> Self {
        let mut errors = Vec::new();

        let id = match row[0].get_float() {
            Some(f) => f as u32,
            None => {
                errors.push(("id".to_owned(), "ID is not a number.".to_owned()));
                0
            }
        };
        let name = match row[1].get_string() {
            Some(s) => s.to_owned(),
            None => {
                errors.push(("name".to_owned(), "Invalid name field".to_owned()));
                "".to_string()
            }
        };
        let given = match row[2].get_string() {
            Some(s) => s.to_owned(),
            None => {
                errors.push((
                    "given".to_owned(),
                    "Invalid data for 'given' field.".to_string(),
                ));
                "".to_string()
            }
        };

        let when = match row[3].get_string() {
            Some(s) => s.to_owned(),
            None => {
                errors.push((
                    "when".to_owned(),
                    "Invalid data for 'when' field.".to_string(),
                ));
                "".to_string()
            }
        };

        let then = match row[4].get_string() {
            Some(s) => s.to_owned(),
            None => {
                errors.push((
                    "then".to_string(),
                    "Invalid data for 'then' field.".to_string(),
                ));
                "".to_string()
            }
        };

        let url = match row[5].get_string() {
            Some(s) => {
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

        let headers = match row[7].get_string() {
            Some(s) => s
                .split(',')
                .filter_map(|header| {
                    let parts: Vec<&str> = header.split(':').collect();
                    if parts.len() == 2 {
                        Some((parts[0].to_owned(), parts[1].to_owned()))
                    } else {
                        None
                    }
                })
                .collect(),
            None => Vec::new(),
        };

        let payload = match row[8].get_string() {
            Some(s) => match serde_json::from_str::<serde_json::Value>(s) {
                Ok(_) => s.to_owned(),
                Err(_) => {
                    errors.push(("payload".to_string(), "Invalid JSON payload.".to_string()));
                    "".to_string()
                }
            },
            None => "".to_owned(),
        };

        let expected_status = match row[9].get_float() {
            Some(i) => match StatusCode::from_u16(i as u16) {
                Ok(s) => s.as_u16() as i32,
                Err(_) => {
                    errors.push((
                        "expected_status".to_string(),
                        "Invalid HTTP status code.".to_string(),
                    ));
                    0
                }
            },
            None => 0,
        };

        let (is_authorizer, is_authorized) = match row[10].get_string() {
            Some(s) => match s.to_lowercase().as_str() {
                "authorizer" => (true, false),
                "authorized" => (false, true),
                _ => (false, false),
            },
            None => (false, false),
        };

        let pre_test_script = match row[11].get_string() {
            Some(s) => Some(s.to_owned()),
            None => None,
        };
        let post_test_script = match row[12].get_string() {
            Some(s) => Some(s.to_owned()),
            None => None,
        };

        TestCase {
            id,
            name,
            given,
            when,
            then,
            url,
            method,
            headers,
            payload,
            expected_status,
            is_authorized,
            is_authorizer,
            errors,

            actual_status: 0,
            response_body: String::new(),
            exec_duration: Option::<Duration>::None,
            pre_test_script,
            post_test_script,
            script_result: None,
        }
    }

    // Executes the test case, by using the provided http client  and an optional JWT token.
    // Returns an optional JWT token (if it was an authorization endpoint).
    pub fn run(&mut self, ts_ctx: &mut TestSuiteCtx) -> Option<String> {
        println!("Running the test case: {}", self.name);

        // Verify if the test case has errors, if so return without executing.
        // if the test case has errors then return without executing.
        if self.errors.len() > 0 {
            println!(
                "Skipping test case: {} due to errors: {:?}",
                self.name, self.errors
            );
            return None;
        }

        // Execute pre_test_script if it exists
        if let Some(pre_test_script) = &self.pre_test_script {
            match ts_ctx.runtime.eval(pre_test_script) {
                Ok(_) => (),
                Err(e) => eprintln!("Error executing pre_test_script: {}", e),
            }
        }

        // Retrieve global variables and substitute placeholders in test case parameters
        self.name = self.substitute_placeholders(&self.name, ts_ctx);
        self.url = self.substitute_placeholders(&self.url, ts_ctx);
        self.payload = self.substitute_placeholders(&self.payload, ts_ctx);
        // TODO: for other columns..

        // if the test case is authorized, then add the jwt token to the headers.
        if self.is_authorized {
            if let Some(token) = ts_ctx.jwt_token.as_ref() {
                self.headers
                    .push(("Authorization".to_owned(), format!("Bearer {}", token)));
            }
        }

        // Frame the request based on Method type, add headers.
        let mut request = ts_ctx.client.request(self.method.clone(), &self.url);
        for (key, value) in &self.headers {
            request = request.header(key, value);
        }

        // Only set the request body for HTTP methods that can have a request body.
        match self.method {
            reqwest::Method::POST | reqwest::Method::PUT | reqwest::Method::PATCH => {
                request = request.json(&self.payload);
            }
            _ => {}
        }

        // Create a new progress bar
        let pb = ProgressBar::new_spinner();

        // Display a message to the user
        print!("Fetching {}...", self.url);
        pb.set_message(format!("Fetching {}...", self.url));
        pb.enable_steady_tick(Duration::from_millis(100));

        // Fire the request using blocking call.
        ts_ctx.exec(request);

        // Stop progress animation
        pb.disable_steady_tick();

        /*
        // Execute the post-test script
        if let Some(post_test_script) = &self.post_test_script {
            match ts_ctx.runtime.eval_as::<bool>(&post_test_script) {
                Ok(result_bool) => {
                    self.script_result = Some(result_bool);
                }
                Err(e) => {
                    eprintln!("Error executing the post-test script: {}", e);
                    self.script_result = Some(false);
                    return None;
                }
            }
        }
        */

        // Return the JWT token if it was an authorization endpoint.
        if self.is_authorizer {
            // parse the response body as json
            let response_json = match serde_json::from_str::<Value>(&self.response_body) {
                Ok(json) => json,
                Err(_) => {
                    println!(
                        "Warning: Authorizer request expected JSON response, but received: {:?}",
                        &self.response_body
                    );
                    return None;
                }
            };

            // capture jwt token from the response.
            let jwt_token = response_json["access_token"]
                .as_str()
                .map(|token| token.to_owned());

            return jwt_token;
        }
        None
    }

    pub fn print_result(&self, ts_ctx: &TestSuiteCtx, verbose: bool) {
        println!("Test Case ID: {}", self.id);
        println!("Test Case: {}", self.name);
        println!("Given: {:?}", self.given);
        println!("When: {:?}", self.when);
        let then = if let Some(_post_test_script) = &self.post_test_script {
            ts_ctx.get_test_name()
        } else {
            self.then.to_owned()
        };
        println!("Then: {:?}", then);
        println!("Expected: {}", ts_ctx.get_test_name());
        println!("Actual: {}", ts_ctx.get_http_status());

        // print only if -v (--verbose) flag is provided in command line.
        let test_result = ts_ctx.verify_result(self.post_test_script.as_deref());
    }

    pub fn print_request_info(&self) {
        println!("Request Info: ");
        println!("\tMethod: {:?}", self.method);
        println!("\tURL: {}", self.url);
        if !self.headers.is_empty() {
            println!("\tHeaders: ");
            for (key, value) in &self.headers {
                println!("\t\t{}: {}", key, value);
            }
        }
        match self.method {
            reqwest::Method::POST | reqwest::Method::PUT | reqwest::Method::PATCH => {
                println!("\tPayload: {:#?}", self.payload);
            }
            _ => {}
        }
    }

    fn substitute_placeholders(&self, original: &str, ts_ctx: &TestSuiteCtx) -> String {
        let mut result = original.to_string();
        let re = Regex::new(r"\{\{(.*?)\}\}").unwrap();
        for cap in re.captures_iter(original) {
            let var_name = &cap[1];
            match ts_ctx.runtime.eval(&format!("globals.{}", var_name)) {
                Ok(value) => {
                    if let Some(value_str) = value.into_string() {
                        result = result.replace(&format!("{{{{{}}}}}", var_name), &value_str);
                    }
                }
                Err(_) => (),
            }
        }
        result
    }
}
