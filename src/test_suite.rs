use crate::config::Config;
use crate::test_group::TestGroup;
use anyhow::Result;
use calamine::DataType;
use calamine::Reader;
use calamine::Xlsx;
use std::collections::HashMap;
use std::collections::HashSet;
use std::{
    error::Error,
    io::{Read, Seek},
};

pub struct TestSuite {
    test_groups: Vec<TestGroup>,
    total: usize,
    passed: usize,
    failed: usize,
    skipped: usize,
    exec_duration: std::time::Duration, // Total duration for test suite execution
}

impl TestSuite {
    pub fn new() -> Self {
        // Initialize the test suite object and return.
        TestSuite {
            test_groups: vec![],
            total: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            exec_duration: std::time::Duration::new(0, 0),
        }
    }

    pub fn exec<R: Read + Seek>(
        &mut self,
        excel: &mut Xlsx<R>,
        worksheet_name: &str,
        config: &Config,
    ) -> Result<(), Box<dyn Error>> {
        let start_time = std::time::Instant::now();

        let range = excel.worksheet_range(worksheet_name)?;
        let mut current_group: Option<TestGroup> = None;

        // Parse the config groups into a HashMap for quick lookup
        let config_groups = parse_config_groups(config, worksheet_name);

        for (i, row) in range.rows().enumerate() {
            // skip rows until start_row
            if i < config.start_row.unwrap_or(1) {
                continue;
            }

            let first_cell = row[0].get_string().unwrap_or("");
            if first_cell.starts_with("Group:") {
                // Finalize the current group if it exists
                if let Some(group) = current_group.take() {
                    // print group results
                    group.print_stats();
                    self.test_groups.push(group);
                }
                // Create a new group with the name that appears after "Group:"
                let group_name = first_cell.trim_start_matches("Group:").trim();

                // If the group name is specified in the config for this worksheet,
                // construct and run the test group.
                if let Some(groups) = config_groups.get(worksheet_name) {
                    if groups.contains(group_name) {
                        current_group = Some(TestGroup::new(group_name));
                        println!("{}", "-".repeat(80));
                        println!("Starting Group: {}...", group_name);
                        println!("{}", "-".repeat(80));
                    }
                }
            } else {
                // If we are in a group, call the group's exec method
                if let Some(group) = current_group.as_mut() {
                    group.exec(row, config)?;
                }
            }
        }

        // Finalize the last group if it exists
        if let Some(group) = current_group.take() {
            group.print_stats();
            self.test_groups.push(group);
        }

        Ok(())
    }
}

fn parse_config_groups(
    config: &Config,
    default_worksheet: &str,
) -> HashMap<String, HashSet<String>> {
    let mut config_groups = HashMap::new();

    if let Some(groups) = &config.groups {
        for group in groups {
            let (worksheet, group_name) = match group {
                (Some(worksheet), group_name) => (worksheet.clone(), group_name.clone()),
                (None, group_name) => (default_worksheet.to_string(), group_name.clone()),
            };
            config_groups
                .entry(worksheet)
                .or_insert_with(HashSet::new)
                .insert(group_name);
        }
    }
    config_groups
}
