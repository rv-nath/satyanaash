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
    pub worksheet: Option<String>,
    pub verbose: bool,
    pub token_key: Option<String>,
    pub groups: Option<Vec<(Option<String>, String)>>,
}

impl Config {
    pub fn build_config() -> Result<Self, Box<dyn Error>> {
        let args: Vec<String> = env::args().collect();

        let mut opts = Options::new();
        opts.optopt("s", "start_row", "Set the start row", "START_ROW");
        opts.optopt("e", "end_row", "Set the end row", "END_ROW");
        opts.optopt("b", "base_url", "Set the base URL", "BASE_URL");
        opts.optopt("t", "test_file", "Set the test file", "TEST_FILE");
        opts.optopt("w", "worksheet", "Set the worksheet", "WORKSHEET");
        opts.optmulti("g", "groups", "Set the test groups", "GROUPS");
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
        let test_file = matches.opt_str("t");
        let worksheet = matches.opt_str("w");

        // If conflicting arguments bail out.
        if (start_row.is_some() || end_row.is_some()) && worksheet.is_none() {
            eprintln!("Error: start_row and end_row options are only applicable if a worksheet option is provided.");
            exit(1);
        }

        let groups: Vec<(Option<String>, String)> = matches
            .opt_strs("g")
            .into_iter()
            .map(|g| {
                let split: Vec<&str> = g.split(|c| c == '.' || c == ':').collect();
                match split.len() {
                    1 => (None, split[0].to_string()),
                    2 => (Some(split[0].to_string()), split[1].to_string()),
                    _ => panic!(
                        "Invalid group format: {}. Expected [worksheet_name.]group_name",
                        g
                    ),
                }
            })
            .collect();

        // Read from config.yaml
        // Get and print the current working directory for debugging
        let current_dir = env::current_dir()?;
        println!("Current working directory: {}", current_dir.display());

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

        if !groups.is_empty() {
            config.groups = Some(groups);
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
