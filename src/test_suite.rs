use crate::config::Config;
// test_suite.rs
use crate::test_case::TestCase;
use crate::test_case::TestResult;
use crate::test_suite_context::TestSuiteCtx;
use quick_js::Context;

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

        // Create a new Javascript runtime for the test suite
        let mut runtime = match Context::new() {
            Ok(runtime) => runtime,
            Err(e) => {
                eprintln!("Error creating the Javascript runtime: {}", e);
                return Err(Box::new(e));
            }
        };

        // Create a test suite context
        let mut test_suite_ctx =
            TestSuiteCtx::new(&client, self.jwt_token.to_owned(), &mut runtime);

        for test_case in &mut self.test_cases {
            // execute the test case..
            let jwt_token = test_case.run(&mut test_suite_ctx);

            // Print the result
            test_case.print_result(config.verbose);
            println!("------------------------------");

            // Update the token in the test suite context
            test_suite_ctx.update_token(jwt_token);

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
