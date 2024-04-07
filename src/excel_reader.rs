use crate::config::Config;
use crate::test_case::TestCase;
use calamine::{open_workbook, Reader, Xlsx};
use std::error::Error;

//const GROUP_START: &str = "__GROUP_START__";
//const GROUP_END: &str = "__GROUP_END__";

pub fn read_test_data(filename: &str, config: &Config) -> Result<Vec<TestCase>, Box<dyn Error>> {
    let mut test_cases = Vec::new();
    let mut workbook: Xlsx<_> = open_workbook(filename)?;

    // Extract the configuration values
    let start_row = config.start_row.unwrap_or(1);
    let end_row = config.end_row.unwrap_or(std::usize::MAX);

    // loop over rows in this worksheet and read test cases
    for (index, row) in workbook
        .worksheet_range("Sheet1")
        .unwrap()
        .rows()
        .enumerate()
    {
        // skip if the row is less than start row
        if index < start_row {
            continue;
        }

        // break if the row is greater than end row
        if index > end_row {
            break;
        }

        // read test case data from the row
        let row_data: Vec<&dyn calamine::DataType> = row
            .iter()
            .map(|cell| cell as &dyn calamine::DataType)
            .collect();
        let test_case = TestCase::new(&row_data, config);
        // prepend the baseurl to url field.
        test_cases.push(test_case);
    }
    Ok(test_cases) // Return the test_cases vector as a Result
}
