use crate::config::Config;
use crate::test_case::data::{TestCaseData, TestCaseConfig, TestScripts, ParseErrors};
use crate::test_case::keywords::substitute_keywords;
use calamine::DataType;
use reqwest::{Method, Url};
use serde_json;

/// Parses Excel row data into TestCaseData structure.
pub struct ExcelRowParser;

impl ExcelRowParser {
    /// Parses an Excel row into TestCaseData.
    /// 
    /// # Arguments
    /// 
    /// * `row` - The Excel row data
    /// * `config` - System configuration
    /// 
    /// # Returns
    /// 
    /// Result containing TestCaseData or ParseErrors
    pub fn parse_test_case_data(row: &[calamine::Data], config: &Config) -> Result<TestCaseData, ParseErrors> {
        let mut errors = ParseErrors::new();
        
        // Retrieve and evaluate the pre-test-script as the very first step,
        // as it may contain the code to setup JS runtime vars,
        // which may be consumed in other columns.
        let pre_test_script = Self::parse_pre_test_script(&row[10]);
        
        // Parse each field
        let id = Self::parse_id(&row[0], &mut errors);
        let name = Self::parse_name(&row[1], &mut errors);
        let given = Self::parse_given(&row[2], &mut errors);
        let when = Self::parse_when(&row[3], &mut errors);
        let then = Self::parse_then(&row[4], &mut errors);
        let url = Self::parse_url(&row[5], config, &mut errors);
        let method = Self::parse_method(&row[6], &mut errors);
        let headers = Self::parse_headers(&row[7]);
        let payload = Self::parse_payload(&row[8], &mut errors);
        let test_config = Self::parse_config(&row[9]);
        let post_test_script = Self::parse_post_test_script(&row[11]);
        
        let scripts = TestScripts {
            pre_test: pre_test_script,
            post_test: post_test_script,
        };
        
        if errors.has_errors() {
            return Err(errors);
        }
        
        Ok(TestCaseData {
            id,
            name,
            given,
            when,
            then,
            url,
            method,
            headers,
            payload,
            config: test_config,
            scripts,
        })
    }
    
    /// Parses the test case ID from Excel cell.
    fn parse_id(cell: &calamine::Data, errors: &mut ParseErrors) -> u32 {
        match cell.get_float() {
            Some(f) => f as u32,
            None => {
                errors.add_error("id", "ID is not a number.");
                0
            }
        }
    }
    
    /// Parses the test case name from Excel cell.
    fn parse_name(cell: &calamine::Data, errors: &mut ParseErrors) -> String {
        match cell.get_string() {
            Some(s) => substitute_keywords(s),
            None => {
                errors.add_error("name", "Invalid name field");
                String::new()
            }
        }
    }
    
    /// Parses the 'given' condition from Excel cell.
    fn parse_given(cell: &calamine::Data, errors: &mut ParseErrors) -> String {
        match cell.get_string() {
            Some(s) => substitute_keywords(s),
            None => {
                errors.add_error("given", "Invalid data for 'given' field.");
                String::new()
            }
        }
    }
    
    /// Parses the 'when' condition from Excel cell.
    fn parse_when(cell: &calamine::Data, errors: &mut ParseErrors) -> String {
        match cell.get_string() {
            Some(s) => substitute_keywords(s),
            None => {
                errors.add_error("when", "Invalid data for 'when' field.");
                String::new()
            }
        }
    }
    
    /// Parses the 'then' condition from Excel cell.
    fn parse_then(cell: &calamine::Data, errors: &mut ParseErrors) -> String {
        match cell.get_string() {
            Some(s) => substitute_keywords(s),
            None => {
                errors.add_error("then", "Invalid data for 'then' field.");
                String::new()
            }
        }
    }
    
    /// Parses the URL from Excel cell, handling both relative and absolute URLs.
    fn parse_url(cell: &calamine::Data, config: &Config, errors: &mut ParseErrors) -> String {
        match cell.get_string() {
            Some(s) => {
                let s = substitute_keywords(s);
                let full_url = if s.starts_with("http://") || s.starts_with("https://") {
                    s.to_string()
                } else {
                    format!("{}{}", config.base_url.clone().unwrap_or_default(), s)
                };
                
                // Validate URL format
                match Url::parse(&full_url) {
                    Ok(_) => full_url,
                    Err(_) => {
                        errors.add_error("url", "Invalid URL format.");
                        String::new()
                    }
                }
            }
            None => {
                errors.add_error("url", "No data for 'url' field.");
                String::new()
            }
        }
    }
    
    /// Parses the HTTP method from Excel cell.
    fn parse_method(cell: &calamine::Data, errors: &mut ParseErrors) -> Method {
        match cell.get_string() {
            Some(s) => match s.parse::<reqwest::Method>() {
                Ok(m) => m,
                Err(_) => {
                    errors.add_error("method", "Invalid HTTP method.");
                    Method::GET
                }
            },
            None => {
                errors.add_error("method", "No data for 'method' field.");
                Method::GET
            }
        }
    }
    
    /// Parses HTTP headers from Excel cell.
    /// Expected format: "key1:value1,key2:value2"
    fn parse_headers(cell: &calamine::Data) -> Vec<(String, String)> {
        match cell.get_string() {
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
        }
    }
    
