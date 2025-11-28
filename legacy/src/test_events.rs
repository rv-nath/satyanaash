//
// Define test events.  Test events are events that are
// used to fire by the test framework whenever certain
// actions occur.  For example, when a test starts, a
// test event is fired.  When a test ends, a test event
// is fired.  When a test fails, a test event is fired.
//
use std::time::Instant;

#[derive(Debug)]
pub struct TestSuiteBegin {
    pub timestamp: Instant,
    pub iteration_id: String,
    pub suite_name: String,
}

#[derive(Debug)]
pub struct TestSuiteEnd {
    pub timestamp: Instant,
    pub exec_duration: std::time::Duration,
    pub iteration_id: String,
    pub suite_name: String,
}

#[derive(Debug)]
pub struct TestGroupBegin {
    pub timestamp: Instant,
    pub iteration_id: String,
    pub group_name: String,
}

#[derive(Debug)]
pub struct TestGroupEnd {
    pub timestamp: Instant,
    pub iteration_id: String,
    pub group_name: String,
    pub exec_duration: std::time::Duration,
}

#[derive(Debug)]
pub struct TestCaseBegin {
    pub timestamp: Instant,
    pub iteration_id: String,
    pub testcase_id: u32,
    pub testcase_name: String,
    pub given: String,
    pub when: String,
    pub then: String,
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub payload: String,
    pub pre_test_script: Option<String>,
    pub post_test_script: Option<String>,
    //pub is_authorizer: bool,
    //pub is_authorized: bool,
}

#[derive(Debug)]
pub struct TestCaseEnd {
    pub timestamp: Instant,
    pub iteration_id: String,
    pub testcase_id: u32,
    pub exec_duration: std::time::Duration,
    pub status: i64,
    pub response: String,
    pub response_json: Option<serde_json::Value>,
}

#[derive(Debug)]
pub enum TestEvent {
    EvtTestSuiteBegin(TestSuiteBegin),
    EvtTestSuiteEnd(TestSuiteEnd),
    EvtTestGroupBegin(TestGroupBegin),
    EvtTestGroupEnd(TestGroupEnd),
    EvtTestCaseBegin(TestCaseBegin),
    EvtTestCaseEnd(TestCaseEnd),
}
