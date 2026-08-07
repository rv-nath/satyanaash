/**
 * Is something modal on screen right now?
 *
 * For document-level keyboard shortcuts. `TestCaseEditor` closes itself on Escape from a
 * `document` listener, so an Escape aimed at a dialog *inside* the editor reached it too: you
 * dismissed a field editor and landed on the welcome page. React's synthetic events cannot help
 * — the listener is on `document`, below everything.
 *
 * A DOM query rather than a React context, because the layers this has to notice are Radix's and
 * they are portalled out of the tree that would provide one. Radix marks every open dialog,
 * sheet, alert and popover-as-modal with exactly this attribute pair, so one query covers the
 * ones that exist and the ones added later.
 */
export function aModalIsOpen(root: ParentNode = document): boolean {
  return root.querySelector('[role="dialog"][data-state="open"]') !== null;
}

/**
 * Should a document-level Escape shortcut act?
 *
 * Split from the shortcut itself so the rule can be tested without standing up an editor. The
 * two halves of the fix are pinned separately: this says the guard consults the marker, and a
 * test in `DatasetEditor.test.tsx` says Radix really sets it.
 */
export function escapeIsOurs(root: ParentNode = document): boolean {
  return !aModalIsOpen(root);
}
