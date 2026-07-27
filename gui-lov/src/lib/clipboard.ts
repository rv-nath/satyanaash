/**
 * Copying text to the clipboard, including where the modern API isn't there.
 *
 * `navigator.clipboard` only exists in a secure context, and this app is commonly
 * opened over `http://<lan-ip>:8080` from another machine — so relying on it alone
 * would make a copy button silently do nothing for exactly the people who need it.
 * The `execCommand` path is deprecated but still works everywhere.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission refused or a non-secure origin — try the old way instead.
  }
  return copyViaTextarea(text);
}

function copyViaTextarea(text: string): boolean {
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  // Off-screen but still selectable: display:none or visibility:hidden would
  // make the selection — and so the copy — fail.
  field.style.position = "fixed";
  field.style.top = "-1000px";
  field.style.opacity = "0";
  document.body.appendChild(field);

  // Put back whatever the user had selected; copying shouldn't steal it.
  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  field.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }

  document.body.removeChild(field);
  if (selection && previous) {
    selection.removeAllRanges();
    selection.addRange(previous);
  }
  return copied;
}
