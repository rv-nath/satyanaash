export interface CodeSnippet {
  category: string;
  label: string;
  description: string;
  code: string;
}

export const preTestSnippets: CodeSnippet[] = [
  {
    category: "Authentication",
    label: "Set Auth Token",
    description: "Add authorization header from variable",
    code: `// Set authorization header
SAT.vars.authHeader = \`Bearer \${SAT.vars.authToken}\`;`,
  },
  {
    category: "Authentication",
    label: "Set Basic Auth",
    description: "Encode username/password for basic auth",
    code: `// Set basic authentication
const credentials = btoa(\`\${SAT.vars.username}:\${SAT.vars.password}\`);
SAT.vars.authHeader = \`Basic \${credentials}\`;`,
  },
  {
    category: "Data Setup",
    label: "Generate UUID",
    description: "Create a unique identifier",
    code: `// Generate unique ID
SAT.vars.uniqueId = crypto.randomUUID();`,
  },
  {
    category: "Data Setup",
    label: "Current Timestamp",
    description: "Get current timestamp in ISO format",
    code: `// Generate timestamp
SAT.vars.timestamp = new Date().toISOString();`,
  },
  {
    category: "Data Setup",
    label: "Random Email",
    description: "Generate random test email",
    code: `// Generate random test email
SAT.vars.testEmail = \`test_\${Date.now()}@example.com\`;`,
  },
];

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
