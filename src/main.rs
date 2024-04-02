use std::process;

use pareeksha::{config::Config, exec}; // Import the TestOptions struct

fn main() {
    let config = Config::build_config().unwrap_or_else(|err| {
        eprintln!("Error building config: {}", err);
        process::exit(1);
    });

    // extract the test file from the config
    let test_file = config.test_file.clone().unwrap_or_else(|| {
        eprintln!("Test file not provided");
        process::exit(1);
    });

    //execute test cases..
    exec(&test_file, &config);
}