    /// Parses the request payload from Excel cell.
    fn parse_payload(cell: &calamine::Data, errors: &mut ParseErrors) -> String {
        match cell.get_string() {
            Some(s) => {
                let substituted_s = substitute_keywords(s);
                // Validate JSON if not empty
                if !substituted_s.is_empty() {
                    match serde_json::from_str::<serde_json::Value>(&substituted_s) {
                        Ok(_) => substituted_s,
                        Err(_) => {
                            errors.add_error("payload", "Invalid JSON payload.");
                            String::new()
                        }
                    }
                } else {
                    substituted_s
                }
            }
            None => String::new(),
        }
    }
    
    /// Parses the test case configuration from Excel cell.
    fn parse_config(cell: &calamine::Data) -> TestCaseConfig {
        match cell.get_string() {
            Some(s) => match serde_json::from_str::<TestCaseConfig>(&s) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("Error parsing test case config: {}", e);
                    TestCaseConfig::default()
                }
            },
            None => TestCaseConfig::default(),
        }
    }
    
    /// Parses the pre-test script from Excel cell.
    fn parse_pre_test_script(cell: &calamine::Data) -> Option<String> {
        match cell.get_string() {
            Some(s) => Some(s.to_owned()),
            None => None,
        }
    }
    
    /// Parses the post-test script from Excel cell.
    fn parse_post_test_script(cell: &calamine::Data) -> Option<String> {
        match cell.get_string() {
            Some(s) => Some(substitute_keywords(s)),
            None => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use calamine::Data;
    use reqwest::Method;

    fn create_test_config() -> Config {
        Config {
            start_row: Some(1),
            end_row: None,
            base_url: Some("http://localhost:3000".to_string()),
            test_file: None,
            worksheet: None,
            verbose: false,
            token_key: None,
            groups: None,
        }
    }

    #[test]
    fn test_parse_id_valid() {
        let mut errors = ParseErrors::new();
        let cell = Data::Float(123.0);
        let result = ExcelRowParser::parse_id(&cell, &mut errors);
        assert_eq!(result, 123);
        assert!(!errors.has_errors());
    }

    #[test]
    fn test_parse_id_invalid() {
        let mut errors = ParseErrors::new();
        let cell = Data::String("not_a_number".to_string());
        let result = ExcelRowParser::parse_id(&cell, &mut errors);
        assert_eq!(result, 0);
        assert!(errors.has_errors());
    }

    #[test]
    fn test_parse_name_valid() {
        let mut errors = ParseErrors::new();
        let cell = Data::String("Test Case Name".to_string());
        let result = ExcelRowParser::parse_name(&cell, &mut errors);
        assert_eq!(result, "Test Case Name");
        assert!(!errors.has_errors());
    }

    #[test]
    fn test_parse_method_valid() {
        let mut errors = ParseErrors::new();
        let cell = Data::String("POST".to_string());
        let result = ExcelRowParser::parse_method(&cell, &mut errors);
        assert_eq!(result, Method::POST);
        assert!(!errors.has_errors());
    }

    #[test]
    fn test_parse_method_invalid() {
        let mut errors = ParseErrors::new();
        let cell = Data::String("123!@#".to_string());
        let result = ExcelRowParser::parse_method(&cell, &mut errors);
        
        assert_eq!(result, Method::GET);
        assert!(errors.has_errors());
        assert_eq!(errors.errors[0].field, "method");
        assert_eq!(errors.errors[0].message, "Invalid HTTP method.");
    }

    #[test]
    fn test_parse_headers_valid() {
        let cell = Data::String("Content-Type:application/json,Authorization:Bearer token".to_string());
        let result = ExcelRowParser::parse_headers(&cell);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0], ("Content-Type".to_string(), "application/json".to_string()));
        assert_eq!(result[1], ("Authorization".to_string(), "Bearer token".to_string()));
    }

    #[test]
    fn test_parse_headers_empty() {
        let cell = Data::Empty;
        let result = ExcelRowParser::parse_headers(&cell);
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn test_parse_url_absolute() {
        let mut errors = ParseErrors::new();
        let config = create_test_config();
        let cell = Data::String("https://example.com/api".to_string());
        let result = ExcelRowParser::parse_url(&cell, &config, &mut errors);
        assert_eq!(result, "https://example.com/api");
        assert!(!errors.has_errors());
    }

    #[test]
    fn test_parse_url_relative() {
        let mut errors = ParseErrors::new();
        let config = create_test_config();
        let cell = Data::String("/api/test".to_string());
        let result = ExcelRowParser::parse_url(&cell, &config, &mut errors);
        assert_eq!(result, "http://localhost:3000/api/test");
        assert!(!errors.has_errors());
    }

    #[test]
    fn test_parse_payload_valid_json() {
        let mut errors = ParseErrors::new();
        let cell = Data::String(r#"{"key": "value"}"#.to_string());
        let result = ExcelRowParser::parse_payload(&cell, &mut errors);
        assert_eq!(result, r#"{"key": "value"}"#);
        assert!(!errors.has_errors());
    }

    #[test]
    fn test_parse_payload_empty() {
        let mut errors = ParseErrors::new();
        let cell = Data::Empty;
        let result = ExcelRowParser::parse_payload(&cell, &mut errors);
        assert_eq!(result, "");
        assert!(!errors.has_errors());
    }
}