use getopts::Options;
use serde::Deserialize;
use serde_yaml;
use std::process::exit;
use std::{env, error::Error, fs};

#[derive(Deserialize, Debug)]
pub struct Config {
    pub start_row: Option<usize>,
    pub end_row: Option<usize>,
    pub base_url: Option<String>,
    pub test_file: Option<String>, // Add this line
    pub verbose: bool,
    pub token_key: Option<String>,
}

impl Config {
    pub fn build_config() -> Result<Self, Box<dyn Error>> {
        let args: Vec<String> = env::args().collect();

        let mut opts = Options::new();
        opts.optopt("s", "start_row", "Set the start row", "START_ROW");
        opts.optopt("e", "end_row", "Set the end row", "END_ROW");
        opts.optopt("b", "base_url", "Set the base URL", "BASE_URL");
        opts.optopt("t", "test_file", "Set the test file", "TEST_FILE"); // Add this line
        opts.optflag("h", "help", "Print this help menu");
        opts.optflag("v", "verbose", "Print verbose information");

        let matches = match opts.parse(&args[1..]) {
            Ok(m) => m,
            Err(f) => panic!("{}", f.to_string()),
        };

        if matches.opt_present("h") {
            print_usage(&args[0], opts);
            exit(0);
        }
        let verbose = matches.opt_present("v");

        let start_row = matches.opt_str("s").map(|s| s.parse::<usize>().unwrap());
        let end_row = matches.opt_str("e").map(|e| e.parse::<usize>().unwrap());
        let base_url = matches.opt_str("b");
        let test_file = matches.opt_str("t"); // Add this line

        // Read from config.yaml
        let config_file = fs::read_to_string("config.yaml")?;
        let mut config: Config = serde_yaml::from_str(&config_file)?;

        // Override with command line arguments if provided
        if let Some(start_row) = start_row {
            config.start_row = Some(start_row);
        }
        if let Some(end_row) = end_row {
            config.end_row = Some(end_row);
        }
        if let Some(base_url) = base_url {
            config.base_url = Some(base_url);
        }
        if let Some(test_file) = test_file {
            // Add this line
            config.test_file = Some(test_file);
        }

        config.verbose = verbose;

        Ok(config)
    }
}

fn print_usage(program: &str, opts: Options) {
    let version = env!("CARGO_PKG_VERSION");
    let program_name = program.split('/').last().unwrap_or(program);
    let description = "A delusional framework for testing / breaking the REST APIs";
    let brief = format!(
        "{}  {} version {}\nUsage: {} [options]",
        program_name, version, description, program_name
    );

    print!("{}", opts.usage(&brief));
}
