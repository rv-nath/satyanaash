import { describe, it, expect } from "vitest";
import {
  effectiveMime,
  fieldsFromFiles,
  isFile,
  isForm,
  mimeFor,
  parseFields,
  readableAsText,
  repeatIndex,
  serialiseFields,
} from "@/lib/formFields";
import type { FormField } from "@/lib/api/types";

const field = (over: Partial<FormField> = {}): FormField => ({ name: "a", value: "1", ...over });

describe("what makes a part a file", () => {
  it("is the filename, and nothing else", () => {
    // There is no separate mode — multipart has none. The server reads the extension off
    // this alone, which is how /api/v1/numbers/upload answers "Only XLSX, XLS or CSV files
    // are allowed".
    expect(isFile(field())).toBe(false);
    expect(isFile(field({ filename: "numbers.csv" }))).toBe(true);
    // A blank filename is not a filename.
    expect(isFile(field({ filename: "   " }))).toBe(false);
  });
});

describe("content type", () => {
  it("comes from the extension", () => {
    expect(mimeFor("numbers.csv")).toBe("text/csv");
    expect(mimeFor("payload.JSON")).toBe("application/json");
    // Unknown, and no extension at all, are both "some bytes".
    expect(mimeFor("thing.bin")).toBe("application/octet-stream");
    expect(mimeFor("README")).toBe("application/octet-stream");
  });

  it("yields to an author who states one", () => {
    expect(effectiveMime(field({ filename: "a.csv", content_type: "text/plain" }))).toBe(
      "text/plain",
    );
    expect(effectiveMime(field({ filename: "a.csv", content_type: "  " }))).toBe("text/csv");
  });
});

describe("parse and serialise", () => {
  it("round-trips, omitting everything unset", () => {
    // Same rule as the Rust side: an ordinary field says nothing, so a payload written
    // before file parts existed reads back unchanged and a saved one does not churn.
    const payload = '[{"name":"a","value":"1"}]';
    expect(serialiseFields(parseFields(payload)!)).toBe(payload);
  });

  it("keeps a file part's metadata", () => {
    const payload =
      '[{"name":"file","value":"msisdn","filename":"numbers.csv","content_type":"text/csv"}]';
    expect(serialiseFields(parseFields(payload)!)).toBe(payload);
  });

  it("reads an empty payload as no fields, not as broken", () => {
    expect(parseFields("")).toEqual([]);
    expect(parseFields(null)).toEqual([]);
  });

  it("returns null for a payload that is not a field list", () => {
    // The caller needs to tell "no fields yet" from "this is a JSON body someone just
    // switched the type on" — so it can warn rather than show an empty grid over content it
    // is about to destroy.
    expect(parseFields('{"token":"abc"}')).toBeNull();
    expect(parseFields("not json")).toBeNull();
    // …and an empty array is a real answer, not a failure.
    expect(parseFields("[]")).toEqual([]);
  });

  it("survives a field list with junk in it", () => {
    // Missing keys become empty strings and a non-string value is discarded, so the editor
    // gets rows it can render and fix rather than undefined in an input.
    //
    // The nameless one is *kept* here even though the server drops it: the author needs to
    // see the row to give it a name. The two sides disagree on purpose.
    const fields = parseFields('[{"name":"a"},{"value":"2"},{"name":"c","value":3}]')!;
    expect(fields).toEqual([
      { name: "a", value: "" },
      { name: "", value: "2" },
      { name: "c", value: "" },
    ]);
  });
});

describe("repeated names", () => {
  const files = [
    field({ name: "recipientFiles", filename: "a.csv" }),
    field({ name: "sender" }),
    field({ name: "recipientFiles", filename: "b.csv" }),
    field({ name: "recipientFiles", filename: "c.csv" }),
  ];

  it("numbers a repeated name so it does not read as a mistake", () => {
    // Repeats are how an array of files is encoded, so nothing dedupes them — but three
    // rows all saying `recipientFiles` look like an accident without this.
    expect(repeatIndex(files, 0)).toEqual({ n: 1, of: 3 });
    expect(repeatIndex(files, 2)).toEqual({ n: 2, of: 3 });
    expect(repeatIndex(files, 3)).toEqual({ n: 3, of: 3 });
  });

  it("says nothing about a name that appears once", () => {
    // An index on a lone field is noise.
    expect(repeatIndex(files, 1)).toBeNull();
  });

  it("says nothing about a blank name", () => {
    expect(repeatIndex([field({ name: "" }), field({ name: "" })], 0)).toBeNull();
  });
});

describe("picking files", () => {
  it("makes one field per file, all sharing the picked name", () => {
    // Selecting three files is one gesture and should not be three trips through the UI.
    // They share a name because that is what an array of files is.
    const fields = fieldsFromFiles("recipientFiles", [
      { filename: "a.csv", content: "msisdn\n1" },
      { filename: "b.csv", content: "msisdn\n2" },
    ]);
    expect(fields).toEqual([
      { name: "recipientFiles", value: "msisdn\n1", filename: "a.csv" },
      { name: "recipientFiles", value: "msisdn\n2", filename: "b.csv" },
    ]);
  });

  it("refuses a file it cannot read as text, rather than appearing to work", () => {
    // The picker reads text. A spreadsheet would fill the box with rubbish — and .xlsx is
    // exactly the case your API also accepts, which stays untestable until binary has
    // somewhere to live.
    expect(readableAsText("numbers.csv")).toBe(true);
    expect(readableAsText("payload.json")).toBe(true);
    expect(readableAsText("numbers.xlsx")).toBe(false);
    expect(readableAsText("scan.PDF")).toBe(false);
    expect(readableAsText("logo.png")).toBe(false);
  });
});

describe("isForm", () => {
  it("treats an absent body type as verbatim, like every existing test case", () => {
    expect(isForm(undefined)).toBe(false);
    expect(isForm(null)).toBe(false);
    expect(isForm("json")).toBe(false);
    expect(isForm("urlencoded")).toBe(true);
    expect(isForm("multipart")).toBe(true);
  });
});
