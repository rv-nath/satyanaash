import { useState, useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { useTestProject } from "@/contexts/TestProjectContext";
import { getUpstreamVariables } from "@/lib/variableUtils";
import { preTestSnippets, postTestSnippets, getSnippetsByCategory } from "@/lib/testSnippets";
import { Plus, Code2, BookOpen } from "lucide-react";
import { HeadersEditor, HeaderRow, headersToJson, jsonToHeaders } from "@/components/HeadersEditor";

interface TestCaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: {
    name: string;
    givenCondition?: string;
    whenAction?: string;
    thenExpected?: string;
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
    endpoint?: string;
    headers?: string;
    payload?: string;
    preTestScript?: string;
    postTestScript?: string;
    groupId: string;
  }) => void;
  groupId: string;
  nodeId?: string; // For editing existing node
  initialData?: {
    name: string;
    givenCondition?: string;
    whenAction?: string;
    thenExpected?: string;
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
    endpoint?: string;
    headers?: string;
    payload?: string;
    preTestScript?: string;
    postTestScript?: string;
  };
  mode: "create" | "edit";
}

export const TestCaseDialog = ({ 
  open, 
  onOpenChange, 
  onSubmit, 
  groupId,
  nodeId,
  initialData,
  mode 
}: TestCaseDialogProps) => {
  const { nodes, edges } = useTestProject();
  const [name, setName] = useState("");
  const [givenCondition, setGivenCondition] = useState("");
  const [whenAction, setWhenAction] = useState("");
  const [thenExpected, setThenExpected] = useState("");
  const [method, setMethod] = useState<"GET" | "POST" | "PUT" | "DELETE" | "PATCH">("GET");
  const [endpoint, setEndpoint] = useState("");
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  const [payload, setPayload] = useState("");
  const [preTestScript, setPreTestScript] = useState("");
  const [postTestScript, setPostTestScript] = useState("");

  const endpointRef = useRef<HTMLInputElement>(null);
  const payloadRef = useRef<HTMLTextAreaElement>(null);
  const preTestRef = useRef<HTMLTextAreaElement>(null);
  const postTestRef = useRef<HTMLTextAreaElement>(null);

  // Get available variables from upstream nodes
  const availableVars = nodeId ? getUpstreamVariables(nodeId, nodes, edges) : [];

  const insertVariable = (varName: string, fieldRef: React.RefObject<HTMLInputElement | HTMLTextAreaElement>) => {
    if (!fieldRef.current) return;

    const input = fieldRef.current;
    const start = input.selectionStart || 0;
    const end = input.selectionEnd || 0;
    const currentValue = fieldRef === endpointRef ? endpoint : payload;
    const newValue = currentValue.slice(0, start) + `{{${varName}}}` + currentValue.slice(end);

    if (fieldRef === endpointRef) {
      setEndpoint(newValue);
    } else {
      setPayload(newValue);
    }

    // Set cursor position after inserted variable
    setTimeout(() => {
      input.focus();
      const newCursorPos = start + varName.length + 4; // {{varName}}
      input.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  };

  const insertSnippet = (code: string, fieldRef: React.RefObject<HTMLTextAreaElement>) => {
    if (!fieldRef.current) return;
    
    const textarea = fieldRef.current;
    const start = textarea.selectionStart || 0;
    const end = textarea.selectionEnd || 0;
    const currentValue = fieldRef === preTestRef ? preTestScript : postTestScript;
    const setValue = fieldRef === preTestRef ? setPreTestScript : setPostTestScript;
    
    // Add snippet with proper spacing
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
    
    // Set cursor position after inserted snippet
    setTimeout(() => {
      textarea.focus();
      const newCursorPos = start + (needsNewlineBefore ? 1 : 0) + code.length;
      textarea.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  };

  useEffect(() => {
    if (initialData) {
      setName(initialData.name);
      setGivenCondition(initialData.givenCondition || "");
      setWhenAction(initialData.whenAction || "");
      setThenExpected(initialData.thenExpected || "");
      setMethod(initialData.method);
      setEndpoint(initialData.endpoint || "");
      setHeaders(jsonToHeaders(initialData.headers || ""));
      setPayload(initialData.payload || "");
      setPreTestScript(initialData.preTestScript || "");
      setPostTestScript(initialData.postTestScript || "");
    } else {
      setName("");
      setGivenCondition("");
      setWhenAction("");
      setThenExpected("");
      setMethod("GET");
      setEndpoint("");
      setHeaders(jsonToHeaders(""));
      setPayload("");
      setPreTestScript("");
      setPostTestScript("");
    }
  }, [initialData, open]);

  const hasPayload = ["POST", "PUT", "PATCH"].includes(method);

  const handleSubmit = () => {
    if (!name.trim()) {
      toast.error("Test case name is required");
      return;
    }

    // Convert headers to JSON string
    const headersJson = headersToJson(headers);

    // Validate JSON payload if provided
    if (hasPayload && payload.trim()) {
      try {
        JSON.parse(payload);
      } catch (e) {
        toast.error("Invalid JSON payload");
        return;
      }
    }

    onSubmit({
      name,
      method,
      endpoint,
      headers: headersJson || undefined,
      payload: hasPayload ? payload : undefined,
      preTestScript,
      postTestScript,
      groupId
    });

    setName("");
    setMethod("GET");
    setEndpoint("");
    setHeaders(jsonToHeaders(""));
    setPayload("");
    setPreTestScript("");
    setPostTestScript("");
    onOpenChange(false);
    toast.success(mode === "create" ? "Test case created" : "Test case updated");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "Create Test Case" : "Edit Test Case"}</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[calc(90vh-120px)]">
          <div className="space-y-4 py-4 px-1">
            {availableVars.length > 0 && (
              <div className="bg-muted/50 border border-border rounded-md p-3">
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

            <div className="space-y-2">
              <Label htmlFor="test-name">Test Name *</Label>
              <Input
                id="test-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Login with valid credentials"
                className="font-mono text-sm"
              />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="method">HTTP Method *</Label>
                <Select value={method} onValueChange={(v) => setMethod(v as any)}>
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
                  <Label htmlFor="endpoint">Endpoint</Label>
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
                  onChange={(e) => setEndpoint(e.target.value)}
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
                onChange={setHeaders}
                availableVars={availableVars}
              />
              <p className="text-xs text-muted-foreground">
                Add HTTP headers. Use the typeahead to discover common headers.
              </p>
            </div>

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
                  onChange={(e) => setPayload(e.target.value)}
                  placeholder='{"token": "{{authToken}}", "userId": "{{userId}}"}'
                  className="font-mono text-sm min-h-[120px]"
                />
                <p className="text-xs text-muted-foreground">
                  Enter valid JSON payload. Use <code className="px-1 py-0.5 bg-muted rounded text-xs">{'{{variableName}}'}</code> for variables.
                </p>
              </div>
            )}

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
                onChange={(e) => setPreTestScript(e.target.value)}
                placeholder="// Executed before HTTP request&#10;// Access variables: SAT.vars.userId&#10;// Set variables: SAT.vars.customHeader = 'value';"
                className="font-mono text-xs min-h-[100px]"
              />
              <p className="text-xs text-muted-foreground">
                Runs before request. Access: <code className="px-1 py-0.5 bg-muted rounded text-xs">SAT.vars.variableName</code>
              </p>
            </div>

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
                onChange={(e) => setPostTestScript(e.target.value)}
                placeholder="// Extract variables from response&#10;SAT.vars.userId = response.data.id;&#10;SAT.vars.authToken = response.data.token;&#10;&#10;// Assert test pass/fail&#10;SAT.assert(response.status === 200, &quot;Status should be 200&quot;);&#10;SAT.assert(response.data.email, &quot;Email should be present&quot;);"
                className="font-mono text-xs min-h-[140px]"
              />
              <div className="space-y-1">
                <p className="text-xs font-medium text-foreground">
                  ⚠️ Use SAT.assert() to determine test pass/fail
                </p>
                <p className="text-xs text-muted-foreground">
                  Runs after the request. Extract variables and add assertions to validate the response.
                </p>
              </div>
            </div>

            <Button onClick={handleSubmit} className="w-full">
              {mode === "create" ? "Create Test Case" : "Save Changes"}
            </Button>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
};
