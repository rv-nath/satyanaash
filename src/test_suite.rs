use crate::config::Config;
use crate::test_group::TestGroup;
use calamine::{open_workbook, Reader, Xlsx};
use std::error::Error;

pub struct TestSuite {
    test_groups: Vec<TestGroup>,
    total: usize,
    passed: usize,
    failed: usize,
    skipped: usize,
    exec_duration: std::time::Duration, // Total duration for test suite execution
}

impl TestSuite {
    /* Opens the given excel file and loads test data */
    pub fn new(filename: &str, config: &Config) -> Result<Self, Box<dyn Error>> {
        let mut excel: Xlsx<_> = open_workbook(filename)?;
        let mut test_groups = Vec::new();

        for sheet in excel.sheet_names().to_owned() {
            let group = TestGroup::new(&mut excel, &sheet, config)?;
            test_groups.push(group);
        }
        Ok(Self {
            test_groups,
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            exec_duration: std::time::Duration::default(),
        })
    }

    pub fn run(&mut self, config: &Config) {
        for test_group in &mut self.test_groups {
            let output_str = format!("Running test group: {}", test_group.name());
            println!("{}", output_str);
            println!("{}", "=".repeat(output_str.len()));
            test_group.run(config);

            // TODO: Accumulate test statistics
            self.total += test_group.total;
            self.passed += test_group.passed;
            self.failed += test_group.failed;
            self.skipped += test_group.skipped;
        }
        self.print_stats();
    }

    fn print_stats(&self) {
        println!(
            "Summary: {{ Total: {}, Passed: {}, Failed: {}, Skipped: {} }}",
            self.total, self.passed, self.failed, self.skipped
        );
    }
}
