use quick_js::Context;

// A convenient struct for packing the arguments for testcase::run.
// In future, we may be able to add more params, without changing the run method signature.

pub struct TestSuiteCtx<'a> {
    pub client: &'a reqwest::blocking::Client,
    pub jwt_token: Option<String>,
    pub runtime: &'a mut quick_js::Context,
    // More fields as necessary
}

impl<'a> TestSuiteCtx<'a> {
    pub fn new(
        client: &'a reqwest::blocking::Client,
        _jwt_token: Option<String>,
        runtime: &'a mut Context,
    ) -> Self {
        TestSuiteCtx {
            client,
            jwt_token: None,
            runtime,
        }
    }

    pub fn update_token(&mut self, token: Option<String>) {
        self.jwt_token = token;
    }
}
