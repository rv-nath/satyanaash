use colored::Colorize;
use reqwest::{Method, StatusCode, Url};
use serde_json::Value;
use std::time::Duration;

use indicatif::ProgressBar;

use crate::config::Config;

#[derive(Debug)]

pub struct TestCase {
    id: u32,                        // test case identifier (typically a number)
    name: String,                   // human readable name for the test case.
    given: String,                  // test case description for the given condition (Given)
    when: String,                   // test case description for the then condition  (When)
    then: String,                   // test case description. for resulting condition. (Then)
    url: String,                    // URL of the request
    method: Method,                 // http method for the request.
    headers: Vec<(String, String)>, // http headers for the request, if any.
    payload: Value,                 // payload (json) to be sent with the request.
    //expected_status: StatusCode,    // expected http status code.
    expected_status: i32, // expected http status code.
    is_authorizer: bool,  // indicates if this is an authorization endpoint.
    is_authorized: bool,  // indicates if this requires authorization.

    errors: Vec<(String, String)>, // List of errors found while reading excel data.
    //
    // fields that will be filled after test case is executed..
    //actual_status: Option<reqwest::StatusCode>, // http status received after the request.
    actual_status: i32, // Received http status, else a negative number, for some failure.
    //response: Option<ResponseType>,
    response_body: String,
    exec_duration: Option<Duration>, // time taken for executing the request.
}

pub enum TestResult {
    NotYetTested,
    Passed,
    Failed,
    Skipped,
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
            Some(s) => match serde_json::from_str(s) {
                Ok(v) => v,
                Err(_) => {
                    errors.push(("payload".to_string(), "Invalid JSON payload.".to_string()));
                    Value::Null
                }
            },
            None => Value::Null,
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

            //actual_status: Option::<reqwest::StatusCode>::None,
            actual_status: 0,
            //response: None,
            response_body: String::new(),
            exec_duration: Option::<Duration>::None,
        }
    }

    // Executes the test case, by using the provided http client  and an optional JWT token.
    // Returns an optional JWT token (if it was an authorization endpoint).
    pub fn run(&mut self, client: &reqwest::blocking::Client, jwt: Option<&str>) -> Option<String> {
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

        // if the test case is authorized, then add the jwt token to the headers.
        if self.is_authorized {
            if let Some(token) = jwt {
                self.headers
                    .push(("Authorization".to_owned(), format!("Bearer {}", token)));
            }
        }

        // Frame the request based on Method type, add headers.
        let mut request = client.request(self.method.clone(), &self.url);
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

        // Strat timer tracking..
        let start = std::time::Instant::now();

        // Fire the request using blocking call.
        let result = request.send();
        let (status, body) = match result {
            Ok(response) => {
                let status = response.status().as_u16() as i32;
                let body = response
                    .text()
                    .unwrap_or_else(|_| String::from("Failed to read resposne body"));
                (status, body)
            }
            Err(e) => {
                println!("Network error");
                (1, format!("Network error: {}", e))
            }
        };

        pb.disable_steady_tick();

        // Set the actual status and exec durations
        self.actual_status = status;
        self.response_body = body;
        self.exec_duration = Some(start.elapsed());

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

    // Returns the test result of the test case.
    pub fn result(&self) -> TestResult {
        if self.errors.len() > 0 {
            return TestResult::Skipped;
        }

        if self.actual_status == 0 {
            return TestResult::NotYetTested;
        }

        if self.actual_status == self.expected_status {
            TestResult::Passed
        } else {
            TestResult::Failed
        }
    }

    pub fn print_result(&self, verbose: bool) {
        println!("Test Case ID: {}", self.id);
        println!("Test Case: {}", self.name);
        println!("Given: {:?}", self.given);
        println!("When: {:?}", self.when);
        println!("Then: {:?}", self.then);
        println!("Expected: {}", self.expected_status);
        println!("Actual: {}", self.actual_status);

        // print only if -v (--verbose) flag is provided in command line.
        if verbose {
            self.print_request_info();
            self.print_response_info();
        }
        //if StatusCode::from_u16(self.expected_status as u16).unwrap() == self.actual_status {
        if self.expected_status == self.actual_status {
            println!("Result: {}", "[PASS] ✔".green());
        } else {
            println!("Result: {}", "[FAIL] ✘".red());
        }
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

    pub fn print_response_info(&self) {
        println!("Response Info: ");
        println!("\tStatus: {:?}", self.actual_status);
        println!("\tDuration: {:?}", self.exec_duration);
    }
}
