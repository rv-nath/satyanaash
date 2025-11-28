use std::process;

use satyanaash::config::Config; // Import the TestOptions struct

fn main() {
    // Open banner file, if existing and print its contents to screen...
    let banner = include_str!("../banner");
    println!("{}", banner);

    let config = Config::build_config().unwrap_or_else(|err| {
        eprintln!("Error building config: {}", err);
        process::exit(1);
    });

    // extract the test file from the config
    let test_file = config.test_file.clone().unwrap_or_else(|| {
        eprintln!("Test file not provided");
        process::exit(1);
    });

    // Create an instance of test framework..
    let (sat, _listener) = satyanaash::TSat::new();

    /*
    // Get the listener and create a thread for event handling
    thread::spawn(move || {
        for event in listener {
            println!("Event: {:?}", event);
        }
    });
    */

    //execute test cases..
    if let Err(err) = sat.exec(&test_file, &config) {
        eprintln!("Error executing test cases: {}", err);
        process::exit(1);
    }
}
