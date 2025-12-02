import { useState, useEffect, useRef, useCallback } from "react";
import { ArrowLeft, Save, Play, X, FileCode, Code2, BookOpen, Plus, Eye, ClipboardList } from "lucide-react";
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
import { useTestCase, useCreateTestCase, useUpdateTestCase } from "@/hooks/useApi";
import { getUpstreamVariables } from "@/lib/variableUtils";
import { preTestSnippets, postTestSnippets, getSnippetsByCategory } from "@/lib/testSnippets";
import { HeadersEditor, HeaderRow, headersToJson, jsonToHeaders } from "@/components/HeadersEditor";

interface TestCaseEditorProps {
  testCaseId?: string; // Optional - undefined means create mode
  onClose: () => void;
  onCreated?: (newTestCaseId: string) => void; // Callback when a new test case is created
}

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export const TestCaseEditor = ({ testCaseId, onClose, onCreated }: TestCaseEditorProps) => {
  const { projectId, nodes, edges, closeTestCaseEditor } = useTestProject();

  const isCreateMode = !testCaseId;

  // Fetch test case data (only in edit mode)
  const { data: testCase, isLoading } = useTestCase(testCaseId || '');
  const createMutation = useCreateTestCase();
  const updateMutation = useUpdateTestCase();

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
      setPreTestScript(testCase.pre_request_script || "");
      setPostTestScript(testCase.assertion_script || "");
      setIsDirty(false);
    }
  }, [testCase, isCreateMode]);

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
            <h2 className="text-lg font-semibold font-mono">{name || "Untitled"}</h2>
            {isDirty && (
              <Badge variant="outline" className="text-warning border-warning">
                {isCreateMode ? "Not saved" : "Unsaved"}
              </Badge>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isCreateMode && (
            <Button variant="outline" size="sm" className="gap-2">
              <Play className="w-4 h-4" />
              Run Test
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
              <div className="p-6 space-y-6 max-w-4xl">
                {/* Test Name */}
                <div className="space-y-2">
                  <Label htmlFor="test-name">Test Name *</Label>
                  <Input
                    id="test-name"
                    value={name}
                    onChange={(e) => handleFieldChange(setName)(e.target.value)}
                    placeholder="e.g., Login with valid credentials"
                    className="font-mono text-sm"
                  />
                </div>

                {/* BDD Section */}
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold">Scenario Description</h3>
                    <Badge variant="outline" className="text-xs">BDD</Badge>
                  </div>

                  {/* Given */}
                  <div className="space-y-2">
                    <Label htmlFor="given" className="flex items-center gap-2">
                      <span className="px-2 py-0.5 bg-blue-500/20 text-blue-600 dark:text-blue-400 rounded text-xs font-semibold">GIVEN</span>
                      <span className="text-muted-foreground text-xs">Preconditions / Context</span>
                    </Label>
                    <Textarea
                      id="given"
                      value={givenCondition}
                      onChange={(e) => handleFieldChange(setGivenCondition)(e.target.value)}
                      placeholder="e.g., A registered user with valid credentials"
                      className="text-sm min-h-[80px]"
                    />
                  </div>

                  {/* When */}
                  <div className="space-y-2">
                    <Label htmlFor="when" className="flex items-center gap-2">
                      <span className="px-2 py-0.5 bg-amber-500/20 text-amber-600 dark:text-amber-400 rounded text-xs font-semibold">WHEN</span>
                      <span className="text-muted-foreground text-xs">Action being tested</span>
                    </Label>
                    <Textarea
                      id="when"
                      value={whenAction}
                      onChange={(e) => handleFieldChange(setWhenAction)(e.target.value)}
                      placeholder="e.g., The user submits the login form with email and password"
                      className="text-sm min-h-[80px]"
                    />
                  </div>

                  {/* Then */}
                  <div className="space-y-2">
                    <Label htmlFor="then" className="flex items-center gap-2">
                      <span className="px-2 py-0.5 bg-green-500/20 text-green-600 dark:text-green-400 rounded text-xs font-semibold">THEN</span>
                      <span className="text-muted-foreground text-xs">Expected outcome</span>
                    </Label>
                    <Textarea
                      id="then"
                      value={thenExpected}
                      onChange={(e) => handleFieldChange(setThenExpected)(e.target.value)}
                      placeholder="e.g., The API returns a 200 status with an auth token"
                      className="text-sm min-h-[80px]"
                    />
                  </div>
                </div>

                {/* Quick summary preview */}
                {(givenCondition || whenAction || thenExpected) && (
                  <div className="bg-muted/30 border border-border rounded-lg p-4">
                    <p className="text-xs font-medium text-muted-foreground mb-2">Preview</p>
                    <div className="text-sm space-y-1">
                      {givenCondition && <p><span className="font-medium text-blue-600 dark:text-blue-400">Given</span> {givenCondition}</p>}
                      {whenAction && <p><span className="font-medium text-amber-600 dark:text-amber-400">When</span> {whenAction}</p>}
                      {thenExpected && <p><span className="font-medium text-green-600 dark:text-green-400">Then</span> {thenExpected}</p>}
                    </div>
                  </div>
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          {/* Request Tab */}
          <TabsContent value="request" className="flex-1 mt-0 overflow-hidden">
            <ScrollArea className="h-full">
              <div className="p-6 space-y-6 max-w-4xl">
                {/* Available Variables */}
                {availableVars.length > 0 && (
                  <div className="bg-muted/50 border border-border rounded-md p-4">
                    <Label className="text-xs font-semibold mb-2 block">Available Variables</Label>
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
                    <Label htmlFor="method">HTTP Method *</Label>
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
                      <Label htmlFor="endpoint">Endpoint *</Label>
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
                      className="font-mono text-sm"
                    />
                  </div>
                </div>

                {/* Headers */}
                <div className="space-y-2">
                  <Label>Headers</Label>
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
                      <Label htmlFor="payload">Payload (JSON)</Label>
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
                      onChange={(e) => handleFieldChange(setPayload)(e.target.value)}
                      placeholder='{"token": "{{authToken}}", "userId": "{{userId}}"}'
                      className="font-mono text-sm min-h-[150px]"
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
                {/* Pre-Test Script */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="pre-script">Pre-Test Script (JavaScript)</Label>
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
                      <Label htmlFor="post-script">Post-Test Script (JavaScript)</Label>
                      <Badge variant="outline" className="text-xs">
                        Assertions Here
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
                    placeholder="// Extract variables from response&#10;SAT.vars.userId = response.data.id;&#10;SAT.vars.authToken = response.data.token;&#10;&#10;// Assert test pass/fail&#10;SAT.assert(response.status === 200, &quot;Status should be 200&quot;);&#10;SAT.assert(response.data.email, &quot;Email should be present&quot;);"
                    className="font-mono text-xs min-h-[250px]"
                  />
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-foreground">
                      Use SAT.assert() to determine test pass/fail
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Runs after the request. Extract variables and add assertions to validate the response.
                    </p>
                  </div>
                </div>
              </div>
            </ScrollArea>
          </TabsContent>

          {/* Response Tab */}
          <TabsContent value="response" className="flex-1 mt-0 overflow-hidden">
            <div className="h-full flex flex-col items-center justify-center p-6 text-center">
              <Eye className="w-16 h-16 text-muted-foreground/30 mb-4" />
              <h3 className="text-lg font-medium text-foreground mb-2">Response Preview</h3>
              <p className="text-muted-foreground max-w-md mb-6">
                Run the test to see the response here. You can inspect status codes, headers, and response body.
              </p>
              <Button variant="outline" className="gap-2">
                <Play className="w-4 h-4" />
                Run Test
              </Button>
            </div>
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
