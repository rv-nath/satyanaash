use crate::config::Config;
// test_suite.rs
use crate::test_case::TestCase;
use crate::test_case::TestResult;

pub struct TestSuite {
    test_cases: Vec<TestCase>,
    jwt_token: Option<String>,
    total: usize,
    passed: usize,
    failed: usize,
    skipped: usize,
}

impl TestSuite {
    pub fn run(&mut self, config: &Config) -> Result<(), Box<dyn std::error::Error>> {
        println!("Running the test suite");
        println!("======================");

        // create a http client object from reqwest blocking
        let client = reqwest::blocking::Client::new();

        for test_case in &mut self.test_cases {
            // execute the test case..
            let jwt_token = test_case.run(&client, self.jwt_token.as_deref());
            test_case.print_result(config.verbose);
            println!("------------------------------");
            if let Some(jwt_token) = jwt_token {
                self.jwt_token = Some(jwt_token);
            }

            // accummulate test statistics
            match test_case.result() {
                // handle all enum variants
                TestResult::Failed => self.failed += 1,
                TestResult::Passed => self.passed += 1,
                TestResult::Skipped => self.skipped += 1,
                TestResult::NotYetTested => (),
            }
        }

        self.print_stats();

        Ok(())
    }

    pub fn new(test_cases: Vec<TestCase>) -> Self {
        let total = test_cases.len();
        TestSuite {
            test_cases,
            jwt_token: None,
            total,
            passed: 0,
            failed: 0,
            skipped: 0,
        }
    }

    fn print_stats(&self) {
        println!(
            "Summary: {{ Total: {}, Passed: {}, Failed: {}, Skipped: {} }}",
            self.total, self.passed, self.failed, self.skipped
        );
    }
}
