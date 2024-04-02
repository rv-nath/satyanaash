// test_suite.rs
use crate::test_case::TestCase;

pub struct TestSuite {
    test_cases: Vec<TestCase>,
}

impl TestSuite {
    pub fn run(&mut self) {
        println!("Running the test suite");
        println!("======================");
        for mut test_case in &mut self.test_cases {
            test_case.run();
        }
    }

    pub fn new(test_cases: Vec<TestCase>) -> Self {
        TestSuite { test_cases }
    }
}
