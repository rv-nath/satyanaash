//! HTTP request executor
//!
//! Executes HTTP requests for test cases and captures responses.

use std::collections::HashMap;
use std::time::{Duration, Instant};
use reqwest::{Client, Method, header::{HeaderMap, HeaderName, HeaderValue}};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AppError;
use crate::execution::body::BodyType;

/// HTTP request executor
pub struct HttpExecutor {
    client: Client,
}

/// Captured HTTP request for logging
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestLog {
    pub method: String,
    pub url: String,
    pub headers: HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

/// Captured HTTP response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseLog {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub json: Option<Value>,
}

/// Result of executing an HTTP request
pub struct HttpResult {
    pub request: RequestLog,
    pub response: ResponseLog,
    pub duration_ms: u64,
}

impl HttpExecutor {
    /// Create a new HTTP executor with default settings
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("Failed to create HTTP client");

        Self { client }
    }

    /// Execute an HTTP request
    pub async fn execute(
        &self,
        method: &str,
        url: &str,
        headers: &HashMap<String, String>,
        body: Option<&str>,
        body_type: BodyType,
    ) -> Result<HttpResult, AppError> {
        let start = Instant::now();

        // Validate URL before attempting request
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err(AppError::HttpError(format!(
                "Invalid URL '{}': must start with http:// or https://. Did you forget to set a base URL variable?",
                url
            )));
        }

        // Parse method
        let method = method.to_uppercase();
        let http_method = match method.as_str() {
            "GET" => Method::GET,
            "POST" => Method::POST,
            "PUT" => Method::PUT,
            "PATCH" => Method::PATCH,
            "DELETE" => Method::DELETE,
            "HEAD" => Method::HEAD,
            "OPTIONS" => Method::OPTIONS,
            _ => return Err(AppError::BadRequest(format!("Unsupported HTTP method: {}", method))),
        };

        // Build request
        let mut request_builder = self.client.request(http_method.clone(), url);

        // Add headers
        let mut header_map = HeaderMap::new();
        for (key, value) in headers {
            if let (Ok(name), Ok(val)) = (
                HeaderName::try_from(key.as_str()),
                HeaderValue::try_from(value.as_str())
            ) {
                header_map.insert(name, val);
            }
        }
        request_builder = request_builder.headers(header_map);

        // Add body if present. Three shapes, one authored string — `body_type` says how to
        // read it (see execution/body.rs).
        let author_set_type =
            headers.contains_key("Content-Type") || headers.contains_key("content-type");
        let mut logged_body = body.map(|s| s.to_string());

        if let Some(body_str) = body {
            match body_type {
                BodyType::Json => {
                    request_builder = request_builder.body(body_str.to_string());
                }
                BodyType::Urlencoded => {
                    let fields = crate::execution::body::parse_fields(body_str);
                    // reqwest does the percent-encoding, so a value containing `&`, `=` or a
                    // space survives — which is the whole reason a field editor beats a
                    // hand-written `a=1&b=2`.
                    let pairs: Vec<(String, String)> = fields
                        .iter()
                        .map(|f| (f.name.clone(), f.value.clone()))
                        .collect();
                    request_builder = request_builder.form(&pairs);
                    logged_body = Some(crate::execution::body::describe(&fields));
                }
                BodyType::Multipart => {
                    let fields = crate::execution::body::parse_fields(body_str);
                    let mut form = reqwest::multipart::Form::new();
                    for field in &fields {
                        form = form.text(field.name.clone(), field.value.clone());
                    }
                    request_builder = request_builder.multipart(form);
                    logged_body = Some(crate::execution::body::describe(&fields));
                }
            }

            // The type's own header, unless the author set one — and never for multipart,
            // whose boundary only the client knows. `.form()` and `.multipart()` set their
            // own, so this is really about JSON keeping its historical default.
            if !author_set_type {
                if let Some(content_type) = body_type.content_type() {
                    request_builder = request_builder.header("Content-Type", content_type);
                }
            }
        }

        // Capture request log — what was sent, not what was stored. For a form body that
        // means the fields, because the stored payload is a JSON array nobody put on the
        // wire.
        let request_log = RequestLog {
            method: method.clone(),
            url: url.to_string(),
            headers: headers.clone(),
            body: logged_body,
        };

        // Execute request
        let response = request_builder.send().await
            .map_err(|e| {
                let reason = if e.is_connect() {
                    format!("Connection failed to '{}': {}", url, e)
                } else if e.is_timeout() {
                    format!("Request timed out for '{}'", url)
                } else if e.is_request() {
                    format!("Invalid request to '{}': {}", url, e)
                } else {
                    format!("Request to '{}' failed: {}", url, e)
                };
                AppError::HttpError(reason)
            })?;

        // Capture response
        let status = response.status().as_u16();

        // Capture response headers
        let mut response_headers = HashMap::new();
        for (name, value) in response.headers() {
            if let Ok(v) = value.to_str() {
                response_headers.insert(name.to_string(), v.to_string());
            }
        }

        // Get response body
        let body_text = response.text().await
            .map_err(|e| AppError::HttpError(format!("Failed to read response body: {}", e)))?;

        // Try to parse as JSON
        let json: Option<Value> = serde_json::from_str(&body_text).ok();

        let duration_ms = start.elapsed().as_millis() as u64;

        let response_log = ResponseLog {
            status,
            headers: response_headers,
            body: body_text,
            json,
        };

        Ok(HttpResult {
            request: request_log,
            response: response_log,
            duration_ms,
        })
    }
}

impl Default for HttpExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_http_executor_creation() {
        let executor = HttpExecutor::new();
        // Just verify it can be created
        assert!(true);
        drop(executor);
    }
}
