// In lib.rs
pub mod config;
mod excel_reader;
mod test_case;
mod test_suite; // Import the test_suite module

use crate::config::Config;
use crate::test_suite::TestSuite; // Import the TestSuite struct
use excel_reader::read_test_data;

pub fn exec(filename: &str, config: &Config) {
    // Read test data
    let test_data = match read_test_data(filename, &config) {
        Ok(data) => data,
        Err(e) => {
            eprintln!("Error reading test data: {}", e);
            return;
        }
    };

    // Create a new TestSuite with the test data and run it
    let mut test_suite = TestSuite::new(test_data);
    test_suite.run();
}
