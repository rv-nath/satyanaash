use crate::test_context::TestCtx;
use crate::test_case::keywords::substitute_keywords;
use regex::Regex;
use std::env;
use std::io::{self, Write};

/// Handles placeholder substitution in test case strings.
/// 
/// Supports three types of placeholders:
/// - `{{env:VAR_NAME}}` - Environment variable substitution
/// - `{{input:VAR_NAME}}` - Interactive user input
/// - `{{var_name}}` - JavaScript context variable substitution
pub struct PlaceholderResolver;

impl PlaceholderResolver {
    /// Substitutes placeholders in the input string with corresponding values.
    ///
    /// - `{{env:VAR_NAME}}` will be replaced with the value of the environment variable `VAR_NAME`.
    /// - `{{input:VAR_NAME}}` will prompt the user for input.
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
    pub fn substitute_placeholders(&self, original: &str, ts_ctx: &mut TestCtx) -> String {
        // First substitute keywords, then placeholders
        let keyword_substituted = substitute_keywords(original);
        
        // Compile the regex once for efficiency
        let re = Regex::new(r"\{\{(.*?)\}\}").unwrap();

        // Perform substitution using Regex::replace_all with a closure
        re.replace_all(&keyword_substituted, |caps: &regex::Captures| {
            let var_expression = &caps[1].trim();

            // Check if the placeholder is an environment variable
            if var_expression.starts_with("env:") {
                let env_var_name = var_expression.trim_start_matches("env:").trim();
                match env::var(env_var_name) {
                    Ok(env_value) => env_value,
                    Err(_) => {
                        // Return the original placeholder if environment variable is not set
                        caps[0].to_string()
                    }
                }
            } else if var_expression.starts_with("input:") {
                // Handle user input for variables
                let input_var_name = var_expression.trim_start_matches("input:").trim();
                self.prompt_user_input(input_var_name)
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
                        // Return the original placeholder if JS variable could not be evaluated
                        caps[0].to_string()
                    }
                }
            }
        })
        .to_string()
    }

    /// Prompts the user for input for a given variable name.
    fn prompt_user_input(&self, var_name: &str) -> String {
        let mut user_input = String::new();

        print!("Enter value for '{}': ", var_name);
        io::stdout().flush().expect("Failed to flush stdout");
        io::stdin()
            .read_line(&mut user_input)
            .expect("Failed to read input");

        user_input.trim().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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

    #[test]
    fn test_env_var_not_found() {
        let mut ts_ctx = TestCtx::new().unwrap();
        let resolver = PlaceholderResolver;
        
        let input = "Hello {{env:NON_EXISTENT_VAR}}";
        let output = resolver.substitute_placeholders(input, &mut ts_ctx);
        assert_eq!(output, "Hello {{env:NON_EXISTENT_VAR}}");
    }

    #[test]
    fn test_js_context_variable() {
        let mut ts_ctx = TestCtx::new().unwrap();
        let resolver = PlaceholderResolver;
        
        // Set a variable in JS context
        ts_ctx.runtime.eval("SAT.globals.testVar = 'js_value'").unwrap();
        
        let input = "Hello {{testVar}}";
        let output = resolver.substitute_placeholders(input, &mut ts_ctx);
        assert_eq!(output, "Hello js_value");
    }

    #[test]
    fn test_js_context_variable_not_found() {
        let mut ts_ctx = TestCtx::new().unwrap();
        let resolver = PlaceholderResolver;
        
        let input = "Hello {{nonExistentVar}}";
        let output = resolver.substitute_placeholders(input, &mut ts_ctx);
        assert_eq!(output, "Hello {{nonExistentVar}}");
    }

    #[test]
    fn test_keyword_substitution_before_placeholder() {
        let mut ts_ctx = TestCtx::new().unwrap();
        let resolver = PlaceholderResolver;
        
        env::set_var("TEST_ENV", "environment");
        let input = "Name: $RandomName, Env: {{env:TEST_ENV}}";
        let output = resolver.substitute_placeholders(input, &mut ts_ctx);
        
        // Should not contain keywords or env placeholder
        assert!(!output.contains("$RandomName"));
        assert!(!output.contains("{{env:TEST_ENV}}"));
        assert!(output.contains("environment"));
    }
}