/**
 * Reading and writing a form body's fields.
 *
 * Mirrors `api/src/execution/body.rs` — the payload column holds a JSON array of fields and
 * `body_type` says to read it that way. Kept pure so the parts with actual behaviour (what
 * makes a part a file, what a repeated name means, what a picked file becomes) are testable
 * without a DOM.
 */
import type { BodyType, FormField } from '@/lib/api/types';

export const BODY_TYPES: { id: BodyType; label: string }[] = [
  { id: 'json', label: 'JSON' },
  { id: 'urlencoded', label: 'Form fields' },
];

/** Is this body authored as key/value fields rather than sent verbatim? */
export function isForm(bodyType: BodyType | null | undefined): boolean {
  return bodyType === 'urlencoded' || bodyType === 'multipart';
}

/**
 * A part carrying a filename **is** a file part.
 *
 * There is no separate mode, because multipart has none — and the distinction matters to
 * the server, which reads the extension off this and nothing else.
 */
export function isFile(field: FormField): boolean {
  return !!field.filename && field.filename.trim() !== '';
}

/** Content type implied by an extension. Mirrors `mime_for` in body.rs. */
export function mimeFor(filename: string): string {
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  switch (ext) {
    case 'csv': return 'text/csv';
    case 'json': return 'application/json';
    case 'xml': return 'application/xml';
    case 'txt': return 'text/plain';
    case 'html':
    case 'htm': return 'text/html';
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'xls': return 'application/vnd.ms-excel';
    default: return 'application/octet-stream';
  }
}

/** What this part will declare: the author's choice, else the extension's. */
export function effectiveMime(field: FormField): string {
  const declared = field.content_type?.trim();
  return declared ? declared : mimeFor(field.filename ?? '');
}

/**
 * Read the field list out of a payload.
 *
 * Returns null when the payload is not a field list at all, so a caller can tell "no
 * fields yet" from "this is a JSON body someone switched the type on" — and warn rather
 * than silently show an empty grid over content it is about to destroy.
 */
export function parseFields(payload: string | null | undefined): FormField[] | null {
  if (!payload || payload.trim() === '') return [];
  try {
    const parsed = JSON.parse(payload);
    if (!Array.isArray(parsed)) return null;
    return parsed.map((f: Record<string, unknown>) => ({
      name: typeof f.name === 'string' ? f.name : '',
      value: typeof f.value === 'string' ? f.value : '',
      ...(f.disabled === true ? { disabled: true } : {}),
      ...(typeof f.filename === 'string' && f.filename ? { filename: f.filename } : {}),
      ...(typeof f.content_type === 'string' && f.content_type
        ? { content_type: f.content_type }
        : {}),
    }));
  } catch {
    return null;
  }
}

/**
 * Serialise fields back to the payload column.
 *
 * Omits everything that is not set, the same rule the Rust side follows: an ordinary field
 * says nothing, so a payload written before file parts existed reads back unchanged and a
 * saved one does not churn on key order.
 */
export function serialiseFields(fields: FormField[]): string {
  return JSON.stringify(
    fields.map((f) => ({
      name: f.name,
      value: f.value,
      ...(f.disabled ? { disabled: true } : {}),
      ...(f.filename?.trim() ? { filename: f.filename } : {}),
      ...(f.content_type?.trim() ? { content_type: f.content_type } : {}),
    })),
  );
}

export const emptyField = (): FormField => ({ name: '', value: '' });

/**
 * Which fields share a name, and their position within that name.
 *
 * Repeated names are how an array of files is encoded — `recipientFiles` twice is two file
 * parts — so nothing may dedupe them. But three rows all reading `recipientFiles` look like
 * a mistake, so the editor numbers them to say it is deliberate.
 *
 * Returns null for a name that appears once: an index on a lone field is noise.
 */
export function repeatIndex(fields: FormField[], at: number): { n: number; of: number } | null {
  const name = fields[at]?.name.trim();
  if (!name) return null;
  const positions = fields
    .map((f, i) => (f.name.trim() === name ? i : -1))
    .filter((i) => i >= 0);
  if (positions.length < 2) return null;
  return { n: positions.indexOf(at) + 1, of: positions.length };
}

/**
 * The fields produced by picking files, one per file.
 *
 * They share the name of the field that was picked into, because that is what an array of
 * files is. Content comes from the browser reading the file — nothing is uploaded and
 * nothing is stored server-side, which the editor says out loud so nobody wonders where the
 * file went.
 */
export function fieldsFromFiles(
  name: string,
  files: { filename: string; content: string }[],
): FormField[] {
  return files.map((f) => ({
    name,
    value: f.content,
    filename: f.filename,
  }));
}

/**
 * Can this file be read as text?
 *
 * The picker reads text, so a spreadsheet or an image would fill the box with rubbish. It
 * refuses and says why rather than appearing to work — the `.xlsx` your API also accepts is
 * exactly this case, and it stays untestable until there is somewhere for binary to live.
 */
const BINARY_EXTENSIONS = ['xlsx', 'xls', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'zip', 'doc', 'docx'];

export function readableAsText(filename: string): boolean {
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  return !BINARY_EXTENSIONS.includes(ext);
}
