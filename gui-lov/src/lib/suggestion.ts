/**
 * Accepting an inline suggestion with one keystroke.
 *
 * Some placeholders are **examples** — `minio (dev)` for a name — and some are **defaults** that
 * are usually right, like `http://127.0.0.1:9000` for a port-forwarded endpoint. Only the second
 * kind should be acceptable: filling in an example gives you a storage genuinely called
 * "minio (dev)". So a field opts in by passing a `suggestion`, rather than every placeholder in
 * the app quietly becoming typeable.
 *
 * **Which key.** `→` and `End` are what shell autosuggestion has trained everyone on (fish,
 * zsh-autosuggestions), and they cost nothing because at an empty field they do nothing else.
 * `Tab` is included because it is the one people reach for first — at the price that leaving a
 * suggested field empty then takes two presses, the first accepting and the second moving on.
 * `Escape` is the way out: it dismisses the suggestion, after which Tab navigates as usual.
 */

/** Keys that take the suggestion. See the note above on why `Tab` is among them. */
export const ACCEPT_KEYS = ["Tab", "ArrowRight", "End"] as const;

export function isAcceptKey(key: string): boolean {
  return (ACCEPT_KEYS as readonly string[]).includes(key);
}

/**
 * Whether there is a suggestion to offer right now.
 *
 * Only for an **empty** field: once anything is typed, `→` and `End` have to mean what they
 * always mean, and a Tab that rewrote what someone was halfway through typing would be
 * indefensible. Whitespace counts as empty, since it is not an answer either.
 */
export function canSuggest(value: string, suggestion: string | undefined): boolean {
  return !!suggestion?.trim() && value.trim() === "";
}

/** "→ or Tab to use it" — shown only while it is true, so it never lies about what a key does. */
export function acceptHint(): string {
  return "→ or Tab to use it";
}
