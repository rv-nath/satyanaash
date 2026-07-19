import { useState, useRef, useEffect, useCallback } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

// Common HTTP headers with descriptions for typeahead
const COMMON_HEADERS = [
  { name: "Accept", description: "Media types acceptable for response", example: "application/json" },
  { name: "Accept-Charset", description: "Character sets acceptable", example: "utf-8" },
  { name: "Accept-Encoding", description: "Acceptable encodings", example: "gzip, deflate" },
  { name: "Accept-Language", description: "Acceptable languages", example: "en-US" },
  { name: "Authorization", description: "Authentication credentials", example: "Bearer {{token}}" },
  { name: "Cache-Control", description: "Caching directives", example: "no-cache" },
  { name: "Content-Type", description: "Media type of request body", example: "application/json" },
  { name: "Content-Length", description: "Size of request body", example: "348" },
  { name: "Cookie", description: "HTTP cookies", example: "session={{sessionId}}" },
  { name: "Host", description: "Server domain name", example: "api.example.com" },
  { name: "If-Match", description: "Conditional request (ETag)", example: '"abc123"' },
  { name: "If-None-Match", description: "Conditional request (ETag)", example: '"abc123"' },
  { name: "If-Modified-Since", description: "Conditional request (date)", example: "Sat, 29 Oct 2024 19:43:31 GMT" },
  { name: "Origin", description: "Origin of request (CORS)", example: "https://example.com" },
  { name: "Referer", description: "Previous page URL", example: "https://example.com/page" },
  { name: "User-Agent", description: "Client software identifier", example: "MyApp/1.0" },
  { name: "X-API-Key", description: "API key for authentication", example: "{{apiKey}}" },
  { name: "X-Request-ID", description: "Unique request identifier", example: "{{requestId}}" },
  { name: "X-Correlation-ID", description: "Correlation ID for tracing", example: "{{correlationId}}" },
  { name: "X-Forwarded-For", description: "Client IP address", example: "192.168.1.1" },
  { name: "X-Forwarded-Host", description: "Original host", example: "example.com" },
  { name: "X-Forwarded-Proto", description: "Original protocol", example: "https" },
  { name: "X-Custom-Header", description: "Custom application header", example: "custom-value" },
];

