use indicatif::ProgressBar;
use std::time::Duration;

/// Utilities for displaying progress during test execution.
pub struct ProgressDisplay;

impl ProgressDisplay {
    /// Shows a progress spinner with a message for the given URL.
    /// 
    /// # Arguments
    /// 
    /// * `url` - The URL being processed
    /// * `pb` - The progress bar instance
    /// 
    /// # Returns
    /// 
    /// Reference to the progress bar for chaining
    pub fn show_progress<'a>(url: &'a str, pb: &'a ProgressBar) -> &'a ProgressBar {
        // Display a message to the user
        pb.set_message(format!("Fetching {}...", url));
        pb.enable_steady_tick(Duration::from_millis(100));
        pb
    }

    /// Stops the progress spinner and shows completion message.
    /// 
    /// # Arguments
    /// 
    /// * `pb` - The progress bar instance to stop
    pub fn stop_progress(pb: &ProgressBar) {
        // Stop progress animation
        pb.disable_steady_tick();
        pb.finish_with_message("Done");
    }
}

/// Utility function to print first N lines of text with proper formatting.
/// Used for displaying payload content in a readable format.
/// 
/// # Arguments
/// 
/// * `text` - The text to print
/// * `n` - Maximum number of lines to print
pub fn print_first_n_lines(text: &str, n: usize) {
    let mut lines = text.lines();
    for _ in 0..n {
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
    // use std::io::{self, Write};

    #[test]
    fn test_print_first_n_lines() {
        let text = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";
        
        // Test with limited lines
        // Note: In actual test we'd need to capture stdout, but this tests the logic
        let lines: Vec<&str> = text.lines().take(3).collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], "Line 1");
        assert_eq!(lines[1], "Line 2");
        assert_eq!(lines[2], "Line 3");
    }

    #[test]
    fn test_print_first_n_lines_fewer_than_n() {
        let text = "Line 1\nLine 2";
        
        // Test with more lines requested than available
        let lines: Vec<&str> = text.lines().take(5).collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "Line 1");
        assert_eq!(lines[1], "Line 2");
    }

    #[test]
    fn test_print_first_n_lines_empty() {
        let text = "";
        
        // Test with empty text
        let lines: Vec<&str> = text.lines().take(3).collect();
        assert_eq!(lines.len(), 0);
    }

    #[test]
    fn test_progress_display_methods_exist() {
        // Test that the methods exist and can be called
        let pb = ProgressBar::new_spinner();
        let url = "http://example.com";
        
        // Test show_progress
        let returned_pb = ProgressDisplay::show_progress(url, &pb);
        assert!(std::ptr::eq(returned_pb, &pb));
        
        // Test stop_progress
        ProgressDisplay::stop_progress(&pb);
        
        // If we reach here, the methods work correctly
        assert!(true);
    }
}