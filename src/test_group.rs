/* Implements the notion of a test group.
    A test group is a collection of "related" test cases,
    which succeed as a whole for the group to pass.
*/

use crate::config::Config;
use crate::test_case::{TestCase, TestResult};
use crate::test_context::TestCtx;
use crate::test_events::{TestEvent, TestGroupBegin, TestGroupEnd};
use std::error::Error;
use std::sync::mpsc::Sender;
use std::time::Instant;

#[derive(Debug)]
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
    pub fn new(group_name: &str, tx: &Sender<TestEvent>) -> Self {
        let tg = TestGroup {
            name: group_name.to_string(),
            test_cases: vec![],
            group_ctx: TestCtx::new().unwrap(),
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            exec_duration: std::time::Duration::new(0, 0),
        };
        tg.fire_start_evt(tx);
        tg
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

    pub fn exec(
        &mut self,
        row: &[calamine::Data],
        config: &Config,
        tx: &Sender<TestEvent>,
    ) -> Result<(), Box<dyn Error>> {
        // Create an instance of test case, and execute it.
        let mut tc = TestCase::new(row, config);
        let t_result = tc.run(&mut self.group_ctx, config, tx);
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

    fn fire_start_evt(&self, tx: &Sender<TestEvent>) {
        tx.send(TestEvent::EvtTestGroupBegin(self.get_start_evt_data()))
            .unwrap();
    }

    pub fn fire_end_evt(&self, tx: &Sender<TestEvent>) {
        tx.send(TestEvent::EvtTestGroupEnd(self.get_end_evt_data()))
            .unwrap();
    }

    // Returns TestGroup's event data for begin event.
    pub fn get_start_evt_data(&self) -> TestGroupBegin {
        TestGroupBegin {
            timestamp: Instant::now(),
            iteration_id: "1".to_string(),
            group_name: self.name.clone(),
        }
    }

    // Returns TestGroup's event data for end event.
    pub fn get_end_evt_data(&self) -> TestGroupEnd {
        TestGroupEnd {
            timestamp: Instant::now(),
            exec_duration: self.exec_duration,
            iteration_id: "1".to_string(),
            group_name: self.name.clone(),
        }
    }
}
