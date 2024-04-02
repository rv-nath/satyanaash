pub struct TestRunner {
    test_cases: Vec<TestCase>,
}

impl TestRunner {
    pub fn new(test_cases: Vec<TestCase>) -> Self {
        TestRunner { test_cases }
    }

    pub fn exec(&self) -> Result<(), Box<dyn Error>> {
        for test_case in self.test_cases {
            // execute the test case.
            let result = self.execute_test_case(&test_case)?;
            // compare the result with the expected result.
            let comparison = self.compare_result(&test_case, result);
            // Print the result
            self.print_result(&result, comparison);
        }
    }

    fn execute_test_case(
        &self,
        test_case: &TestCase,
    ) -> Result<(StatusCode, String), Box<dyn Err>> {
        unimplemented!()
    }
}
