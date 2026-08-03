import { useRef, useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2, Upload, FileText } from "lucide-react";
import type { FormField } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  effectiveMime,
  emptyField,
  fieldsFromFiles,
  isFile,
  readableAsText,
  repeatIndex,
} from "@/lib/formFields";

/**
 * The key/value parts of a form body.
 *
 * Shaped like the Headers grid above it, because it is the same idea and an author should
 * not have to learn a second one.
 *
 * **A field carrying a filename is a file part.** There is no separate mode or toggle —
 * multipart has none — and the filename is what the server reads the extension from, which
 * is how `/api/v1/numbers/upload` answers "Only XLSX, XLS or CSV files are allowed".
 *
 * **Choose file** reads the file in the browser and fills in the name and content. Nothing
 * is uploaded and nothing is stored server-side: the text is saved with the test case like
 * any other field, which the hint says out loud so nobody wonders where the file went.
 */
interface Props {
  fields: FormField[];
  onChange: (fields: FormField[]) => void;
  /** Multipart alone can carry files — urlencoded has nowhere to put one. */
  allowFiles: boolean;
}

export const FormFieldsEditor = ({ fields, onChange, allowFiles }: Props) => {
  const patch = (index: number, change: Partial<FormField>) =>
    onChange(fields.map((f, i) => (i === index ? { ...f, ...change } : f)));

  return (
    <div className="space-y-2">
      <div className="divide-y divide-border rounded-md border border-border">
        {fields.length === 0 && (
          <p className="px-3 py-4 text-xs text-muted-foreground">
            No fields yet. Add one, or pick a file to send.
          </p>
        )}
        {fields.map((field, index) => (
          <FieldRow
            key={index}
            field={field}
            repeat={repeatIndex(fields, index)}
            allowFiles={allowFiles}
            onPatch={(change) => patch(index, change)}
            onRemove={() => onChange(fields.filter((_, i) => i !== index))}
            onAddFiles={(picked) => {
              // One field per file, all sharing this field's name — that is what an array
              // of files is. The picked-into field is replaced by the first.
              const made = fieldsFromFiles(field.name || "file", picked);
              onChange([...fields.slice(0, index), ...made, ...fields.slice(index + 1)]);
            }}
          />
        ))}
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
  const [readFrom, setReadFrom] = useState<string | null>(null);
  const file = isFile(field);

  const pick = async (chosen: FileList) => {
    const readable = Array.from(chosen).filter((f) => readableAsText(f.name));
    const refused = Array.from(chosen).filter((f) => !readableAsText(f.name));

    if (refused.length > 0) {
      // Said rather than silently swallowed: reading a spreadsheet as text fills the box
      // with rubbish, and appearing to work is worse than refusing.
      toast.error(
        `Cannot read ${refused.map((f) => f.name).join(", ")} as text. ` +
          `Only text fixtures — CSV, JSON, XML — can be inlined.`,
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
    setReadFrom(picked.map((p) => p.filename).join(", "));
    onAddFiles(picked);
  };

  return (
    <div className={`space-y-1.5 p-2 ${field.disabled ? "opacity-50" : ""}`}>
      <div className="flex items-center gap-2">
        <Checkbox
          checked={!field.disabled}
          onCheckedChange={(on) => onPatch({ disabled: on !== true })}
          aria-label={`Send ${field.name || "this field"}`}
        />
        <Input
          value={field.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          placeholder="Field name"
          className="h-7 max-w-[220px] font-mono text-xs"
          aria-label="Field name"
        />
        {/* Repeats are how an array of files is encoded, so they are deliberate — but three
            rows all reading `recipientFiles` look like a mistake without this. */}
        {repeat && (
          <span
            className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
            title={`Field ${repeat.n} of ${repeat.of} sharing this name — sent as a list`}
          >
            {repeat.n}/{repeat.of}
          </span>
        )}
        <div className="flex-1" />
        {allowFiles && (
          <>
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
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-1.5 text-[10px]"
              onClick={() => picker.current?.click()}
              title="Read a local file into this field. Nothing is uploaded."
            >
              <Upload className="mr-1 h-3 w-3" /> Choose file…
            </Button>
          </>
        )}
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

      {allowFiles && (
        <div className="flex items-center gap-2 pl-6">
          <span className="w-16 shrink-0 text-[10px] text-muted-foreground">Filename</span>
          <Input
            value={field.filename ?? ""}
            onChange={(e) => onPatch({ filename: e.target.value })}
            placeholder="leave blank to send as a plain value"
            className="h-6 max-w-[240px] font-mono text-xs"
            aria-label="Filename"
          />
          {file && (
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <FileText className="h-3 w-3" />
              {effectiveMime(field)}
            </span>
          )}
        </div>
      )}

      <div className="pl-6">
        <Textarea
          value={field.value}
          onChange={(e) => onPatch({ value: e.target.value })}
          placeholder={file ? "file contents — {{variables}} work here" : "value"}
          rows={file ? 4 : 1}
          className="code-input ph-faint resize-y font-mono text-xs"
          aria-label={`Value for ${field.name || "field"}`}
        />
        {readFrom && (
          <p className="pt-1 text-[10px] text-muted-foreground">
            ✓ read from {readFrom} · nothing uploaded, the text is saved with this test
          </p>
        )}
      </div>
    </div>
  );
};

export default FormFieldsEditor;
