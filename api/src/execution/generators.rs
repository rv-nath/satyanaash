//! Random / dynamic data generators.
//!
//! The same generators are reachable two ways:
//! - as `{{$Macros}}` in interpolation (see `variables.rs`), and
//! - as callable Rhai functions in pre-test / assertion scripts (registered here),
//!   e.g. `SAT.vars.phone = randomPhone();`.

use rhai::{Engine, ImmutableString};

use super::variables::{rand_simple, generate_random_string, generate_random_password};

/// Register generator functions on a Rhai engine.
pub fn register(engine: &mut Engine) {
    engine.register_fn("randomEmail", || bharat_cafe::random_email(None));
    engine.register_fn("randomEmail", |domain: ImmutableString| {
        bharat_cafe::random_email(Some(domain.as_str()))
    });
    engine.register_fn("randomName", || bharat_cafe::random_name());
    engine.register_fn("randomCompany", || bharat_cafe::generate_company_name());
    engine.register_fn("randomPhone", || bharat_cafe::random_phone());
    engine.register_fn("randomAddress", || bharat_cafe::random_address());
    engine.register_fn("randomUsername", || {
        format!("user_{}", generate_random_string(8).to_lowercase())
    });
    engine.register_fn("randomString", || generate_random_string(10));
    engine.register_fn("randomString", |len: i64| generate_random_string(len.max(0) as usize));
    engine.register_fn("randomPassword", || generate_random_password(16));
    engine.register_fn("randomPassword", |len: i64| generate_random_password(len.max(0) as usize));
    engine.register_fn("randomInt", || rand_simple() % 1000);
    engine.register_fn("randomInt", |min: i64, max: i64| {
        if max <= min {
            min
        } else {
            min + (rand_simple() % (max - min + 1))
        }
    });
    engine.register_fn("uuid", || uuid::Uuid::new_v4().to_string());
    engine.register_fn("timestamp", || chrono::Utc::now().timestamp());
    engine.register_fn("timestampMs", || chrono::Utc::now().timestamp_millis());
    engine.register_fn("isoDate", || chrono::Utc::now().to_rfc3339());
}
