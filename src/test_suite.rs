// test_suite.rs
use crate::test_case::TestCase;

pub struct TestSuite {
    test_cases: Vec<TestCase>,
    jwt_token: Option<String>,
}

impl TestSuite {
    pub fn run(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        println!("Running the test suite");
        println!("======================");
        for test_case in &mut self.test_cases {
            let jwt_token = test_case.run(self.jwt_token.clone())?;
            //print the value of jwt_token
            if let Some(jwt_token) = jwt_token {
                self.jwt_token = Some(jwt_token);
            }
        }
        Ok(())
    }

    pub fn new(test_cases: Vec<TestCase>) -> Self {
        TestSuite {
            test_cases,
            jwt_token: None,
        }
    }
}
