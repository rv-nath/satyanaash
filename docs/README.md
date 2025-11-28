
[![Rust](https://github.com/rv-nath/satyanaash/actions/workflows/rust.yml/badge.svg?cache-bust=1)](https://github.com/rv-nath/satyanaash/actions/workflows/rust.yml)

# satyanaash
A delusional framework for automatic testing of http endpoints

## Brief
This is a http request /response testing framework, inspired mostly by Postman.  A simple cli tool that can run test cases defined in an excel file in an opinionated format.  This framework is purely written in Rust and is a terminal application.


## Installation
You may download the executable from the releases page [here](https://github.com/rv-nath/satyanaash/releases).  Note that the latest versions do not support windows binaries.

Check if the binary is working properly for your operating system.  Run the executable with -h or --help to see if this emits a meaningful usage output.

```shell
Usage: ./satyanaash [options]

Options:
    -s, --start_row START_ROW
                        Set the start row
    -e, --end_row END_ROW
                        Set the end row
    -b, --base_url BASE_URL
                        Set the base URL
    -t, --test_file TEST_FILE
                        Set the test file
    -w, --worksheet WORKSHEET
                        Set the worksheet
    -g, --groups GROUPS Set the test groups
    -h, --help          Print this help menu
    -v, --verbose       Print verbose information
```

**Note** that -s and -e options are not stable and they mabe be deprecated in future.

## How to use
First you need to decide and define your test requests in an excel file (.xlsx).  Here is a screenshot which shows few samples.

![image](https://github.com/user-attachments/assets/07f8bf08-a0c0-456d-952e-869f8c9a5117)

The program now supports a concept of groups.  You can create groups of related test cases by using a `group:` followed by a name
for the group.  Any test cases under this row are treated as part of this named group, until eof or encountered by another group.

A group will let you define test cases in a more logical and practical manner. For example, you could define scenarios of tests,
by defining the following test cases within a group.  For example, the below set of operations end to end.

**Group:PkgCreation**
- login  -- POST /login
- package creation -- POST /pkgs
- Get the package by id  -- GET /pkgs/:id 
- ..
- logout  --  POST  /logout
<br>


Once you define your test cases in the excel file, you may execute the test program using the excel file as an argument.
```shell
$  ./satyanaash -t /path/to/your/excel-file.xlsx  -v 
```

If your excel file has multiple groups, you may choose to execute any specific group by its name as below.
```shell
$  ./satyanaash -t /path/to/your/excel-file.xlsx  -v -g one,two,three
```

This version also supports a new feature called config.  Config feature allows you to define a test case specific configuration
within the excel's test case row.

![image](https://github.com/user-attachments/assets/7acc9f36-7f78-429a-9cdc-5ac573b5ddbd)

Using the config column of the test case, you could tweak the behaviour of each test case as in:
- **delay** time interval or delay (in millis) after which the test case should be executed.
- **repeatCount** The no. of times this test case should be executed in a loop.  During each loop iteration, the pre-test-script is
  evaluated and all placeholders are re-substituted.  This helps in executing each iteration with a fresh set of values.
- **authType** Should be either `authorized` or `authorizer`.    authorizer indicates that execution of this test case generates a
  a JWT token, which could be used by any subsequent test case.  In the same way, 'authorized' indicates that this test case
  requires a JWT.
- 


Adds some nonsense...