export interface HeaderRow {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

interface HeadersEditorProps {
  headers: HeaderRow[];
  onChange: (headers: HeaderRow[]) => void;
  availableVars?: Array<{ name: string; nodeName: string }>;
  className?: string;
}

export const HeadersEditor = ({ headers, onChange, availableVars = [], className }: HeadersEditorProps) => {
  const [openPopoverIndex, setOpenPopoverIndex] = useState<number | null>(null);
  const [searchValue, setSearchValue] = useState("");

  const generateId = () => `header-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  const addHeader = useCallback(() => {
    onChange([...headers, { id: generateId(), key: "", value: "", enabled: true }]);
  }, [headers, onChange]);

  const removeHeader = useCallback((id: string) => {
    onChange(headers.filter(h => h.id !== id));
  }, [headers, onChange]);

  const updateHeader = useCallback((id: string, field: keyof HeaderRow, value: string | boolean) => {
    onChange(headers.map(h => h.id === id ? { ...h, [field]: value } : h));
  }, [headers, onChange]);

  const handleSelectHeader = (index: number, headerName: string) => {
    const header = headers[index];
    const suggestion = COMMON_HEADERS.find(h => h.name === headerName);
    updateHeader(header.id, 'key', headerName);
    if (suggestion && !header.value) {
      updateHeader(header.id, 'value', suggestion.example);
    }
    setOpenPopoverIndex(null);
    setSearchValue("");
  };

  const insertVariable = (headerId: string, varName: string, inputRef: HTMLInputElement | null) => {
    if (!inputRef) return;
    const header = headers.find(h => h.id === headerId);
    if (!header) return;

    const start = inputRef.selectionStart || 0;
    const end = inputRef.selectionEnd || 0;
    const newValue = header.value.slice(0, start) + `{{${varName}}}` + header.value.slice(end);
    updateHeader(headerId, 'value', newValue);

    setTimeout(() => {
      inputRef.focus();
      const newCursorPos = start + varName.length + 4;
      inputRef.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  };

  // Filter suggestions based on search
  const getFilteredSuggestions = (search: string) => {
    if (!search) return COMMON_HEADERS;
    const lowerSearch = search.toLowerCase();
    return COMMON_HEADERS.filter(h =>
      h.name.toLowerCase().includes(lowerSearch) ||
      h.description.toLowerCase().includes(lowerSearch)
    );
  };

  // Ensure there's always at least one row
  useEffect(() => {
    if (headers.length === 0) {
      addHeader();
    }
  }, []);

  return (
    <div className={className}>
      {/* Table Header */}
      <div className="grid grid-cols-[auto_1fr_1fr_auto] gap-2 px-2 py-1.5 bg-muted/50 rounded-t-md border border-b-0 border-border text-xs font-medium text-muted-foreground">
        <div className="w-6" />
        <div>Header Name</div>
        <div>Value</div>
        <div className="w-8" />
      </div>

      {/* Table Body */}
      <div className="border border-border rounded-b-md divide-y divide-border">
        {headers.map((header, index) => (
          <HeaderRowComponent
            key={header.id}
            header={header}
            index={index}
            isPopoverOpen={openPopoverIndex === index}
            onPopoverOpenChange={(open) => setOpenPopoverIndex(open ? index : null)}
            searchValue={openPopoverIndex === index ? searchValue : ""}
            onSearchChange={setSearchValue}
            filteredSuggestions={getFilteredSuggestions(openPopoverIndex === index ? searchValue : "")}
            onSelectHeader={handleSelectHeader}
            onUpdate={updateHeader}
            onRemove={removeHeader}
            availableVars={availableVars}
            onInsertVariable={insertVariable}
            showRemove={headers.length > 1}
          />
        ))}
      </div>

      {/* Add Header Button */}
      <Button
        variant="outline"
        size="sm"
        className="mt-2 gap-2 text-xs"
        onClick={addHeader}
      >
        <Plus className="w-3 h-3" />
        Add Header
      </Button>
    </div>
  );
};

interface HeaderRowComponentProps {
  header: HeaderRow;
  index: number;
  isPopoverOpen: boolean;
  onPopoverOpenChange: (open: boolean) => void;
  searchValue: string;
  onSearchChange: (value: string) => void;
  filteredSuggestions: typeof COMMON_HEADERS;
  onSelectHeader: (index: number, headerName: string) => void;
  onUpdate: (id: string, field: keyof HeaderRow, value: string | boolean) => void;
  onRemove: (id: string) => void;
  availableVars: Array<{ name: string; nodeName: string }>;
  onInsertVariable: (headerId: string, varName: string, inputRef: HTMLInputElement | null) => void;
  showRemove: boolean;
}

const HeaderRowComponent = ({
  header,
  index,
  isPopoverOpen,
  onPopoverOpenChange,
  searchValue,
  onSearchChange,
  filteredSuggestions,
  onSelectHeader,
  onUpdate,
  onRemove,
  availableVars,
  onInsertVariable,
  showRemove
}: HeaderRowComponentProps) => {
  const valueInputRef = useRef<HTMLInputElement>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const [showVarPopover, setShowVarPopover] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  // Reset highlighted index when suggestions change
  useEffect(() => {
    setHighlightedIndex(-1);
  }, [searchValue]);

  const visibleSuggestions = filteredSuggestions.slice(0, 8);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isPopoverOpen || visibleSuggestions.length === 0) {
      if (e.key === 'ArrowDown' && filteredSuggestions.length > 0) {
        e.preventDefault();
        onPopoverOpenChange(true);
        setHighlightedIndex(0);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex(prev =>
          prev < visibleSuggestions.length - 1 ? prev + 1 : prev
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex(prev => (prev > 0 ? prev - 1 : -1));
        break;
      case 'Tab':
        if (highlightedIndex >= 0) {
          e.preventDefault();
          onSelectHeader(index, visibleSuggestions[highlightedIndex].name);
          onPopoverOpenChange(false);
          setHighlightedIndex(-1);
          // Move focus to value field
          setTimeout(() => valueInputRef.current?.focus(), 0);
        } else {
          onPopoverOpenChange(false);
        }
        break;
      case 'Enter':
        if (highlightedIndex >= 0) {
          e.preventDefault();
          onSelectHeader(index, visibleSuggestions[highlightedIndex].name);
          onPopoverOpenChange(false);
          setHighlightedIndex(-1);
        } else {
          onPopoverOpenChange(false);
        }
        break;
      case 'Escape':
        e.preventDefault();
        onPopoverOpenChange(false);
        setHighlightedIndex(-1);
        break;
    }
  };

  return (
    <div className={`grid grid-cols-[auto_1fr_1fr_auto] gap-2 px-2 py-1.5 items-center ${!header.enabled ? 'opacity-50' : ''}`}>
      {/* Enable/Disable Checkbox */}
      <div className="flex items-center">
        <Checkbox
          checked={header.enabled}
          onCheckedChange={(checked) => onUpdate(header.id, 'enabled', !!checked)}
          className="h-4 w-4"
        />
      </div>

      {/* Header Name with Typeahead */}
      <div className={`relative ${isPopoverOpen ? 'z-50' : ''}`}>
        <Input
          ref={keyInputRef}
          value={header.key}
          onChange={(e) => {
            onUpdate(header.id, 'key', e.target.value);
            onSearchChange(e.target.value);
            if (!isPopoverOpen) onPopoverOpenChange(true);
            setHighlightedIndex(-1);
          }}
          onFocus={() => {
            onSearchChange(header.key);
            onPopoverOpenChange(true);
          }}
          onBlur={() => {
            // Delay closing to allow clicking on suggestions
            setTimeout(() => {
              onPopoverOpenChange(false);
              setHighlightedIndex(-1);
            }, 150);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Header name"
          className="h-8 text-sm font-mono code-input ph-faint"
          autoComplete="off"
        />
        {isPopoverOpen && visibleSuggestions.length > 0 && (
          <div
            className="absolute top-full left-0 right-0 z-[60] mt-1 border border-border rounded-md shadow-lg max-h-[250px] overflow-y-auto"
            style={{ backgroundColor: "hsl(var(--popover))" }}
          >
            <div className="p-1">
              <p className="px-2 py-1 text-xs text-muted-foreground font-medium">
                Suggestions <span className="text-[10px]">(↑↓ navigate, Tab/Enter select)</span>
              </p>
              {visibleSuggestions.map((suggestion, idx) => (
                <button
                  key={suggestion.name}
                  type="button"
                  className={`w-full text-left px-2 py-1.5 rounded-sm cursor-pointer ${
                    idx === highlightedIndex
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-accent/50'
                  }`}
                  onMouseDown={(e) => {
                    e.preventDefault(); // Prevent blur
                    onSelectHeader(index, suggestion.name);
                    setHighlightedIndex(-1);
                  }}
                  onMouseEnter={() => setHighlightedIndex(idx)}
                >
                  <div className="font-mono text-sm">{suggestion.name}</div>
                  <div className="text-xs text-muted-foreground">{suggestion.description}</div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Value with Variable Support */}
      <div className="relative">
        <Input
          ref={valueInputRef}
          value={header.value}
          onChange={(e) => onUpdate(header.id, 'value', e.target.value)}
          placeholder="Value"
          className="h-8 text-sm font-mono code-input ph-faint pr-8"
        />
        {availableVars.length > 0 && (
          <Popover open={showVarPopover} onOpenChange={setShowVarPopover}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 text-muted-foreground hover:text-foreground"
              >
                <span className="text-xs font-mono">{'{}'}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-2" align="end">
              <p className="text-xs text-muted-foreground mb-2">Insert variable</p>
              <div className="space-y-1 max-h-[200px] overflow-y-auto">
                {availableVars.map((v, idx) => (
                  <Button
                    key={idx}
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start text-xs font-mono h-8"
                    onClick={() => {
                      onInsertVariable(header.id, v.name, valueInputRef.current);
                      setShowVarPopover(false);
                    }}
                  >
                    {v.name}
                    <span className="ml-auto text-[10px] text-muted-foreground truncate max-w-[80px]">
                      {v.nodeName}
                    </span>
                  </Button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>

      {/* Remove Button */}
      <div>
        {showRemove && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground hover:text-destructive"
            onClick={() => onRemove(header.id)}
          >
            <Trash2 className="w-3 h-3" />
          </Button>
        )}
      </div>
    </div>
  );
};

// Utility functions to convert between HeaderRow[] and JSON string
export const headersToJson = (headers: HeaderRow[]): string => {
  const enabledHeaders = headers.filter(h => h.enabled && h.key.trim());
  if (enabledHeaders.length === 0) return "";
  const obj: Record<string, string> = {};
  enabledHeaders.forEach(h => {
    obj[h.key.trim()] = h.value;
  });
  return JSON.stringify(obj, null, 2);
};

export const jsonToHeaders = (json: string): HeaderRow[] => {
  if (!json || !json.trim()) {
    return [{ id: `header-${Date.now()}`, key: "", value: "", enabled: true }];
  }
  try {
    const obj = JSON.parse(json);
    const headers: HeaderRow[] = Object.entries(obj).map(([key, value], idx) => ({
      id: `header-${Date.now()}-${idx}`,
      key,
      value: String(value),
      enabled: true
    }));
    return headers.length > 0 ? headers : [{ id: `header-${Date.now()}`, key: "", value: "", enabled: true }];
  } catch {
    return [{ id: `header-${Date.now()}`, key: "", value: "", enabled: true }];
  }
};
