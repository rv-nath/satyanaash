// In lib.rs
pub mod config;
mod test_case;
mod test_context;
mod test_group;
mod test_result;
mod test_suite; // Import the test_suite module

use crate::config::Config;
use crate::test_suite::TestSuite;
use calamine::{open_workbook, Reader, Xlsx};
use std::error::Error; // Import the TestSuite struct

pub fn exec(filename: &str, config: &Config) -> Result<(), Box<dyn Error>> {
    // Open the excel file.
    let mut excel: Xlsx<_> = open_workbook(filename)?;

    // If a worksheet is specified in the config, only construct and run the TestSuite for that worksheet.
    if let Some(worksheet) = &config.worksheet {
        println!("Constructing test suite for sheet: {}", worksheet);
        let mut ts = TestSuite::new();
        let _ = ts.exec(&mut excel, worksheet, config)?;
    } else {
        // If no worksheet is specified, construct and run the TestSuite for all worksheets.
        for sheet_name in excel.sheet_names() {
            println!("Constructing test suite for sheet: {}", sheet_name);
            let mut ts = TestSuite::new();
            let _ = ts.exec(&mut excel, &sheet_name, config)?;
        }
    }

    println!("Done running the test suite");

    Ok(())
}
