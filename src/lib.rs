// In lib.rs
pub mod config;
mod test_case;
mod test_context;
mod test_events;
mod test_group;
mod test_suite; // Import the test_suite module
pub mod v8engine;

use crate::config::Config;
use crate::test_suite::TestSuite;
use calamine::{open_workbook, Reader, Xlsx};
use std::error::Error; // Import the TestSuite struct
use std::sync::mpsc::{channel, Receiver, Sender};
use test_events::TestEvent;

// Define a struct TSat that contains a channel transmitter
pub struct TSat {
    tx: Sender<test_events::TestEvent>,
    //rx: Receiver<test_events::TestEvent>,
}

// impl TSat
impl TSat {
    // Define a new method that creates a instance of TSat
    pub fn new() -> (Self, Receiver<TestEvent>) {
        let (tx, rx) = channel();
        (Self { tx }, rx)
    }

    pub fn exec(&self, filename: &str, config: &Config) -> Result<(), Box<dyn Error>> {
        // Open the excel file.
        let mut excel: Xlsx<_> = open_workbook(filename)?;
        let mut ts = TestSuite::new();

        // If a worksheet is specified in the config, only construct and run the TestSuite for that worksheet.
        if let Some(worksheet) = &config.worksheet {
            println!("Constructing test suite for sheet: {}", worksheet);

            /*
            self.tx
                .send(TestEvent::EvtTestSuiteBegin(ts.get_start_evt_data()))
                .unwrap();
            */
            let _ = ts.exec(&mut excel, worksheet, config, &self.tx)?;
        } else {
            // If no worksheet is specified, construct and run the TestSuite for all worksheets.
            for sheet_name in excel.sheet_names() {
                println!("Constructing test suite for sheet: {}", sheet_name);
                //let mut ts = TestSuite::new();
                let _ = ts.exec(&mut excel, &sheet_name, config, &self.tx)?;
            }
        }
        /*
        // Fire an event to indicate that the test suite is finished.
        self.tx
            .send(TestEvent::EvtTestSuiteEnd(ts.get_end_evt_data()))
            .unwrap();
        */
        println!("Done running the test suite");

        Ok(())
    }
}
