// In lib.rs
pub mod config;
mod test_case;
mod test_context;
mod test_group;
mod test_suite; // Import the test_suite module

use crate::config::Config;
use crate::test_suite::TestSuite; // Import the TestSuite struct
                                  //

pub fn exec(filename: &str, config: &Config) {
    // Create a new test suite with the groups and run it
    if let Ok(mut test_suite) = TestSuite::new(filename, config) {
        let _ = test_suite.run(config);
    } else {
        eprintln!("Failed to create test suite");
    }

    println!("Done running the test suite");
}
