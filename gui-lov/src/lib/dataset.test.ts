import { describe, it, expect } from "vitest";
import {
  addRow,
  duplicateRow,
  emptyDataset,
  isEmptyDataset,
  joinEndpoint,
  looksLikeInvalidJson,
  pathVariables,
  rowVar,
  runnableInFlow,
  runnableLabel,
  setRowDisabled,
  setRowVar,
  oneLine,
  runnableAlone,
  setRowNeedsFlow,
  removeRow,
  rowLabel,
  setRowBody,
  setRowCheck,
  isStatusShorthand,
  setRowName,
} from "@/lib/dataset";
import type { Dataset } from "@/lib/api/types";

function seed(): Dataset {
  let d = addRow(addRow(emptyDataset()));
  d = setRowName(d, d.rows[0].id, "valid");
  d = setRowBody(d, d.rows[0].id, '{"email":"a@b.com"}');
  d = setRowCheck(d, d.rows[0].id, "201");
  return d;
}

describe("dataset reducers", () => {
  it("starts empty", () => {
    expect(isEmptyDataset(emptyDataset())).toBe(true);
    expect(isEmptyDataset(seed())).toBe(false);
  });

  it("adds blank cases", () => {
    const d = addRow(emptyDataset());
    expect(d.rows).toHaveLength(1);
    expect(d.rows[0].body).toBe("");
    expect(d.rows[0].check).toBe("");
    expect(d.rows[0].id).toBeTruthy();
  });

  it("edits a case without touching the others", () => {
    const d = seed();
    const id = d.rows[0].id;
    let next = setRowName(d, id, "renamed");
    next = setRowBody(next, id, "{}");
    next = setRowCheck(next, id, "400");

    expect(next.rows[0]).toMatchObject({ name: "renamed", body: "{}", check: "400" });
    expect(next.rows[1]).toEqual(d.rows[1]);
  });

  it("removes a case by id", () => {
    const d = seed();
    const gone = d.rows[0].id;
    expect(removeRow(d, gone).rows.find((r) => r.id === gone)).toBeUndefined();
  });

  it("duplicates a case right after the original, with a fresh id", () => {
    const d = seed();
    const next = duplicateRow(d, d.rows[0].id);

    expect(next.rows).toHaveLength(3);
    expect(next.rows[1].name).toBe("valid");
    expect(next.rows[1].body).toBe('{"email":"a@b.com"}');
    expect(next.rows[1].id).not.toBe(d.rows[0].id);
  });

  it("flags a body that looks like broken JSON, but allows non-JSON", () => {
    // A hint, never a block — a malformed body is a legitimate test input.
    expect(looksLikeInvalidJson('{"a":1}')).toBe(false);
    expect(looksLikeInvalidJson('{"a":1')).toBe(true);
    expect(looksLikeInvalidJson("[1,2")).toBe(true);
    expect(looksLikeInvalidJson("")).toBe(false);
    expect(looksLikeInvalidJson("name=value")).toBe(false); // form data
  });

  it("tells a status shorthand from an expression", () => {
    // Mirrors the server: a check that is nothing but digits is a status check.
    expect(isStatusShorthand("400")).toBe(true);
    expect(isStatusShorthand(" 201 ")).toBe(true);
    expect(isStatusShorthand("response.status == 201")).toBe(false);
    expect(isStatusShorthand("2xx")).toBe(false);
    expect(isStatusShorthand("")).toBe(false);
  });

  it("previews a cell on one line", () => {
    // Minified, so a pretty-printed body isn't previewed as a lone brace.
    expect(oneLine('{\n  "email": "a@b.com"\n}')).toBe('{"email":"a@b.com"}');
    // Interpolation inside a string is still valid JSON.
    expect(oneLine('{\n "s": "{{api_secret}}"\n}')).toBe('{"s":"{{api_secret}}"}');
    // Not JSON, or broken JSON: keep the text, lose the line breaks.
    expect(oneLine('{"a":1')).toBe('{"a":1');
    expect(oneLine("response.status == 201\n  && response.json.id != ()")).toBe(
      "response.status == 201 && response.json.id != ()",
    );
    expect(oneLine("   ")).toBe("");
  });

  it("joins a row's suffix onto the endpoint the way the server does", () => {
    // A path segment is simply appended.
    expect(joinEndpoint("http://x/campaigns", "/acme")).toBe("http://x/campaigns/acme");
    expect(joinEndpoint("http://x/campaigns", "?org=acme")).toBe("http://x/campaigns?org=acme");

    // "?limit=10?org=acme" is one broken parameter, not two.
    expect(joinEndpoint("http://x/c?limit=10", "?org=acme")).toBe("http://x/c?limit=10&org=acme");

    // Blank leaves the endpoint alone.
    expect(joinEndpoint("http://x/c", "   ")).toBe("http://x/c");
    expect(joinEndpoint("http://x/c", "")).toBe("http://x/c");
  });

  it("counts only the rows Run dataset will send", () => {
    let d = seed();
    // Nothing marked: every row runs, which is how every existing dataset behaves.
    expect(runnableAlone(d)).toHaveLength(d.rows.length);

    d = setRowNeedsFlow(d, d.rows[0].id, true);
    expect(runnableAlone(d).map((r) => r.id)).toEqual(d.rows.slice(1).map((r) => r.id));

    // And it's a toggle, not a one-way door.
    d = setRowNeedsFlow(d, d.rows[0].id, false);
    expect(runnableAlone(d)).toHaveLength(d.rows.length);
  });

  it("labels rows like the server does", () => {
    const d = seed();
    expect(rowLabel(0, d.rows[0])).toBe("valid");
    expect(rowLabel(1, { ...d.rows[1], name: "  " })).toBe("Row 2");
    expect(rowLabel(2, { ...d.rows[1], name: null })).toBe("Row 3");
  });
});

