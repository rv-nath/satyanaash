use crate::config::Config;
use crate::test_case::TestResult;
use crate::test_events::TestEvent;
use crate::test_events::{TestSuiteBegin, TestSuiteEnd};
use crate::test_group::TestGroup;
use anyhow::Result;
use calamine::DataType;
use calamine::Reader;
use calamine::Xlsx;
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::mpsc::Sender;
use std::time::Instant;
use std::{
    error::Error,
    io::{Read, Seek},
};

pub struct TestSuite {
    test_groups: Vec<TestGroup>,
    total: usize,
    passed: usize,
    failed: usize,
    skipped: usize,
    exec_duration: std::time::Duration, // Total duration for test suite execution
}

impl Drop for TestSuite {
    fn drop(&mut self) {
        while let Some(_test_group) = self.test_groups.pop() {
            //test_group.drop_js_engine();
            //println!("Dropping test group: {}", test_group.name());
        }
    }
}

impl TestSuite {
    pub fn new() -> Self {
        // Initialize the test suite object and return.
        TestSuite {
            test_groups: vec![],
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            exec_duration: std::time::Duration::new(0, 0),
        }
    }

    pub fn exec<R: Read + Seek>(
        &mut self,
        excel: &mut Xlsx<R>,
        worksheet_name: &str,
        config: &Config,
        tx: &Sender<TestEvent>,
    ) -> Result<TestResult, Box<dyn Error>> {
        // Fire an event to indicate that the test suite has started.
        self.fire_start_evt(tx);

        let range = excel.worksheet_range(worksheet_name)?;
        let mut current_group: Option<TestGroup> = None;

        // Parse the config groups into a HashMap for quick lookup
        let config_groups = parse_config_groups(config, worksheet_name);

        for (i, row) in range.rows().enumerate() {
            // skip rows until start_row
            if i < config.start_row.unwrap_or(1) {
                continue;
            }

            let first_cell = row[0].get_string().unwrap_or("");
            if first_cell.starts_with("Group:") {
                // Finalize the previous group if it exists
                self.finalize_group(&mut current_group, tx);

                // Extract the group name from the first cell.
                let group_name = first_cell.trim_start_matches("Group:").trim();

                // If the group name is specified in the config for this worksheet,
                // construct and run the test group.
                if config_groups.is_empty()
                    || config_groups
                        .get(worksheet_name)
                        .map_or(false, |groups| groups.contains(group_name))
                {
                    current_group = Some(TestGroup::new(group_name, tx));
                    println!("{}", "-".repeat(80));
                    println!(
                        "Starting Group: {}...",
                        current_group.as_ref().unwrap().name()
                    );
                    println!("{}", "-".repeat(80));
                }
            } else {
                // If we are in a group, call the group's exec method
                if let Some(group) = current_group.as_mut() {
                    group.exec(row, config, tx)?;
                }
            }
        }

        // Finalize the last group if it exists
        self.finalize_group(&mut current_group, tx);

        // Print test suite level statistics.
        self.print_stats();

        // Fire test suite end event.
        self.fire_end_evt(tx);

        // If we reached here, all applicable tests would have passed.
        Ok(TestResult::Passed)
    }

    fn finalize_group(&mut self, group: &mut Option<TestGroup>, tx: &Sender<TestEvent>) {
        if let Some(group) = group.take() {
            group.print_stats();
            self.update_stats(&group);

            group.fire_end_evt(tx);
            self.test_groups.push(group);
        }
    }

    fn print_stats(&self) {
        println!("");
        println!("Test Suite Summary:");
        println!(
            "Total: {}, Passed: {}, Failed: {}, Skipped: {}",
            self.total, self.passed, self.failed, self.skipped
        );
        println!("Execution Time: {:?}", self.exec_duration);
        println!("{}", "-".repeat(80));
        println!("");
    }

    fn update_stats(&mut self, group: &TestGroup) {
        self.total += group.total;
        self.passed += group.passed;
        self.failed += group.failed;
        self.skipped += group.skipped;
        self.exec_duration += group.exec_duration();
    }

    fn fire_start_evt(&self, tx: &Sender<TestEvent>) {
        tx.send(TestEvent::EvtTestSuiteBegin(self.get_start_evt_data()))
            .unwrap();
    }

    fn fire_end_evt(&self, tx: &Sender<TestEvent>) {
        tx.send(TestEvent::EvtTestSuiteEnd(self.get_end_evt_data()))
            .unwrap();
    }

    // Returns Testsuite's event data for begin event.
    pub fn get_start_evt_data(&self) -> TestSuiteBegin {
        TestSuiteBegin {
            timestamp: Instant::now(),
            iteration_id: "1".to_string(),
            suite_name: "TestSuite".to_string(),
        }
    }

    pub fn get_end_evt_data(&self) -> TestSuiteEnd {
        TestSuiteEnd {
            timestamp: Instant::now(),
            exec_duration: self.exec_duration,
            iteration_id: "1".to_string(),
            suite_name: "TestSuite".to_string(),
        }
    }
}

fn parse_config_groups(
    config: &Config,
    default_worksheet: &str,
) -> HashMap<String, HashSet<String>> {
    let mut config_groups = HashMap::new();

    if let Some(groups) = &config.groups {
        for group in groups {
            let (worksheet, group_name) = match group {
                (Some(worksheet), group_name) => (worksheet.clone(), group_name.clone()),
                (None, group_name) => (default_worksheet.to_string(), group_name.clone()),
            };
            config_groups
                .entry(worksheet)
                .or_insert_with(HashSet::new)
                .insert(group_name);
        }
    }
    config_groups
}
