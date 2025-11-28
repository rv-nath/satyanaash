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
  {
    category: "Authentication",
    label: "Extract Auth Token",
    description: "Save token from response for future requests",
    code: `// Extract and save authentication token
const response = SAT.response;
SAT.vars.authToken = response.data.token;
SAT.vars.refreshToken = response.data.refreshToken;`,
  },
  {
    category: "Authentication",
    label: "Extract User Data",
    description: "Save user information from login response",
    code: `// Extract user information
const response = SAT.response;
SAT.vars.userId = response.data.user.id;
SAT.vars.userEmail = response.data.user.email;
SAT.vars.userName = response.data.user.name;`,
  },
  {
    category: "Status Validation",
    label: "Validate Success (200)",
    description: "Assert successful response",
    code: `// Validate successful response
SAT.assert(
  SAT.response.status === 200,
  "Expected status 200 OK"
);`,
  },
  {
    category: "Status Validation",
    label: "Validate Created (201)",
    description: "Assert resource created",
    code: `// Validate resource created
SAT.assert(
  SAT.response.status === 201,
  "Expected status 201 Created"
);`,
  },
  {
    category: "Status Validation",
    label: "Validate Unauthorized (401)",
    description: "Assert authentication failure",
    code: `// Validate unauthorized access
SAT.assert(
  SAT.response.status === 401,
  "Expected status 401 Unauthorized"
);`,
  },
  {
    category: "Status Validation",
    label: "Validate Not Found (404)",
    description: "Assert resource not found",
    code: `// Validate resource not found
SAT.assert(
  SAT.response.status === 404,
  "Expected status 404 Not Found"
);`,
  },
  {
    category: "Data Validation",
    label: "Check Response Structure",
    description: "Validate response has expected fields",
    code: `// Validate response structure
const response = SAT.response;
SAT.assert(response.data, "Response should have data");
SAT.assert(response.data.id, "Data should have id field");
SAT.assert(response.data.name, "Data should have name field");`,
  },
  {
    category: "Data Validation",
    label: "Validate Array Response",
    description: "Check response is an array with items",
    code: `// Validate array response
const response = SAT.response;
SAT.assert(Array.isArray(response.data), "Response should be an array");
SAT.assert(response.data.length > 0, "Array should not be empty");`,
  },
  {
    category: "Data Validation",
    label: "Validate Email Format",
    description: "Check email field is valid",
    code: `// Validate email format
const email = SAT.response.data.email;
const emailRegex = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
SAT.assert(
  emailRegex.test(email),
  \`Invalid email format: \${email}\`
);`,
  },
  {
    category: "Data Validation",
    label: "Validate Required Fields",
    description: "Check all required fields exist",
    code: `// Validate required fields
const data = SAT.response.data;
const requiredFields = ['id', 'name', 'email', 'createdAt'];

requiredFields.forEach(field => {
  SAT.assert(
    data[field] !== undefined && data[field] !== null,
    \`Missing required field: \${field}\`
  );
});`,
  },
  {
    category: "Error Handling",
    label: "Check Error Message",
    description: "Validate error response structure",
    code: `// Validate error response
const response = SAT.response;
SAT.assert(response.error, "Response should contain error");
SAT.assert(response.error.message, "Error should have message");
console.log("Error message:", response.error.message);`,
  },
  {
    category: "Error Handling",
    label: "Validate Error Code",
    description: "Check specific error code",
    code: `// Validate specific error code
const response = SAT.response;
SAT.assert(
  response.error?.code === "VALIDATION_ERROR",
  "Expected validation error code"
);`,
  },
  {
    category: "Performance",
    label: "Check Response Time",
    description: "Assert response time is acceptable",
    code: `// Validate response time
const responseTime = SAT.response.duration; // in ms
SAT.assert(
  responseTime < 1000,
  \`Response too slow: \${responseTime}ms (expected < 1000ms)\`
);`,
  },
  {
    category: "Data Extraction",
    label: "Extract Multiple Values",
    description: "Save multiple values from response",
    code: `// Extract multiple values from response
const response = SAT.response;
SAT.vars.resourceId = response.data.id;
SAT.vars.resourceName = response.data.name;
SAT.vars.resourceUrl = response.data.url;
SAT.vars.createdAt = response.data.createdAt;`,
  },
  {
    category: "Data Extraction",
    label: "Extract Nested Field",
    description: "Access deeply nested response data",
    code: `// Extract nested field
const response = SAT.response;
SAT.vars.userId = response.data?.user?.profile?.id;
SAT.assert(SAT.vars.userId, "User ID should exist in nested structure");`,
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