describe("pathVariables", () => {
  it("finds the parameters a row can fill in", () => {
    expect(
      pathVariables("{{baseUrl}}/api/v1/campaigns/{{channel}}/pause/{{campaignID}}/{{recurrenceID}}"),
    ).toEqual(["channel", "campaignID", "recurrenceID"]);
  });

  it("leaves out the leading placeholder, which is the base URL", () => {
    // Nearly every endpoint starts {{baseUrl}}/… — a column for it in every dataset
    // would be noise, and it is not a parameter of the request.
    expect(pathVariables("{{baseUrl}}/signup")).toEqual([]);
    // Anywhere else it is a parameter like any other.
    expect(pathVariables("/api/{{version}}/signup")).toEqual(["version"]);
  });

  it("leaves out built-ins, which are generated per use", () => {
    expect(pathVariables("{{baseUrl}}/users/{{$UUID}}/{{orgId}}")).toEqual(["orgId"]);
  });

  it("collapses a name used twice into one column", () => {
    expect(pathVariables("{{baseUrl}}/orgs/{{id}}/children/{{id}}")).toEqual(["id"]);
  });

  it("has nothing to say about an endpoint without parameters", () => {
    expect(pathVariables("")).toEqual([]);
    expect(pathVariables(undefined)).toEqual([]);
    expect(pathVariables("https://api.example.com/signup")).toEqual([]);
    // Single braces are not interpolation — the server sends them literally.
    expect(pathVariables("{{baseUrl}}/campaigns/{channel}/pause")).toEqual([]);
  });
});

describe("setRowVar", () => {
  const seeded = () => {
    const d = addRow(emptyDataset());
    return { d, id: d.rows[0].id };
  };

  it("sets and reads a value", () => {
    const { d, id } = seeded();
    const next = setRowVar(d, id, "channel", "sms");
    expect(next.rows[0].vars).toEqual({ channel: "sms" });
    expect(rowVar(next.rows[0], "channel")).toBe("sms");
    expect(rowVar(next.rows[0], "campaignID")).toBe("");
  });

  it("clears the name when blanked, rather than sending an empty segment", () => {
    const { d, id } = seeded();
    let next = setRowVar(d, id, "channel", "sms");
    next = setRowVar(next, id, "channel", "  ");
    expect(next.rows[0].vars).toEqual({});
  });

  it("leaves other rows and other names alone", () => {
    let d = addRow(addRow(emptyDataset()));
    d = setRowVar(d, d.rows[0].id, "channel", "sms");
    d = setRowVar(d, d.rows[0].id, "campaignID", "c-1");
    d = setRowVar(d, d.rows[1].id, "channel", "email");
    expect(d.rows[0].vars).toEqual({ channel: "sms", campaignID: "c-1" });
    expect(d.rows[1].vars).toEqual({ channel: "email" });
  });
});

describe("parking a row", () => {
  const seeded = () => {
    let d = addRow(addRow(emptyDataset()));
    d = setRowName(d, d.rows[0].id, "finished");
    d = setRowName(d, d.rows[1].id, "still drafting");
    return d;
  };

  it("sets and clears the flag", () => {
    const d = seeded();
    const parked = setRowDisabled(d, d.rows[1].id, true);
    expect(parked.rows[1].disabled).toBe(true);
    expect(parked.rows[0].disabled).toBeUndefined();
    expect(setRowDisabled(parked, d.rows[1].id, false).rows[1].disabled).toBe(false);
  });

  it("drops a parked row from what Run dataset would send", () => {
    // This is the count behind the "Run dataset (N)" button: parking a row has to lower
    // it, or the button promises cases it won't run.
    let d = seeded();
    expect(runnableAlone(d)).toHaveLength(2);

    d = setRowDisabled(d, d.rows[1].id, true);
    expect(runnableAlone(d).map((r) => r.name)).toEqual(["finished"]);
  });

  it("is not revived by a flow, unlike needs_flow", () => {
    // The distinction the whole flag rests on: a flow satisfies needs_flow, because the
    // flow is the precondition; nothing satisfies "not finished".
    let d = seeded();
    d = setRowNeedsFlow(d, d.rows[0].id, true);
    d = setRowDisabled(d, d.rows[1].id, true);

    expect(runnableAlone(d)).toHaveLength(0);
    expect(runnableInFlow(d).map((r) => r.name)).toEqual(["finished"]);
  });
});

describe("runnableLabel", () => {
  const withRows = (n: number) => {
    let d = emptyDataset();
    for (let i = 0; i < n; i++) d = addRow(d);
    return d;
  };

  it("shows a bare total when every row will run", () => {
    // "17/17" is noise — the same reason a running row carries no marker.
    expect(runnableLabel(withRows(17))).toBe("17");
  });

  it("shows the fraction when some rows won't run here", () => {
    // The reported case: 17 rows, 15 of them needing a login, so the button that said
    // "(17)" sent two requests.
    let d = withRows(17);
    for (const row of d.rows.slice(2)) d = setRowNeedsFlow(d, row.id, true);
    expect(runnableLabel(d)).toBe("2/17");
  });

  it("counts parked rows out too", () => {
    let d = withRows(3);
    d = setRowDisabled(d, d.rows[0].id, true);
    expect(runnableLabel(d)).toBe("2/3");
  });

  it("says zero rather than pretending", () => {
    let d = withRows(2);
    for (const row of d.rows) d = setRowDisabled(d, row.id, true);
    expect(runnableLabel(d)).toBe("0/2");
  });
});
