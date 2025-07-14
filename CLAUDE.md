# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

satyanaash is a HTTP request/response testing framework written in Rust, inspired by Postman. It's a CLI tool that executes test cases defined in Excel files (.xlsx) in an opinionated format.

## Development Commands

### Build and Test
- `cargo build` - Build the project
- `cargo build --release` - Build optimized release version
- `cargo test` - Run tests
- `cargo run` - Run the application

### Running the Application
- `cargo run -- -t path/to/test.xlsx -v` - Run with test file and verbose output
- `cargo run -- -t path/to/test.xlsx -g group1,group2` - Run specific test groups
- `cargo run -- -h` - Show help

### Configuration
The application uses `config.yaml` for default configuration and supports command-line overrides for:
- Base URL (`-b`)
- Test file (`-t`) 
- Worksheet (`-w`)
- Groups (`-g`)
- Verbose mode (`-v`)
- Start/end rows (`-s`, `-e`)

## Code Architecture

### Core Components

1. **TSat** (src/lib.rs) - Main framework struct that coordinates test execution
2. **Config** (src/config.rs) - Configuration management combining config.yaml and CLI arguments
3. **TestSuite** (src/test_suite.rs) - Manages execution of test groups within a worksheet
4. **TestGroup** (src/test_group.rs) - Executes individual test cases within a group
5. **TestCase** (src/test_case.rs) - Individual HTTP test case with request/response handling
6. **V8Engine** (src/v8engine.rs) - JavaScript engine for pre/post-test scripts using deno_core

### Test Execution Flow

1. Main binary parses CLI args and config.yaml
2. TSat opens Excel file and iterates through worksheets
3. For each worksheet, TestSuite parses groups (rows starting with "Group:")
4. TestGroup executes individual test cases row by row
5. TestCase handles HTTP requests using reqwest and JavaScript evaluation using V8

### Key Features

- **Groups**: Test cases organized into logical groups within worksheets
- **JavaScript Support**: Pre-test and post-test JavaScript execution via V8 engine
- **Authentication**: JWT token management with `authorizer` and `authorized` types
- **Configuration**: Per-test-case config (delay, repeatCount, authType) via config column
- **File Upload**: Multipart form data support for file uploads
- **Variable Substitution**: Dynamic placeholder replacement in requests

### Dependencies

- `reqwest` - HTTP client library
- `calamine` - Excel file parsing
- `deno_core` - V8 JavaScript engine
- `serde`/`serde_json` - JSON serialization
- `getopts` - Command line argument parsing
- `bharat-cafe` - Custom utility library

### Test Data Format

Excel files should contain:
- Group headers: "Group:GroupName"
- Test case rows with columns for URL, method, headers, body, etc.
- Config column for per-test configuration (JSON format)

### Mock Server

The `mock-server/` directory contains a Node.js/Express server for testing with:
- JSON Server for REST API mocking
- JWT token generation
- File upload handling
- CORS support