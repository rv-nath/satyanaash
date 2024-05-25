/* Implements the notion of a test group.
    A test group is a collection of "related" test cases,
    which succeed as a whole for the group to pass.
*/

use crate::config::Config;
use crate::test_case::{TestCase, TestResult};
use crate::test_context::TestCtx;
use std::error::Error;

pub struct TestGroup {
    pub name: String,
    test_cases: Vec<TestCase>,
    group_ctx: TestCtx,

    // stats
    pub total: usize,
    pub passed: usize,
    pub failed: usize,
    pub skipped: usize,
    pub exec_duration: std::time::Duration,
}

impl TestGroup {
    pub fn new(group_name: &str) -> Self {
        TestGroup {
            name: group_name.to_string(),
            test_cases: vec![],
            group_ctx: TestCtx::new().unwrap(),
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            exec_duration: std::time::Duration::new(0, 0),
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn print_stats(&self) {
        println!("");
        println!(
            "Group Summary: {{ Name: {}, Total: {}, Passed: {}, Failed: {}, Skipped: {} }}",
            self.name, self.total, self.passed, self.failed, self.skipped
        );
        println!("{}", "-".repeat(80));
        println!("");
    }
    pub fn exec_duration(&self) -> std::time::Duration {
        self.exec_duration
    }

    pub fn exec(&mut self, row: &[calamine::Data], config: &Config) -> Result<(), Box<dyn Error>> {
        // Create an instance of test case, and execute it.
        let mut tc = TestCase::new(row, config);
        let t_result = tc.run(&mut self.group_ctx, config);

        //TODO: add the test case to the group.
        self.test_cases.push(tc);

        // update group counts
        self.total += 1;
        match t_result {
            TestResult::Passed => self.passed += 1,
            TestResult::Failed => self.failed += 1,
            TestResult::Skipped => self.skipped += 1,
            _ => {}
        }
        // update the exec duration..
        self.exec_duration += self.group_ctx.exec_duration();

        Ok(())
    }

    /*
    pub fn drop_js_engine(&mut self) {
        let _ = std::mem::replace(&mut self.group_ctx.runtime, JsEngine::new());
    }
    */
}
