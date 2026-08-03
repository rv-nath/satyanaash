import { useRef, useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import type { FormField } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  effectiveMime,
  emptyField,
  fieldsFromFiles,
  isFile,
  readableAsText,
  repeatIndex,
} from "@/lib/formFields";

/**
 * The key/value parts of a form body — one row per field, columns side by side.
 *
 * Shaped after Postman's form-data table, deliberately: **Key | Type | Value**, with Type
 * an explicit `Text | File` rather than something inferred. On the wire a part carrying a
 * filename *is* a file part and no separate flag exists — but that is an implementation
 * fact, and an earlier draft that made the author deduce it from a Filename box was
 * unreadable. The control says what it does.
 *
 * One difference from Postman worth knowing, and it is the point of the whole design:
 * Postman stores a *path* and reads the file at send time. This stores the **text**, so a
 * `{{variable}}` inside it resolves and a dataset row can vary the file's contents. The
 * cost is that the file must be readable as text.
 */
interface Props {
  fields: FormField[];
  onChange: (fields: FormField[]) => void;
  /** Only multipart can carry a file — urlencoded has nowhere to put one. */
  allowFiles: boolean;
}

export const FormFieldsEditor = ({ fields, onChange, allowFiles }: Props) => {
  const patch = (index: number, change: Partial<FormField>) =>
    onChange(fields.map((f, i) => (i === index ? { ...f, ...change } : f)));

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-md border border-border">
        <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          <span className="w-4 shrink-0" />
          <span className="w-[200px] shrink-0">Key</span>
          {allowFiles && <span className="w-[84px] shrink-0">Type</span>}
          <span className="flex-1">Value</span>
          <span className="w-6 shrink-0" />
        </div>

        {fields.length === 0 && (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            No fields yet. Add one below.
          </p>
        )}

        <div className="divide-y divide-border/60">
          {fields.map((field, index) => (
            <FieldRow
              key={index}
              field={field}
              repeat={repeatIndex(fields, index)}
              allowFiles={allowFiles}
              onPatch={(change) => patch(index, change)}
              onRemove={() => onChange(fields.filter((_, i) => i !== index))}
              onAddFiles={(picked) => {
                // One field per file, all sharing this field's name — that is what a
                // multipart array of files is. The picked-into row becomes the first.
                const made = fieldsFromFiles(field.name || "file", picked);
                onChange([...fields.slice(0, index), ...made, ...fields.slice(index + 1)]);
              }}
            />
          ))}
        </div>
      </div>

      <Button
        variant="ghost"
        size="sm"
        className="h-7 text-xs"
        onClick={() => onChange([...fields, emptyField()])}
      >
        <Plus className="mr-1 h-3 w-3" /> Add field
      </Button>
    </div>
  );
};

