import { useState, useEffect, useRef, useCallback } from "react";
import { ArrowLeft, Save, Play, X, FileCode, Code2, BookOpen, Plus, Eye, ClipboardList, CheckCircle2, XCircle, AlertCircle, Loader2, WrapText, Pencil, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { useTestProject } from "@/contexts/TestProjectContext";
import { useTestCase, useCreateTestCase, useUpdateTestCase, useExecuteTestCase } from "@/hooks/useApi";
import { getUpstreamVariables } from "@/lib/variableUtils";
import { preTestSnippets, postTestSnippets, getSnippetsByCategory } from "@/lib/testSnippets";
import { HeadersEditor, HeaderRow, headersToJson, jsonToHeaders } from "@/components/HeadersEditor";
import type { TestCaseExecutionResult } from "@/lib/api/types";

interface TestCaseEditorProps {
  testCaseId?: string; // Optional - undefined means create mode
  onClose: () => void;
  onCreated?: (newTestCaseId: string) => void; // Callback when a new test case is created
}

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

// Humanized section header (Section 8): plain-English lead + one-line helper.
function SectionLead({ title, helper }: { title: string; helper: string }) {
  return (
    <div className="mb-5">
      <p className="text-[15px] font-semibold" style={{ color: "hsl(var(--lead-color))" }}>{title}</p>
      <p className="mt-0.5 max-w-xl text-[13px] text-muted-foreground">{helper}</p>
    </div>
  );
}

// Humanized field label (Section 8): dimmed label + faint technical hint.
function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline gap-2 text-[13px] font-medium" style={{ color: "hsl(var(--label-color))" }}>
      {children}
      {hint && (
        <span className="text-[10px] uppercase tracking-wide" style={{ color: "hsl(var(--hint-color))" }}>{hint}</span>
      )}
    </div>
  );
}

