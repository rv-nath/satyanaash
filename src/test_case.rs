use colored::{self, Colorize};
use std::error::Error;

use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue},
    Method, StatusCode,
};
use serde_json::Value;

#[derive(Debug)]
pub struct TestCase {
    pub id: u32,
    pub name: String,
    pub given: String,
    pub when: String,
    pub then: String,
    pub url: String,
    pub method: Method,
    pub headers: Vec<(String, String)>,
    pub payload: Value,
    pub expected_status: StatusCode,

    // fields that will be filled after test case is executed..
    pub actual_status: Option<reqwest::StatusCode>,
    pub response: serde_json::Value,
}

impl TestCase {
    pub fn new() -> Self {
        TestCase {
            id: 0,
            name: String::new(),
            given: String::new(),
            when: String::new(),
            then: String::new(),
            url: String::new(),
            method: Method::GET,
            headers: Vec::new(),
            payload: Value::Null,
            expected_status: StatusCode::OK,

            actual_status: Option::<reqwest::StatusCode>::None,
            response: serde_json::Value::Null,
        }
    }

    pub fn new_from_row(row: &[&dyn calamine::DataType]) -> Result<Self, &'static str> {
        let mut test_case = TestCase::new();
        // populate the test_case fields from the row data
        test_case.id = row[0]
            .get_float()
            .map(|f| f as u32)
            .ok_or("Invalid row, id is not a number.")?;
        test_case.name = row[1].get_string().unwrap_or("").to_owned();
        test_case.given = row[2].get_string().unwrap_or("").to_owned();
        test_case.when = row[3].get_string().unwrap_or("").to_owned();
        test_case.then = row[4].get_string().unwrap_or("").to_owned();
        test_case.url = row[5].get_string().unwrap_or("").to_owned();
        test_case.method = row[6]
            .get_string()
            .and_then(|s| s.parse::<reqwest::Method>().ok())
            .unwrap_or(reqwest::Method::GET)
            .to_owned();
        test_case.headers = row[7]
            .get_string()
            .unwrap_or("")
            .split(',')
            .filter_map(|header| {
                let parts: Vec<&str> = header.split(':').collect();
                if parts.len() == 2 {
                    Some((parts[0].to_owned(), parts[1].to_owned()))
                } else {
                    None
                }
            })
            .collect();
        test_case.payload = serde_json::from_str(row[8].get_string().unwrap_or("{}")).unwrap();
        test_case.expected_status = row[9]
            .get_float()
            .map(|f| f as u16)
            .map(|s| StatusCode::from_u16(s).unwrap())
            .unwrap_or(StatusCode::OK);

        Ok(test_case) // return the populated test case
    }

    pub fn run(&mut self) -> Result<(), Box<dyn Error>> {
        println!("Running the test case: {}", self.name);
        let client = reqwest::blocking::Client::new();
        let mut headers = HeaderMap::new();
        for (key, value) in &self.headers {
            let header_name = HeaderName::from_lowercase(&key.to_owned().into_bytes())?;
            let header_value = HeaderValue::from_str(&value.clone())?;
            headers.insert(header_name, header_value);
        }
        let response = match self.method {
            Method::GET => client.get(self.url.as_str()).headers(headers).send()?,
            Method::POST => client
                .post(self.url.as_str())
                .headers(headers)
                .json(&self.payload)
                .send()?,
            Method::PUT => client
                .put(self.url.as_str())
                .headers(headers)
                .json(&self.payload)
                .send()?,
            Method::DELETE => client.delete(self.url.as_str()).headers(headers).send()?,
            _ => {
                eprintln!("Unsupported method: {:?}", self.method);
                self.actual_status = Some(StatusCode::METHOD_NOT_ALLOWED);
                return Ok(());
            }
        };
        self.actual_status = Some(response.status());
        self.response = response.json()?;

        self.print_result();
        Ok(())
    }

    pub fn print_result(&self) {
        //println!("Test Case: {}", self.name);
        println!("Given: {:?}", self.given);
        println!("When: {:?}", self.when);
        println!("Then: {:?}", self.then);
        println!("Expected: {}", self.expected_status);
        println!(
            "Actual: {}",
            self.actual_status
                .unwrap_or_else(|| StatusCode::from_u16(0).unwrap())
        );
        if self.expected_status
            == self
                .actual_status
                .unwrap_or_else(|| StatusCode::from_u16(0).unwrap())
        {
            println!("Result: {}", "[PASS] ✔".green());
        } else {
            println!("Result: {}", "[FAIL] ✘".red());
        }
        println!("----------------------------------");
    }
}

#[derive(Debug)]
pub struct TestGroup {
    pub cases: Vec<TestCase>,
}
