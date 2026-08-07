import { describe, it, expect, afterEach } from "vitest";
import { aModalIsOpen, escapeIsOurs } from "@/lib/modalLayer";

function layer(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("noticing a modal layer", () => {
  it("sees nothing when nothing is open", () => {
    expect(aModalIsOpen()).toBe(false);
    expect(escapeIsOurs()).toBe(true);
  });

  it("sees an open dialog, so a document-level Escape stands down", () => {
    // The bug: `TestCaseEditor` closes itself on Escape from a document listener, so dismissing
    // a dialog inside it closed the editor too and left you on the welcome page.
    layer('<div role="dialog" data-state="open">Room to write</div>');
    expect(aModalIsOpen()).toBe(true);
    expect(escapeIsOurs()).toBe(false);
  });

  it("ignores a dialog that has closed", () => {
    // Radix leaves the node in place mid-animation with data-state="closed". Treating that as
    // open would break Escape for good after the first dialog anyone opened.
    layer('<div role="dialog" data-state="closed">gone</div>');
    expect(escapeIsOurs()).toBe(true);
  });

  it("needs both marks, not either", () => {
    // A `role="dialog"` with no state is not Radix's, and a `data-state="open"` alone is any
    // accordion or collapsible on the page — this fires on neither.
    layer('<div role="dialog">no state</div><div data-state="open">an accordion</div>');
    expect(aModalIsOpen()).toBe(false);
  });

  it("finds one nested anywhere, since Radix portals its layers out of the tree", () => {
    layer('<section><div><span role="dialog" data-state="open">deep</span></div></section>');
    expect(aModalIsOpen()).toBe(true);
  });
});