export const TestCaseEditor = ({ testCaseId, onClose, onCreated }: TestCaseEditorProps) => {
  const { projectId, nodes, edges, closeTestCaseEditor } = useTestProject();

  const isCreateMode = !testCaseId;

  // Fetch test case data (only in edit mode)
  const { data: testCase, isLoading } = useTestCase(testCaseId || '');
  const createMutation = useCreateTestCase();
  const updateMutation = useUpdateTestCase();
  const executeMutation = useExecuteTestCase();

  // Execution result state
  const [executionResult, setExecutionResult] = useState<TestCaseExecutionResult | null>(null);
  const [wordWrap, setWordWrap] = useState(true);

  // Form state
  const [name, setName] = useState("");
  const [givenCondition, setGivenCondition] = useState("");
  const [whenAction, setWhenAction] = useState("");
  const [thenExpected, setThenExpected] = useState("");
  const [method, setMethod] = useState<HttpMethod>("GET");
  const [endpoint, setEndpoint] = useState("");
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  const [payload, setPayload] = useState("");
  const [preTestScript, setPreTestScript] = useState("");
  const [postTestScript, setPostTestScript] = useState("");
  const [activeTab, setActiveTab] = useState("overview");
  const [isDirty, setIsDirty] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Refs for text insertion
  const endpointRef = useRef<HTMLInputElement>(null);
  const payloadRef = useRef<HTMLTextAreaElement>(null);
  const preTestRef = useRef<HTMLTextAreaElement>(null);
  const postTestRef = useRef<HTMLTextAreaElement>(null);

  // Get available variables from upstream nodes
  const availableVars = getUpstreamVariables(testCaseId, nodes, edges);

  // Initialize form when test case loads (edit mode) or with defaults (create mode)
  useEffect(() => {
    if (isCreateMode) {
      // Create mode - start with sensible defaults
      setName("New Test Case");
      setGivenCondition("");
      setWhenAction("");
      setThenExpected("");
      setMethod("GET");
      setEndpoint("");
      setHeaders(jsonToHeaders(""));
      setPayload("");
      setPreTestScript("");
      setPostTestScript("");
      setIsDirty(true); // Mark as dirty so user knows to save
    } else if (testCase) {
      // Edit mode - load existing data
      setName(testCase.name);
      setGivenCondition(testCase.given_condition || "");
      setWhenAction(testCase.when_action || "");
      setThenExpected(testCase.then_expected || "");
      setMethod(testCase.method as HttpMethod);
      setEndpoint(testCase.endpoint || "");
      setHeaders(jsonToHeaders(testCase.headers ? JSON.stringify(testCase.headers) : ""));
      setPayload(testCase.payload || "");
      setPreTestScript(testCase.pre_test_script || "");
      setPostTestScript(testCase.assertion_script || "");
      setIsDirty(false);
    }
  }, [testCase, isCreateMode]);

  // Auto-resize payload textarea when content changes
  useEffect(() => {
    if (payloadRef.current) {
      payloadRef.current.style.height = 'auto';
      payloadRef.current.style.height = payloadRef.current.scrollHeight + 'px';
    }
  }, [payload]);

  // Mark as dirty when any field changes
  const handleFieldChange = useCallback(<T,>(setter: (value: T) => void) => {
    return (value: T) => {
      setter(value);
      setIsDirty(true);
    };
  }, []);

  const insertVariable = (varName: string, fieldRef: React.RefObject<HTMLInputElement | HTMLTextAreaElement>) => {
    if (!fieldRef.current) return;

    const input = fieldRef.current;
    const start = input.selectionStart || 0;
    const end = input.selectionEnd || 0;
    let currentValue = "";
    let setValue: (v: string) => void;

    if (fieldRef === endpointRef) {
      currentValue = endpoint;
      setValue = (v) => { setEndpoint(v); setIsDirty(true); };
    } else {
      currentValue = payload;
      setValue = (v) => { setPayload(v); setIsDirty(true); };
    }

    const newValue = currentValue.slice(0, start) + `{{${varName}}}` + currentValue.slice(end);
    setValue(newValue);

    setTimeout(() => {
      input.focus();
      const newCursorPos = start + varName.length + 4;
      input.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  };

  // Handle headers change
  const handleHeadersChange = useCallback((newHeaders: HeaderRow[]) => {
    setHeaders(newHeaders);
    setIsDirty(true);
  }, []);

  const insertSnippet = (code: string, fieldRef: React.RefObject<HTMLTextAreaElement>) => {
    if (!fieldRef.current) return;

    const textarea = fieldRef.current;
    const start = textarea.selectionStart || 0;
    const end = textarea.selectionEnd || 0;
    const currentValue = fieldRef === preTestRef ? preTestScript : postTestScript;
    const setValue = fieldRef === preTestRef
      ? (v: string) => { setPreTestScript(v); setIsDirty(true); }
      : (v: string) => { setPostTestScript(v); setIsDirty(true); };

    const beforeText = currentValue.slice(0, start);
    const afterText = currentValue.slice(end);
    const needsNewlineBefore = beforeText.length > 0 && !beforeText.endsWith('\n');
    const needsNewlineAfter = afterText.length > 0 && !afterText.startsWith('\n');

    const newValue = beforeText +
      (needsNewlineBefore ? '\n' : '') +
      code +
      (needsNewlineAfter ? '\n' : '') +
      afterText;

    setValue(newValue);

    setTimeout(() => {
      textarea.focus();
      const newCursorPos = start + (needsNewlineBefore ? 1 : 0) + code.length;
      textarea.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  };

  const hasPayload = ["POST", "PUT", "PATCH"].includes(method);

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error("Test case name is required");
      return;
    }

    if (!endpoint.trim()) {
      toast.error("Endpoint URL is required");
      setActiveTab("request");
      return;
    }

    // Convert headers to JSON string
    const headersJson = headersToJson(headers);

    // Validate JSON payload if provided
    if (hasPayload && payload.trim()) {
      try {
        JSON.parse(payload);
      } catch {
        toast.error("Invalid JSON payload");
        return;
      }
    }

    if (!projectId) {
      toast.error("Project ID not found");
      return;
    }

    const testCaseData = {
      name,
      given_condition: givenCondition || undefined,
      when_action: whenAction || undefined,
      then_expected: thenExpected || undefined,
      method,
      endpoint,
      headers: headersJson ? JSON.parse(headersJson) : undefined,
      payload: hasPayload && payload.trim() ? payload : undefined,
      assertion_script: postTestScript || undefined,
      pre_test_script: preTestScript || undefined,
    };

    try {
      if (isCreateMode) {
        // Create new test case
        const newTestCase = await createMutation.mutateAsync({
          projectId,
          data: testCaseData
        });
        setIsDirty(false);
        toast.success("Test case created");
        // Notify parent and optionally switch to edit mode
        onCreated?.(newTestCase.id);
      } else {
        // Update existing test case
        await updateMutation.mutateAsync({
          id: testCaseId!,
          data: testCaseData,
          projectId
        });
        setIsDirty(false);
        toast.success("Test case saved");
      }
    } catch (err) {
      toast.error(isCreateMode ? "Failed to create test case" : "Failed to save test case");
      console.error(err);
    }
  };

  const handleClose = () => {
    if (isDirty) {
      if (window.confirm("You have unsaved changes. Are you sure you want to close?")) {
        closeTestCaseEditor();
        onClose();
      }
    } else {
      closeTestCaseEditor();
      onClose();
    }
  };

  const handleRunTest = async () => {
    if (!testCaseId) {
      toast.error("Save the test case before running");
      return;
    }

    if (!endpoint.trim()) {
      toast.error("Endpoint URL is required");
      setActiveTab("request");
      return;
    }

    try {
      // Send current form values as overrides (allows running unsaved changes)
      const headersJson = headersToJson(headers);
      const result = await executeMutation.mutateAsync({
        id: testCaseId,
        data: {
          method,
          endpoint,
          headers: headersJson ? JSON.parse(headersJson) : undefined,
          payload: hasPayload && payload.trim() ? payload : undefined,
          assertion_script: postTestScript || undefined,
          pre_test_script: preTestScript || undefined,
        },
      });
      setExecutionResult(result);
      setActiveTab("response");

      if (result.status === 'passed') {
        toast.success(`Test passed in ${result.duration_ms}ms`);
      } else if (result.status === 'failed') {
        toast.error(`Test failed: ${result.error_message || 'Assertion failed'}`);
      } else if (result.status === 'error') {
        toast.error(`Test error: ${result.error_message || 'Unknown error'}`);
      }
    } catch (err) {
      toast.error("Failed to execute test");
      console.error(err);
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
      if (e.key === 'Escape') {
        handleClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleSave, handleClose]);

  // Only show loading state in edit mode
  if (!isCreateMode && isLoading) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-muted-foreground">Loading test case...</p>
        </div>
      </div>
    );
  }

  // Only show not-found state in edit mode
  if (!isCreateMode && !testCase) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="text-center">
          <FileCode className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <p className="text-muted-foreground">Test case not found</p>
          <Button variant="outline" className="mt-4" onClick={handleClose}>
            Go Back
          </Button>
        </div>
      </div>
    );
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;

  const getMethodColor = (m: string) => {
    const colors: Record<string, string> = {
      GET: "bg-success/20 text-success",
      POST: "bg-primary/20 text-primary",
      PUT: "bg-warning/20 text-warning",
      DELETE: "bg-destructive/20 text-destructive",
      PATCH: "bg-accent/20 text-accent",
    };
    return colors[m] || "bg-muted";
  };

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border bg-card">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={handleClose}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div className="flex items-center gap-3">
            {isCreateMode && (
              <Badge variant="outline" className="text-primary border-primary">
                New
              </Badge>
            )}
            <Badge className={`${getMethodColor(method)}`}>{method}</Badge>
            {isEditingName ? (
              <div className="flex items-center gap-2">
                <Input
                  ref={nameInputRef}
                  value={name}
                  onChange={(e) => handleFieldChange(setName)(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setIsEditingName(false);
                    if (e.key === 'Escape') setIsEditingName(false);
                  }}
                  onBlur={() => setIsEditingName(false)}
                  className="h-8 w-64 font-mono text-base"
                  autoFocus
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setIsEditingName(false)}
                >
                  <Check className="w-4 h-4 text-success" />
                </Button>
              </div>
            ) : (
              <div
                className="flex items-center gap-2 group cursor-pointer"
                onClick={() => {
                  setIsEditingName(true);
                  setTimeout(() => nameInputRef.current?.select(), 0);
                }}
              >
                <h2 className="text-lg font-semibold font-mono">{name || "Untitled"}</h2>
                <Pencil className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            )}
            {isDirty && (
              <Badge variant="outline" className="text-warning border-warning">
                {isCreateMode ? "Not saved" : "Unsaved"}
              </Badge>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isCreateMode && (
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={handleRunTest}
              disabled={executeMutation.isPending}
            >
              {executeMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Play className="w-4 h-4" />
              )}
              {executeMutation.isPending ? "Running..." : "Run Test"}
            </Button>
          )}
          <Button
            size="sm"
            className="gap-2"
            onClick={handleSave}
            disabled={isSaving}
          >
            <Save className="w-4 h-4" />
            {isSaving ? "Saving..." : isCreateMode ? "Create" : "Save"}
          </Button>
          <Button variant="ghost" size="icon" onClick={handleClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Content with Tabs */}
      <div className="flex-1 overflow-hidden">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="h-full flex flex-col">
          <div className="border-b border-border px-6">
            <TabsList className="h-12">
              <TabsTrigger value="overview" className="gap-2">
                <ClipboardList className="w-4 h-4" />
                Overview
              </TabsTrigger>
              <TabsTrigger value="request" className="gap-2">
                <FileCode className="w-4 h-4" />
                Request
              </TabsTrigger>
              <TabsTrigger value="scripts" className="gap-2">
                <Code2 className="w-4 h-4" />
                Scripts
              </TabsTrigger>
              <TabsTrigger value="response" className="gap-2">
                <Eye className="w-4 h-4" />
                Response
              </TabsTrigger>
            </TabsList>
          </div>

          {/* Overview Tab - BDD Fields */}
          <TabsContent value="overview" className="flex-1 mt-0 overflow-hidden">
            <ScrollArea className="h-full">
              <div className="p-6 max-w-2xl">
                <SectionLead
                  title="What does this test check?"
                  helper="Describe the scenario in plain words. This documents the test and shows up in run reports — it doesn't affect how the request runs."
                />

                <div className="space-y-5">
                  {/* Before / setup */}
                  <div className="pl-3 border-l-2" style={{ borderColor: "hsl(214 90% 62% / 0.5)" }}>
                    <FieldLabel hint="given">Before — the setup</FieldLabel>
                    <p className="mt-0.5 mb-1.5 text-xs text-muted-foreground">What must already be true for this test to make sense.</p>
                    <Textarea
                      id="given"
                      value={givenCondition}
                      onChange={(e) => handleFieldChange(setGivenCondition)(e.target.value)}
                      placeholder="e.g., A valid auth token and a well-formed payload"
                      className="ph-faint text-sm min-h-[72px]"
                    />
                  </div>

                  {/* Action */}
                  <div className="pl-3 border-l-2" style={{ borderColor: "hsl(38 92% 55% / 0.5)" }}>
                    <FieldLabel hint="when">Action — what happens</FieldLabel>
                    <p className="mt-0.5 mb-1.5 text-xs text-muted-foreground">The request this test makes.</p>
                    <Textarea
                      id="when"
                      value={whenAction}
                      onChange={(e) => handleFieldChange(setWhenAction)(e.target.value)}
                      placeholder="e.g., The Send SMS API is called"
                      className="ph-faint text-sm min-h-[72px]"
                    />
                  </div>

                  {/* Expected */}
                  <div className="pl-3 border-l-2" style={{ borderColor: "hsl(142 71% 50% / 0.5)" }}>
                    <FieldLabel hint="then">Expected result</FieldLabel>
                    <p className="mt-0.5 mb-1.5 text-xs text-muted-foreground">What a passing run looks like.</p>
                    <Textarea
                      id="then"
                      value={thenExpected}
                      onChange={(e) => handleFieldChange(setThenExpected)(e.target.value)}
                      placeholder="e.g., Responds 201 with a message id"
                      className="ph-faint text-sm min-h-[72px]"
                    />
                  </div>
                </div>
              </div>
            </ScrollArea>
          </TabsContent>

          {/* Request Tab */}
          <TabsContent value="request" className="flex-1 mt-0 overflow-hidden">
            <ScrollArea className="h-full">
              <div className="p-6 space-y-6 max-w-4xl">
                <SectionLead
                  title="How is the request made?"
                  helper="The actual HTTP call this test sends."
                />
                {/* Variables you can use here */}
                {availableVars.length > 0 && (
                  <div className="bg-muted/50 border border-border rounded-md p-4">
                    <Label className="text-xs font-semibold mb-2 block" style={{ color: "hsl(var(--label-color))" }}>Variables you can use here</Label>
                    <div className="flex flex-wrap gap-2">
                      {availableVars.map((v, idx) => (
                        <Badge
                          key={idx}
                          variant="secondary"
                          className="text-xs cursor-help font-mono"
                          title={`From: ${v.nodeName}`}
                        >
                          {v.name}
                        </Badge>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">
                      Use <code className="px-1 py-0.5 bg-background rounded text-xs">{'{{variableName}}'}</code> in endpoint or payload
                    </p>
                  </div>
                )}

                {/* Method & Endpoint */}
                <div className="grid grid-cols-[180px_1fr] gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="method" style={{ color: "hsl(var(--label-color))" }}>Method <span className="ml-1 text-[10px] uppercase tracking-wide" style={{ color: "hsl(var(--hint-color))" }}>HTTP</span></Label>
                    <Select value={method} onValueChange={(v) => handleFieldChange(setMethod)(v as HttpMethod)}>
                      <SelectTrigger id="method">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="GET">GET</SelectItem>
                        <SelectItem value="POST">POST</SelectItem>
                        <SelectItem value="PUT">PUT</SelectItem>
                        <SelectItem value="DELETE">DELETE</SelectItem>
                        <SelectItem value="PATCH">PATCH</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="endpoint" style={{ color: "hsl(var(--label-color))" }}>URL</Label>
                      {availableVars.length > 0 && (
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-6 text-xs">
                              <Plus className="h-3 w-3 mr-1" />
                              Insert Var
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-56 p-2" align="end">
                            <div className="space-y-1">
                              {availableVars.map((v, idx) => (
                                <Button
                                  key={idx}
                                  variant="ghost"
                                  size="sm"
                                  className="w-full justify-start text-xs font-mono h-8"
                                  onClick={() => insertVariable(v.name, endpointRef)}
                                >
                                  {v.name}
                                  <span className="ml-auto text-[10px] text-muted-foreground truncate max-w-[100px]">
                                    {v.nodeName}
                                  </span>
                                </Button>
                              ))}
                            </div>
                          </PopoverContent>
                        </Popover>
                      )}
                    </div>
                    <Input
                      ref={endpointRef}
                      id="endpoint"
                      value={endpoint}
                      onChange={(e) => handleFieldChange(setEndpoint)(e.target.value)}
                      placeholder="/api/users/{{userId}}"
                      className="font-mono text-sm code-input ph-faint"
                    />
                  </div>
                </div>

                {/* Headers */}
                <div className="space-y-2">
                  <Label style={{ color: "hsl(var(--label-color))" }}>Headers</Label>
                  <HeadersEditor
                    headers={headers}
                    onChange={handleHeadersChange}
                    availableVars={availableVars}
                  />
                  <p className="text-xs text-muted-foreground">
                    Add HTTP headers. Use the typeahead to discover common headers. Variables can be inserted with the {'{{}'} button.
                  </p>
                </div>

                {/* Payload */}
                {hasPayload && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="payload" style={{ color: "hsl(var(--label-color))" }}>Request body <span className="ml-1 text-[10px] uppercase tracking-wide" style={{ color: "hsl(var(--hint-color))" }}>JSON</span></Label>
                      {availableVars.length > 0 && (
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-6 text-xs">
                              <Plus className="h-3 w-3 mr-1" />
                              Insert Var
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-56 p-2" align="end">
                            <div className="space-y-1">
                              {availableVars.map((v, idx) => (
                                <Button
                                  key={idx}
                                  variant="ghost"
                                  size="sm"
                                  className="w-full justify-start text-xs font-mono h-8"
                                  onClick={() => insertVariable(v.name, payloadRef)}
                                >
                                  {v.name}
                                  <span className="ml-auto text-[10px] text-muted-foreground truncate max-w-[100px]">
                                    {v.nodeName}
                                  </span>
                                </Button>
                              ))}
                            </div>
                          </PopoverContent>
                        </Popover>
                      )}
                    </div>
                    <Textarea
                      ref={payloadRef}
                      id="payload"
                      value={payload}
                      onChange={(e) => {
                        handleFieldChange(setPayload)(e.target.value);
                        // Auto-resize to fit content
                        e.target.style.height = 'auto';
                        e.target.style.height = e.target.scrollHeight + 'px';
                      }}
                      onFocus={(e) => {
                        e.target.style.height = 'auto';
                        e.target.style.height = e.target.scrollHeight + 'px';
                      }}
                      placeholder='{"token": "{{authToken}}", "userId": "{{userId}}"}'
                      className="font-mono text-sm code-input ph-faint min-h-[150px] resize-none overflow-hidden"
                      style={{ height: 'auto' }}
                    />
                    <p className="text-xs text-muted-foreground">
                      Enter valid JSON payload. Use <code className="px-1 py-0.5 bg-muted rounded text-xs">{'{{variableName}}'}</code> for variables.
                    </p>
                  </div>
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          {/* Scripts Tab */}
          <TabsContent value="scripts" className="flex-1 mt-0 overflow-hidden">
            <ScrollArea className="h-full">
              <div className="p-6 space-y-6 max-w-4xl">
                <SectionLead
                  title="Run code around the request?"
                  helper="Optional. Prepare values before the request, or check the response after."
                />
                {/* Before the request */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="pre-script" style={{ color: "hsl(var(--label-color))" }}>Before the request <span className="ml-1 text-[10px] uppercase tracking-wide" style={{ color: "hsl(var(--hint-color))" }}>Rhai</span></Label>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-6 text-xs">
                          <BookOpen className="h-3 w-3 mr-1" />
                          Insert Snippet
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-80 p-0" align="end">
                        <ScrollArea className="h-[400px]">
                          <div className="p-3 space-y-3">
                            <div className="space-y-1">
                              <h4 className="text-sm font-semibold">Code Snippets</h4>
                              <p className="text-xs text-muted-foreground">
                                Quick insert common patterns
                              </p>
                            </div>
                            {Array.from(getSnippetsByCategory(preTestSnippets)).map(([category, snippets]) => (
                              <div key={category} className="space-y-2">
                                <div className="flex items-center gap-2">
                                  <Separator className="flex-1" />
                                  <span className="text-xs font-medium text-muted-foreground">{category}</span>
                                  <Separator className="flex-1" />
                                </div>
                                {snippets.map((snippet, idx) => (
                                  <Button
                                    key={idx}
                                    variant="ghost"
                                    size="sm"
                                    className="w-full justify-start text-xs h-auto py-2 px-2"
                                    onClick={() => insertSnippet(snippet.code, preTestRef)}
                                  >
                                    <div className="text-left w-full">
                                      <div className="font-medium flex items-center gap-1">
                                        <Code2 className="h-3 w-3" />
                                        {snippet.label}
                                      </div>
                                      <div className="text-muted-foreground text-[10px] mt-0.5">
                                        {snippet.description}
                                      </div>
                                    </div>
                                  </Button>
                                ))}
                              </div>
                            ))}
                          </div>
                        </ScrollArea>
                      </PopoverContent>
                    </Popover>
                  </div>
                  <Textarea
                    ref={preTestRef}
                    id="pre-script"
                    value={preTestScript}
                    onChange={(e) => handleFieldChange(setPreTestScript)(e.target.value)}
                    placeholder="// Executed before HTTP request&#10;// Access variables: SAT.vars.userId&#10;// Set variables: SAT.vars.customHeader = 'value';"
                    className="font-mono text-xs min-h-[200px]"
                  />
                  <p className="text-xs text-muted-foreground">
                    Runs before request. Access: <code className="px-1 py-0.5 bg-muted rounded text-xs">SAT.vars.variableName</code>
                  </p>
                </div>

                {/* Post-Test Script */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Label htmlFor="post-script" style={{ color: "hsl(var(--label-color))" }}>Check the response <span className="ml-1 text-[10px] uppercase tracking-wide" style={{ color: "hsl(var(--hint-color))" }}>Rhai</span></Label>
                      <Badge variant="outline" className="text-xs">
                        Returns true/false
                      </Badge>
                    </div>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-6 text-xs">
                          <BookOpen className="h-3 w-3 mr-1" />
                          Insert Snippet
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-80 p-0" align="end">
                        <ScrollArea className="h-[400px]">
                          <div className="p-3 space-y-3">
                            <div className="space-y-1">
                              <h4 className="text-sm font-semibold">Code Snippets</h4>
                              <p className="text-xs text-muted-foreground">
                                Quick insert common patterns
                              </p>
                            </div>
                            {Array.from(getSnippetsByCategory(postTestSnippets)).map(([category, snippets]) => (
                              <div key={category} className="space-y-2">
                                <div className="flex items-center gap-2">
                                  <Separator className="flex-1" />
                                  <span className="text-xs font-medium text-muted-foreground">{category}</span>
                                  <Separator className="flex-1" />
                                </div>
                                {snippets.map((snippet, idx) => (
                                  <Button
                                    key={idx}
                                    variant="ghost"
                                    size="sm"
                                    className="w-full justify-start text-xs h-auto py-2 px-2"
                                    onClick={() => insertSnippet(snippet.code, postTestRef)}
                                  >
                                    <div className="text-left w-full">
                                      <div className="font-medium flex items-center gap-1">
                                        <Code2 className="h-3 w-3" />
                                        {snippet.label}
                                      </div>
                                      <div className="text-muted-foreground text-[10px] mt-0.5">
                                        {snippet.description}
                                      </div>
                                    </div>
                                  </Button>
                                ))}
                              </div>
                            ))}
                          </div>
                        </ScrollArea>
                      </PopoverContent>
                    </Popover>
                  </div>
                  <Textarea
                    ref={postTestRef}
                    id="post-script"
                    value={postTestScript}
                    onChange={(e) => handleFieldChange(setPostTestScript)(e.target.value)}
                    placeholder="// Simple status check&#10;response.status == 200&#10;&#10;// Check JSON field&#10;response.status == 200 && response.json.access_token != ()&#10;&#10;// String contains&#10;response.json.message.contains(&quot;success&quot;)"
                    className="font-mono text-xs min-h-[250px]"
                  />
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-foreground">
                      Script must return true (pass) or false (fail)
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Available: <code className="px-1 py-0.5 bg-muted rounded">response.status</code>, <code className="px-1 py-0.5 bg-muted rounded">response.json</code>, <code className="px-1 py-0.5 bg-muted rounded">response.body</code>, <code className="px-1 py-0.5 bg-muted rounded">response.headers</code>
                    </p>
                  </div>
                </div>
              </div>
            </ScrollArea>
          </TabsContent>

          {/* Response Tab */}
          <TabsContent value="response" className="flex-1 mt-0 overflow-hidden">
            {executeMutation.isPending ? (
              <div className="h-full flex flex-col items-center justify-center p-6 text-center">
                <Loader2 className="w-12 h-12 text-primary animate-spin mb-4" />
                <h3 className="text-lg font-medium text-foreground mb-2">Running Test...</h3>
                <p className="text-muted-foreground">Executing HTTP request and running assertions</p>
              </div>
            ) : executionResult ? (
              <div className="h-full flex flex-col">
                {/* Status Bar */}
                <div className={`px-6 py-3 border-b flex items-center justify-between ${
                  executionResult.status === 'passed'
                    ? 'bg-success/10 border-success/30'
                    : executionResult.status === 'failed'
                    ? 'bg-destructive/10 border-destructive/30'
                    : 'bg-warning/10 border-warning/30'
                }`}>
                  <div className="flex items-center gap-3">
                    {executionResult.status === 'passed' ? (
                      <CheckCircle2 className="w-5 h-5 text-success" />
                    ) : executionResult.status === 'failed' ? (
                      <XCircle className="w-5 h-5 text-destructive" />
                    ) : (
                      <AlertCircle className="w-5 h-5 text-warning" />
                    )}
                    <span className="font-semibold capitalize">{executionResult.status}</span>
                    {executionResult.response && (
                      <Badge variant={executionResult.response.status >= 200 && executionResult.response.status < 300 ? "default" : "destructive"}>
                        {executionResult.response.status}
                      </Badge>
                    )}
                    <span className="text-sm text-muted-foreground">
                      {executionResult.duration_ms}ms
                    </span>
                    {executionResult.error_message && (
                      <span className="text-sm text-destructive">• {executionResult.error_message}</span>
                    )}
                  </div>
                  <Button variant="ghost" size="sm" className="gap-1.5" onClick={handleRunTest} disabled={executeMutation.isPending}>
                    <Play className="w-3.5 h-3.5" />
                    Run Again
                  </Button>
                </div>

                {/* Sub-tabs for Response details */}
                <Tabs defaultValue="body" className="flex-1 flex flex-col overflow-hidden">
                  <div className="border-b px-6">
                    <TabsList className="h-10 bg-transparent p-0 gap-4">
                      <TabsTrigger value="body" className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none px-1 pb-2">
                        Body
                      </TabsTrigger>
                      <TabsTrigger value="headers" className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none px-1 pb-2">
                        Headers
                        {executionResult.response && (
                          <span className="ml-1.5 text-xs text-muted-foreground">
                            ({Object.keys(executionResult.response.headers).length})
                          </span>
                        )}
                      </TabsTrigger>
                      <TabsTrigger value="request" className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none px-1 pb-2">
                        Request
                      </TabsTrigger>
                    </TabsList>
                  </div>

                  {/* Body Sub-tab */}
                  <TabsContent value="body" className="flex-1 mt-0 overflow-hidden flex flex-col">
                    {executionResult.response?.body ? (
                      <>
                        <div className="flex justify-end px-4 py-1.5 border-b bg-muted/20">
                          <Button
                            variant="ghost"
                            size="sm"
                            className={`h-7 gap-1.5 text-xs ${wordWrap ? 'bg-muted' : ''}`}
                            onClick={() => setWordWrap(!wordWrap)}
                          >
                            <WrapText className="w-3.5 h-3.5" />
                            Wrap
                          </Button>
                        </div>
                        <pre className={`flex-1 overflow-auto p-4 text-sm font-mono bg-muted/30 ${wordWrap ? 'whitespace-pre-wrap break-all' : ''}`}>
                          {(() => {
                            try {
                              return JSON.stringify(JSON.parse(executionResult.response.body), null, 2);
                            } catch {
                              return executionResult.response.body;
                            }
                          })()}
                        </pre>
                      </>
                    ) : (
                      <div className="h-full flex items-center justify-center text-muted-foreground">
                        No response body
                      </div>
                    )}
                  </TabsContent>

                  {/* Headers Sub-tab */}
                  <TabsContent value="headers" className="flex-1 mt-0 overflow-hidden">
                    {executionResult.response && Object.keys(executionResult.response.headers).length > 0 ? (
                      <div className="h-full overflow-auto">
                        <table className="w-full text-sm">
                          <tbody>
                            {Object.entries(executionResult.response.headers).map(([k, v]) => (
                              <tr key={k} className="border-b border-border/50 hover:bg-muted/30">
                                <td className="py-2 px-4 font-mono text-muted-foreground whitespace-nowrap">{k}</td>
                                <td className="py-2 px-4 font-mono break-all">{v}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="h-full flex items-center justify-center text-muted-foreground">
                        No headers
                      </div>
                    )}
                  </TabsContent>

                  {/* Request Sub-tab */}
                  <TabsContent value="request" className="flex-1 mt-0 overflow-hidden">
                    <div className="h-full overflow-auto p-4 space-y-4">
                      {executionResult.request && (
                        <>
                          {/* Request line */}
                          <div className="flex items-center gap-2">
                            <Badge className={getMethodColor(executionResult.request.method)}>
                              {executionResult.request.method}
                            </Badge>
                            <code className="text-sm font-mono break-all">{executionResult.request.url}</code>
                          </div>

                          {/* Request Headers */}
                          {Object.keys(executionResult.request.headers).length > 0 && (
                            <div>
                              <h4 className="text-xs font-semibold text-muted-foreground mb-2">REQUEST HEADERS</h4>
                              <table className="w-full text-sm">
                                <tbody>
                                  {Object.entries(executionResult.request.headers).map(([k, v]) => (
                                    <tr key={k} className="border-b border-border/50">
                                      <td className="py-1.5 pr-4 font-mono text-muted-foreground whitespace-nowrap">{k}</td>
                                      <td className="py-1.5 font-mono break-all">{v}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}

                          {/* Request Body */}
                          {executionResult.request.body && (
                            <div>
                              <h4 className="text-xs font-semibold text-muted-foreground mb-2">REQUEST BODY</h4>
                              <pre className="text-sm font-mono bg-muted/50 p-3 rounded overflow-auto max-h-[300px]">
                                {(() => {
                                  try {
                                    return JSON.stringify(JSON.parse(executionResult.request.body), null, 2);
                                  } catch {
                                    return executionResult.request.body;
                                  }
                                })()}
                              </pre>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </TabsContent>
                </Tabs>
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center p-6 text-center">
                <Eye className="w-16 h-16 text-muted-foreground/30 mb-4" />
                <h3 className="text-lg font-medium mb-2" style={{ color: "hsl(var(--lead-color))" }}>What came back</h3>
                <p className="text-muted-foreground max-w-md mb-6">
                  Run the test and the result shows up here — status, headers, and response body.
                </p>
                <Button
                  variant="outline"
                  className="gap-2"
                  onClick={handleRunTest}
                  disabled={isCreateMode || executeMutation.isPending}
                >
                  <Play className="w-4 h-4" />
                  Run Test
                </Button>
                {isCreateMode && (
                  <p className="text-xs text-muted-foreground mt-2">Save the test case first to run it</p>
                )}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* Footer with keyboard hints */}
      <div className="border-t border-border px-6 py-2 bg-muted/30">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <div className="flex items-center gap-4">
            <span>
              <kbd className="px-1.5 py-0.5 bg-muted rounded text-[10px]">Ctrl+S</kbd> Save
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 bg-muted rounded text-[10px]">Esc</kbd> Close
            </span>
          </div>
          <span>
            {isCreateMode ? 'New test case' : `Last modified: ${testCase?.updated_at ? new Date(testCase.updated_at).toLocaleString() : 'Never'}`}
          </span>
        </div>
      </div>
    </div>
  );
};
