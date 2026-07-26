export interface CodeSnippet {
  category: string;
  label: string;
  description: string;
  code: string;
}

/**
 * Pre-test scripts are Rhai, not JavaScript. Every snippet here is valid Rhai and
 * uses only what the engine registers (see api/src/execution/generators.rs) —
 * a snippet the user pastes and that then fails is worse than no snippet.
 */
export const preTestSnippets: CodeSnippet[] = [
  {
    category: "Authentication",
    label: "Bearer header from a variable",
    description: "Build an Authorization header out of a token already in the environment",
    code: `// SAT.env holds values saved by earlier runs; SAT.vars is this run only.
SAT.vars.authHeader = "Bearer " + SAT.env.authToken;`,
  },
  {
    category: "Authentication",
    label: "Basic auth header",
    description: "Encode username and password for basic auth",
    code: `SAT.vars.authHeader = "Basic " + base64Encode(SAT.env.username + ":" + SAT.env.password);`,
  },
  {
    category: "Data Setup",
    label: "Unique ID",
    description: "Generate a UUID v4 for this run",
    code: `SAT.vars.uniqueId = uuid();`,
  },
  {
    category: "Data Setup",
    label: "Timestamp",
    description: "Current time as RFC 3339, seconds, or milliseconds",
    code: `SAT.vars.createdAt = isoDate();     // 2026-07-26T09:15:00+00:00
SAT.vars.epoch     = timestamp();   // seconds
SAT.vars.epochMs   = timestampMs(); // milliseconds`,
  },
  {
    category: "Data Setup",
    label: "Random email",
    description: "Generate an email once so every step can reuse the same one",
    code: `// Generate ONCE here, then use {{testEmail}} in the payload and downstream.
// Writing {{$RandomEmail}} twice would give you two different addresses.
SAT.vars.testEmail = randomEmail();`,
  },
  {
    category: "Data Setup",
    label: "Signup identity",
    description: "A full set of matching signup values, reusable by name",
    code: `SAT.vars.myName     = randomName();
SAT.vars.myEmail    = randomEmail();
SAT.vars.myPhone    = randomPhone();
SAT.vars.myCompany  = randomCompany();
SAT.vars.myPassword = randomPassword(16);

// Now the payload can say {{myEmail}}, {{myPhone}}, …`,
  },
  {
    category: "Data Setup",
    label: "Random string & number",
    description: "Sized string and a bounded integer",
    code: `SAT.vars.suffix = randomString(8);          // 8 characters
SAT.vars.amount = randomInt(100, 9999);    // inclusive range`,
  },
  {
    category: "Persisting values",
    label: "Save for future runs",
    description: "Write into the active environment so later runs can read it",
    code: `// SAT.env survives the run and is saved to the active Environment
// (or Globals when no environment is selected).
SAT.env.deviceId = uuid();`,
  },
];

/**
 * Post-test assertions — Rhai expressions whose last value is the pass/fail
 * boolean. The same expressions are valid in a dataset row's Expect column,
 * which is evaluated by the same engine.
 */
export const postTestSnippets: CodeSnippet[] = [
  // Status Validation
  {
    category: "Status Codes",
    label: "Status 200 OK",
    description: "Assert successful response",
    code: `response.status == 200`,
  },
  {
    category: "Status Codes",
    label: "Status 201 Created",
    description: "Assert resource created",
    code: `response.status == 201`,
  },
  {
    category: "Status Codes",
    label: "Status 2xx Success",
    description: "Any success status code",
    code: `response.status >= 200 && response.status < 300`,
  },
  {
    category: "Status Codes",
    label: "Status 400 Bad Request",
    description: "Assert validation error",
    code: `response.status == 400`,
  },
  {
    category: "Status Codes",
    label: "Status 401 Unauthorized",
    description: "Assert authentication failure",
    code: `response.status == 401`,
  },
  {
    category: "Status Codes",
    label: "Status 404 Not Found",
    description: "Assert resource not found",
    code: `response.status == 404`,
  },
  // JSON Field Checks
  {
    category: "JSON Validation",
    label: "Check Field Exists",
    description: "Verify a JSON field is present",
    code: `response.status == 200 && response.json.id != ()`,
  },
  {
    category: "JSON Validation",
    label: "Check Field Value",
    description: "Verify a JSON field has specific value",
    code: `response.json.status == 200`,
  },
  {
    category: "JSON Validation",
    label: "Check Nested Field",
    description: "Access nested JSON property",
    code: `response.json.data.user.id != ()`,
  },
  {
    category: "JSON Validation",
    label: "Check Boolean Field",
    description: "Verify a boolean field is true",
    code: `response.json.success == true`,
  },
  {
    category: "JSON Validation",
    label: "Check Array Length",
    description: "Verify array has items",
    code: `response.json.items.len() > 0`,
  },
  {
    category: "JSON Validation",
    label: "Check Array Not Empty",
    description: "Verify response array is not empty",
    code: `response.status == 200 && response.json.len() > 0`,
  },
  // String Checks
  {
    category: "String Validation",
    label: "String Contains",
    description: "Check if field contains substring",
    code: `response.json.message.contains("success")`,
  },
  {
    category: "String Validation",
    label: "String Starts With",
    description: "Check if field starts with prefix",
    code: `response.json.id.starts_with("usr_")`,
  },
  {
    category: "String Validation",
    label: "Email Contains @",
    description: "Basic email validation",
    code: `response.json.email.contains("@")`,
  },
  // Combined Assertions
  {
    category: "Combined Checks",
    label: "Success with Token",
    description: "Status 200 and has auth token",
    code: `response.status == 200 && response.json.access_token != ()`,
  },
  {
    category: "Combined Checks",
    label: "Created with ID",
    description: "Status 201 and has ID field",
    code: `response.status == 201 && response.json.id != ()`,
  },
  {
    category: "Combined Checks",
    label: "Error with Message",
    description: "Error status with message field",
    code: `response.status >= 400 && response.json.message != ()`,
  },
  // Numeric Checks
  {
    category: "Numeric Validation",
    label: "Number Greater Than",
    description: "Check numeric field is above threshold",
    code: `response.json.count > 0`,
  },
  {
    category: "Numeric Validation",
    label: "Number In Range",
    description: "Check numeric field is within range",
    code: `response.json.age >= 18 && response.json.age <= 100`,
  },
];

export function getSnippetsByCategory(snippets: CodeSnippet[]): Map<string, CodeSnippet[]> {
  const categorized = new Map<string, CodeSnippet[]>();
  
  snippets.forEach(snippet => {
    const existing = categorized.get(snippet.category) || [];
    categorized.set(snippet.category, [...existing, snippet]);
  });
  
  return categorized;
}
