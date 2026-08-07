import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Copy, HardDrive, Settings2, Trash2, Upload } from "lucide-react";
import { fileStoreApi } from "@/lib/api/fileStore";
import {
  extensionWarning,
  formatSize,
  isReadOnly,
  matchesQuery,
  referenceLabel,
  sortFiles,
  storeLabel,
  type StoredFile,
} from "@/lib/fileStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatWhen } from "@/lib/runHistory";
import { useTestProject } from "@/contexts/TestProjectContext";

/**
 * Files, full width — where the **reference** is a column rather than a tooltip.
 *
 * The rail's list came first and cannot show it: a bucket key or a URL does not fit in 200px
 * beside a filename, so the one thing this whole feature produces was hidden behind a hover
 * while the entire main area sat on the welcome screen. Same split as run history: a compact
 * list in the rail for copying without leaving what you are editing, and a full-width surface
 * for actually working with them.
 *
 * Dropping files onto it works, because that is the gesture a page-sized target invites and the
 * sidebar could never offer.
 */
export const FilesPage = () => {
  const { projectId, openStorageTab } = useTestProject();
  const queryClient = useQueryClient();
  const picker = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [storeId, setStoreId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<StoredFile | null>(null);

  const { data: stores } = useQuery({
    queryKey: ["file-stores", projectId],
    queryFn: () => fileStoreApi.listStores(projectId!),
    enabled: !!projectId,
  });

  // The rail remembers which storage you were last on; sharing the key means the two surfaces
  // agree rather than each having an opinion.
  const remembered = projectId ? localStorage.getItem(`sat.fileStore.${projectId}`) : null;
  const effectiveId =
    [storeId, remembered].find((id) => id && stores?.some((s) => s.id === id)) ?? stores?.[0]?.id ?? null;
  const store = stores?.find((s) => s.id === effectiveId);

  const selectStore = (id: string) => {
    setStoreId(id);
    setQuery("");
    if (projectId) localStorage.setItem(`sat.fileStore.${projectId}`, id);
  };

  const {
    data: files,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["file-store-files", effectiveId],
    queryFn: () => fileStoreApi.listFiles(effectiveId!),
    enabled: !!store,
    retry: false,
  });

  const upload = useMutation({
    mutationFn: (picked: File[]) => fileStoreApi.upload(effectiveId!, picked),
    onSuccess: (stored) => {
      queryClient.invalidateQueries({ queryKey: ["file-store-files", effectiveId] });
      toast.success(
        stored.length === 1
          ? `Uploaded ${stored[0].name}`
          : `Uploaded ${stored.length} files`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeFile = useMutation({
    mutationFn: (file: StoredFile) => fileStoreApi.deleteFile(effectiveId!, file.key),
    onSuccess: (_v, file) => {
      queryClient.invalidateQueries({ queryKey: ["file-store-files", effectiveId] });
      toast.success(`${file.name} deleted from the storage`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied — paste it into a body, or into an environment variable");
    } catch {
      toast.error("Could not reach the clipboard");
    }
  };

  const shown = sortFiles(files ?? []).filter((f) => matchesQuery(f, query));

  if (!stores) {
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  }

  if (stores.length === 0) {
    return (
      <div className="mx-auto max-w-md p-10 text-center">
        <HardDrive className="mx-auto mb-3 h-9 w-9 text-muted-foreground/40" />
        <h2 className="text-base font-semibold">No storage yet</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          Some requests take a whole file rather than a value, and the API goes and reads it. The
          file has to sit somewhere the API can reach.
        </p>
        <Button size="sm" className="mt-4" onClick={() => openStorageTab("__new__")}>
          Set up a storage
        </Button>
      </div>
    );
  }

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => {
        if (!store) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const dropped = Array.from(e.dataTransfer.files ?? []);
        if (dropped.length && store) upload.mutate(dropped);
      }}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-6 py-3">
        <div className="mr-1 shrink-0">
          <h2 className="text-base font-semibold leading-tight">Files</h2>
          {/* Said once, here, instead of shouted in a column header on every row. */}
          <p className="text-[11px] text-muted-foreground">
            Copy a location and paste it into a request
          </p>
        </div>
        <Select value={effectiveId ?? undefined} onValueChange={selectStore}>
          <SelectTrigger className="h-8 w-[180px] shrink-0 text-xs" aria-label="Storage">
            <SelectValue placeholder="Choose a storage" />
          </SelectTrigger>
          <SelectContent>
            {stores.map((s) => (
              <SelectItem key={s.id} value={s.id} className="text-xs">
                {s.name}
                {isReadOnly(s) && (
                  <span className="ml-1.5 text-[10px] text-muted-foreground">(from env)</span>
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* Only where there is room to spare: it repeats what the picker beside it already says,
            so it is the first thing that should go rather than the thing that pushes a button
            onto a second line. */}
        {store && (
          <span className="hidden truncate text-xs text-muted-foreground xl:inline">
            {storeLabel(store)}
          </span>
        )}
        <div className="flex-1" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search files…"
          aria-label="Search files"
          className="h-8 w-[170px] shrink-0 text-xs"
        />
        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0 text-xs"
          onClick={() => store && openStorageTab(store.id)}
          disabled={!store}
        >
          <Settings2 className="mr-1.5 h-3.5 w-3.5" />
          {isReadOnly(store) ? "View settings" : "Edit storage"}
        </Button>
        <Button
          size="sm"
          className="h-8 shrink-0 text-xs"
          onClick={() => picker.current?.click()}
          disabled={!store || upload.isPending}
        >
          <Upload className="mr-1.5 h-3.5 w-3.5" /> Upload files
        </Button>
      </header>

      <input
        ref={picker}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          if (picked.length) upload.mutate(picked);
          e.target.value = "";
        }}
      />

      <div className="min-h-0 flex-1 overflow-auto p-6">
        {error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4">
            <p className="text-sm font-medium text-destructive">{store?.name} did not answer</p>
            <p className="mt-1.5 break-words text-xs leading-relaxed text-muted-foreground">
              {(error as Error).message}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3 h-7 text-xs"
              onClick={() => store && openStorageTab(store.id)}
            >
              Check its settings
            </Button>
          </div>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : shown.length === 0 ? (
          <div
            className={`rounded-lg border-2 border-dashed p-10 text-center ${
              dragging ? "border-primary bg-primary/5" : "border-border"
            }`}
          >
            <Upload className="mx-auto mb-2 h-7 w-7 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              {query.trim()
                ? `Nothing matches “${query.trim()}”.`
                : "Drop files here, or use Upload files."}
            </p>
          </div>
        ) : (
          <div className={`rounded-lg ${dragging ? "bg-primary/5 ring-2 ring-primary" : ""}`}>
            <table className="w-full min-w-[680px] border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <Th className="w-9" />
                  <Th>Name</Th>
                  <Th>Location</Th>
                  <Th className="w-24">Size</Th>
                  <Th className="w-32">Uploaded</Th>
                  <Th className="w-20" />
                </tr>
              </thead>
              <tbody>
                {shown.map((file) => {
                  const warning = extensionWarning(file.name);
                  return (
                    // One type size, one row height, no rules between rows — hover is enough to
                    // follow a line, and borders on every row turned this into a spreadsheet.
                    <tr key={file.key} className="group align-middle text-[13px] hover:bg-muted/40">
                      <td className="pl-3 pr-1 py-2.5">
                        <FileGlyph name={file.name} warning={warning} />
                      </td>
                      <td className="max-w-0 truncate px-2 py-2.5" title={file.name}>
                        {file.name}
                      </td>
                      <td className="max-w-0 px-2 py-2.5">
                        <button
                          type="button"
                          onClick={() => copy(file.reference)}
                          title={`Copy ${file.reference}`}
                          className="flex w-full min-w-0 items-center gap-1.5 rounded text-left text-muted-foreground hover:text-foreground"
                        >
                          {/* Mono here and nowhere else: this is a literal you paste, so a
                              character has to be unambiguous. Same size as its neighbours. */}
                          <span className="truncate font-mono">{file.reference}</span>
                        </button>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2.5 tabular-nums text-muted-foreground">
                        {formatSize(file.size)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2.5 text-muted-foreground">
                        {file.uploaded_at ? formatWhen(file.uploaded_at) : "—"}
                      </td>
                      {/* Out of sight until the row is under the cursor, so the list reads as a
                          list rather than as a column of buttons. */}
                      <td className="whitespace-nowrap py-2.5 pl-2 pr-3 text-right">
                        <span className="opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => copy(file.reference)}
                            title={`Copy ${file.reference}`}
                            aria-label={`Copy the location of ${file.name}`}
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 hover:text-destructive"
                            onClick={() => setPendingDelete(file)}
                            title="Delete from the storage"
                            aria-label={`Delete ${file.name}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {pendingDelete && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setPendingDelete(null)}
          title={`Delete ${pendingDelete.name}?`}
          description={`It is removed from the storage. Any test whose body holds its ${referenceLabel(
            store?.reference,
          )} will start failing — the API will not be able to fetch it.`}
          onConfirm={() => {
            removeFile.mutate(pendingDelete);
            setPendingDelete(null);
          }}
        />
      )}
    </div>
  );
};

const Th = ({ children, className = "" }: { children?: React.ReactNode; className?: string }) => (
  <th className={`px-2 py-2 text-left text-xs font-medium text-muted-foreground ${className}`}>
    {children}
  </th>
);

/**
 * A glyph per row, which is most of what gives a file list its rhythm.
 *
 * The warning rides on it rather than sitting beside the name: an extension this API will reject
 * is a fact about the *kind* of file, and putting it here keeps the name column plain text.
 */
const FileGlyph = ({ name, warning }: { name: string; warning?: string }) => {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const tone =
    warning
      ? "bg-warning/10 text-warning"
      : ["csv", "xls", "xlsx"].includes(ext)
        ? "bg-success/10 text-success"
        : "bg-muted text-muted-foreground";
  return (
    <span
      className={`flex h-6 w-6 items-center justify-center rounded font-mono text-[9px] font-semibold uppercase ${tone}`}
      title={warning ?? `.${ext}`}
      aria-label={warning}
      role={warning ? "img" : undefined}
    >
      {ext.slice(0, 4) || "?"}
    </span>
  );
};

export default FilesPage;