const FieldRow = ({
  field,
  repeat,
  allowFiles,
  onPatch,
  onRemove,
  onAddFiles,
}: {
  field: FormField;
  repeat: { n: number; of: number } | null;
  allowFiles: boolean;
  onPatch: (change: Partial<FormField>) => void;
  onRemove: () => void;
  onAddFiles: (files: { filename: string; content: string }[]) => void;
}) => {
  const picker = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const file = isFile(field);

  const pick = async (chosen: FileList) => {
    const readable = Array.from(chosen).filter((f) => readableAsText(f.name));
    const refused = Array.from(chosen).filter((f) => !readableAsText(f.name));

    if (refused.length > 0) {
      // Said rather than swallowed. Reading a spreadsheet as text fills the box with
      // rubbish, and appearing to work is worse than refusing.
      toast.error(
        `Cannot read ${refused.map((f) => f.name).join(", ")} as text — only text fixtures ` +
          `(CSV, JSON, XML) can be inlined.`,
      );
    }
    if (readable.length === 0) return;

    const picked = await Promise.all(
      readable.map(
        (f) =>
          new Promise<{ filename: string; content: string }>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve({ filename: f.name, content: String(reader.result) });
            reader.onerror = () => reject(reader.error);
            reader.readAsText(f);
          }),
      ),
    ).catch(() => []);

    if (picked.length === 0) return;
    onAddFiles(picked);
    setOpen(true);
  };

  return (
    <div className={field.disabled ? "opacity-50" : undefined}>
      <div className="flex items-center gap-2 px-2 py-1">
        <Checkbox
          className="shrink-0"
          checked={!field.disabled}
          onCheckedChange={(on) => onPatch({ disabled: on !== true })}
          aria-label={`Send ${field.name || "this field"}`}
        />

        <div className="flex w-[200px] shrink-0 items-center gap-1">
          <Input
            value={field.name}
            onChange={(e) => onPatch({ name: e.target.value })}
            placeholder="Key"
            className="h-7 border-0 bg-transparent px-1 font-mono text-xs shadow-none focus-visible:ring-1"
            aria-label="Key"
          />
          {/* Repeats are how an array of files is encoded, so they are deliberate — but
              three rows all reading `recipientFiles` look like a mistake without this. */}
          {repeat && (
            <span
              className="shrink-0 rounded bg-muted px-1 text-[10px] tabular-nums text-muted-foreground"
              title={`${repeat.n} of ${repeat.of} fields sharing this key — sent as a list`}
            >
              {repeat.n}/{repeat.of}
            </span>
          )}
        </div>

        {allowFiles && (
          <div className="w-[84px] shrink-0">
            <Select
              value={file ? "file" : "text"}
              onValueChange={(next) => {
                if (next === "file") {
                  // Straight to the picker: there is no useful "File but no file" state, and
                  // making the author choose a type and then hunt for a button is a step
                  // nobody needs.
                  picker.current?.click();
                } else {
                  onPatch({ filename: undefined, content_type: undefined });
                }
              }}
            >
              <SelectTrigger className="h-7 border-0 bg-transparent px-1 text-xs shadow-none focus:ring-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="text" className="text-xs">Text</SelectItem>
                <SelectItem value="file" className="text-xs">File</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="flex min-w-0 flex-1 items-center gap-1">
          <input
            ref={picker}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) void pick(e.target.files);
              // Cleared so picking the same file twice fires again.
              e.target.value = "";
            }}
          />

          {file ? (
            // The filename is the value at a glance, the way Postman shows it. The contents
            // are one click away rather than filling the row, because a CSV in a table cell
            // is unreadable.
            <button
              type="button"
              onClick={() => setOpen(!open)}
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left text-xs hover:bg-muted/30"
            >
              {open ? (
                <ChevronDown className="h-3 w-3 shrink-0" />
              ) : (
                <ChevronRight className="h-3 w-3 shrink-0" />
              )}
              <span className="truncate font-mono">{field.filename}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {effectiveMime(field)} · {sizeOf(field.value)}
              </span>
            </button>
          ) : (
            <Input
              value={field.value}
              onChange={(e) => onPatch({ value: e.target.value })}
              placeholder="Value"
              className="h-7 border-0 bg-transparent px-1 font-mono text-xs shadow-none focus-visible:ring-1"
              aria-label={`Value for ${field.name || "field"}`}
            />
          )}

          {file && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-1.5 text-[10px] text-muted-foreground"
              onClick={() => picker.current?.click()}
            >
              Replace
            </Button>
          )}
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          aria-label={`Remove ${field.name || "field"}`}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>

      {file && open && (
        <div className="space-y-1 border-t border-border/40 bg-muted/20 px-2 py-2">
          <div className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-[10px] text-muted-foreground">Filename</span>
            <Input
              value={field.filename ?? ""}
              onChange={(e) => onPatch({ filename: e.target.value })}
              className="h-6 max-w-[240px] font-mono text-xs"
              aria-label="Filename"
            />
            {/* The extension is not cosmetic: the server reads it to decide whether the
                upload is allowed at all. */}
            <span className="text-[10px] text-muted-foreground">
              sent as {effectiveMime(field)}
            </span>
          </div>
          <Textarea
            value={field.value}
            onChange={(e) => onPatch({ value: e.target.value })}
            placeholder="file contents — {{variables}} work here"
            rows={6}
            className="code-input ph-faint resize-y font-mono text-xs"
            aria-label={`Contents of ${field.filename}`}
          />
          <p className="text-[10px] text-muted-foreground">
            The text is saved with this test — nothing was uploaded. Edit it, or swap a value
            for <code className="rounded bg-muted px-1">{'{{variable}}'}</code> so a dataset
            row can vary it.
          </p>
        </div>
      )}
    </div>
  );
};

/** Rough size of the inlined content, so a collapsed row says how much is behind it. */
function sizeOf(value: string): string {
  const bytes = new TextEncoder().encode(value).length;
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export default FormFieldsEditor;
