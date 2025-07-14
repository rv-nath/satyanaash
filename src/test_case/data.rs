use reqwest::Method;
use serde::{Deserialize, Serialize};

/// Possible test case results.
#[derive(Debug, Clone, PartialEq)]
pub enum TestResult {
    NotYetTested,
    Passed,
    Failed,
    Skipped,
}

/// How authentication should be handled for a given test case.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AuthType {
    None,
    Authorizer,
    Authorized,
}

/// Advanced configuration for tweaking the test case behavior
/// for repeated execution, delay between requests, etc.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestCaseConfig {
    #[serde(default = "default_repeat_count")]
    pub repeat_count: u32, // Indicates if this test case should be repeated
    #[serde(default = "default_auth_type")]
    pub auth_type: AuthType, // Indicates if the test case generates or consumes a JWT
    #[serde(default = "default_delay")]
    pub delay: u64, // Delay between test case execution (in millis).
}

impl Default for TestCaseConfig {
    fn default() -> Self {
        TestCaseConfig {
            repeat_count: default_repeat_count(),
            auth_type: default_auth_type(),
            delay: default_delay(),
        }
    }
}

/// Core test case data parsed from Excel row.
#[derive(Debug, Clone)]
pub struct TestCaseData {
    pub id: u32,                          // test case identifier (typically a number)
    pub name: String,                     // human readable name for the test case.
    pub given: String,                    // test case description for the given condition (Given)
    pub when: String,                     // test case description for the then condition  (When)
    pub then: String,                     // test case description. for resulting condition. (Then)
    pub url: String,                      // URL of the request
    pub method: Method,                   // http method for the request.
    pub headers: Vec<(String, String)>,   // http headers for the request, if any.
    pub payload: String,                  // payload to be sent with the request.
    pub config: TestCaseConfig,           // advanced configuration for the test case.
    pub scripts: TestScripts,             // pre and post test scripts
}

/// JavaScript scripts associated with a test case.
#[derive(Debug, Clone)]
pub struct TestScripts {
    pub pre_test: Option<String>,  // script to be executed before the test case.
    pub post_test: Option<String>, // script to be executed after the test case.
}

/// Runtime execution state that gets populated during test execution.
#[derive(Debug, Clone)]
pub struct ExecutionState {
    pub effective_name: String,
    pub effective_url: String,
    pub effective_payload: String,
    pub content_type: String,
    pub result: TestResult,
}

impl ExecutionState {
    pub fn new() -> Self {
        ExecutionState {
            effective_name: String::new(),
            effective_url: String::new(),
            effective_payload: String::new(),
            content_type: String::new(),
            result: TestResult::NotYetTested,
        }
    }
}

/// Errors that can occur during test case parsing.
#[derive(Debug, Clone)]
pub struct ParseError {
    pub field: String,
    pub message: String,
}

/// Collection of parsing errors.
#[derive(Debug, Clone)]
pub struct ParseErrors {
    pub errors: Vec<ParseError>,
}

impl ParseErrors {
    pub fn new() -> Self {
        ParseErrors {
            errors: Vec::new(),
        }
    }
    
    pub fn add_error(&mut self, field: &str, message: &str) {
        self.errors.push(ParseError {
            field: field.to_string(),
            message: message.to_string(),
        });
    }
    
    pub fn has_errors(&self) -> bool {
        !self.errors.is_empty()
    }
    
}

// Default value functions for serde
fn default_repeat_count() -> u32 {
    1
}

fn default_auth_type() -> AuthType {
    AuthType::None
}

fn default_delay() -> u64 {
    0
}

// Helper functions for AuthType
impl AuthType {
    pub fn is_authorized(&self) -> bool {
        matches!(self, AuthType::Authorized)
    }
    
    pub fn is_authorizer(&self) -> bool {
        matches!(self, AuthType::Authorizer)
    }
}

impl TestCaseConfig {
    pub fn is_authorized(&self) -> bool {
        self.auth_type.is_authorized()
    }
    
    pub fn is_authorizer(&self) -> bool {
        self.auth_type.is_authorizer()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_test_case_config_default() {
        let config = TestCaseConfig::default();
        assert_eq!(config.repeat_count, 1);
        assert_eq!(config.auth_type, AuthType::None);
        assert_eq!(config.delay, 0);
    }

    #[test]
    fn test_auth_type_methods() {
        assert!(AuthType::Authorized.is_authorized());
        assert!(!AuthType::Authorized.is_authorizer());
        
        assert!(AuthType::Authorizer.is_authorizer());
        assert!(!AuthType::Authorizer.is_authorized());
        
        assert!(!AuthType::None.is_authorized());
        assert!(!AuthType::None.is_authorizer());
    }

    #[test]
    fn test_test_case_config_auth_methods() {
        let config = TestCaseConfig {
            repeat_count: 1,
            auth_type: AuthType::Authorized,
            delay: 0,
        };
        
        assert!(config.is_authorized());
        assert!(!config.is_authorizer());
    }

    #[test]
    fn test_parse_errors() {
        let mut errors = ParseErrors::new();
        assert!(!errors.has_errors());
        
        errors.add_error("field1", "error message");
        assert!(errors.has_errors());
        assert_eq!(errors.errors.len(), 1);
        assert_eq!(errors.errors[0].field, "field1");
        assert_eq!(errors.errors[0].message, "error message");
    }

    #[test]
    fn test_execution_state_new() {
        let state = ExecutionState::new();
        assert_eq!(state.effective_name, "");
        assert_eq!(state.effective_url, "");
        assert_eq!(state.effective_payload, "");
        assert_eq!(state.content_type, "");
        assert_eq!(state.result, TestResult::NotYetTested);
    }

    #[test]
    fn test_test_result_equality() {
        assert_eq!(TestResult::NotYetTested, TestResult::NotYetTested);
        assert_eq!(TestResult::Passed, TestResult::Passed);
        assert_eq!(TestResult::Failed, TestResult::Failed);
        assert_eq!(TestResult::Skipped, TestResult::Skipped);
        
        assert_ne!(TestResult::Passed, TestResult::Failed);
    }
}