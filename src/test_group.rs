/* Implements the notion of a test group.
    A test group is a collection of "related" test cases,
    which succeed as a whole for the group to pass.
*/

use calamine::DataType;
use calamine::Reader;
use calamine::Xlsx;

use crate::config::Config;
use crate::test_case::TestCase;
use crate::test_case::TestResult;
use crate::test_context::TestCtx;
use std::error::Error;
use std::io::Read;
use std::io::Seek;

pub struct TestGroup {
    name: String,
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
    pub fn new<T: Read + Seek>(
        excel: &mut Xlsx<T>,
        sheet_name: &str,
        config: &Config,
    ) -> Result<TestGroup, Box<dyn Error>> {
        let range = excel.worksheet_range(sheet_name)?;

        let mut test_cases = Vec::new();

        // Default to the first and last rows if start_row and end_row are None
        let start_row = config.start_row.unwrap_or(1);
        let end_row = config.end_row.unwrap_or_else(|| range.height() as usize);

        // Iterate over the rows in the range and create a TestCase for each one
        for (i, row) in range.rows().enumerate() {
            //// Adjust for 0-indexing
            //let current_row = i + 1;
            let current_row = i;

            // Only create test cases for rows within the start_row and end_row range
            if current_row >= start_row && current_row <= end_row {
                let row: Vec<&dyn DataType> =
                    row.iter().map(|cell| cell as &dyn DataType).collect();
                let test_case = TestCase::new(&row, config);
                test_cases.push(test_case);
            }
        }

        let total = test_cases.len();
        Ok(TestGroup {
            name: sheet_name.to_string(),
            test_cases,
            //result: TestResult::Passed,
            group_ctx: TestCtx::new(),

            total,
            passed: 0,
            failed: 0,
            skipped: 0,
            exec_duration: std::time::Duration::default(),
        })
    }

    pub fn run(&mut self, config: &Config) {
        for test_case in &mut self.test_cases {
            let result = test_case.run(&mut self.group_ctx, config);

            // accummulate test statistics
            match result {
                TestResult::Passed => self.passed += 1,
                TestResult::Failed => self.failed += 1,
                TestResult::Skipped => self.skipped += 1,
                TestResult::NotYetTested => (),
            }
        }

        // Accumulate the group level execution duration
        self.exec_duration = self.group_ctx.exec_duration();

        // Print group level statistics
        self.print_stats();
    }

    pub fn name(&self) -> &str {
        &self.name
    }
    fn print_stats(&self) {
        println!(
            "Group Summary: {{ Name: {}, Total: {}, Passed: {}, Failed: {}, Skipped: {} }}",
            self.name, self.total, self.passed, self.failed, self.skipped
        );
    }
    pub fn exec_duration(&self) -> std::time::Duration {
        self.exec_duration
    }
}
