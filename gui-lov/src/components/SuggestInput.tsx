import { forwardRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { acceptHint, canSuggest, isAcceptKey } from "@/lib/suggestion";

/**
 * An input whose placeholder is a usable default, one keystroke away.
 *
 * Pass `suggestion` only where the greyed text is what the answer usually *is* — not where it is
 * an example of the shape. `→`, `End` and `Tab` accept it; `Escape` dismisses it so `Tab`
 * navigates as normal.
 *
 * Everything else about it is an `Input`, so a caller can style and label it as usual.
 */
interface Props extends Omit<React.ComponentProps<typeof Input>, "placeholder"> {
  /** The default. Doubles as the placeholder, so the two can never disagree. */
  suggestion?: string;
  /** Shown when there is no suggestion — an example of the shape, not a default. */
  placeholder?: string;
  /** Required, because there is no honest way to accept a suggestion without it. */
  onAccept: (value: string) => void;
}

export const SuggestInput = forwardRef<HTMLInputElement, Props>(
  ({ suggestion, placeholder, onAccept, onChange, onKeyDown, ...rest }, ref) => {
    // Per-field and per-mount: dismissing is about this moment, not a preference to remember.
    const [dismissed, setDismissed] = useState(false);

    const value = String(rest.value ?? "");
    const offering = !dismissed && canSuggest(value, suggestion);

    return (
      <div className="relative">
        <Input
          {...rest}
          ref={ref}
          placeholder={suggestion || placeholder}
          className={[
            rest.className ?? "",
            // A suggestion has to look unmistakably *unentered*. The default placeholder colour
            // is as dark as plenty of real text, and in a mono face at this size a suggestion
            // like `http://127.0.0.1:9000` read as a filled-in value — someone completed the
            // form, believed the endpoint was set, and met a disabled button saying "needs an
            // endpoint". Ghost text has to be ghostly.
            offering ? "placeholder:text-muted-foreground/50" : "",
            // Room for the badge, so the two never sit on top of each other.
            offering ? "pr-28" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onChange={(e) => {
            // Typing means the suggestion is no longer what they want; showing the hint after
            // that would promise a key that does nothing.
            if (e.target.value) setDismissed(false);
            onChange?.(e);
          }}
          onKeyDown={(e) => {
            if (offering && isAcceptKey(e.key)) {
              // Tab must not also move focus: accepting and leaving in one press would make the
              // fill invisible, and nobody would know which field had changed.
              e.preventDefault();
              // The caller owns the update. Faking a ChangeEvent to reuse `onChange` was the
              // first attempt and it is a lie about where the value came from — a synthetic
              // event with a hand-built `target` breaks the moment anything reads more of it.
              onAccept(suggestion!);
              return;
            }
            if (offering && e.key === "Escape") {
              // The way out of a field you meant to leave blank: dismiss, then Tab as usual.
              e.preventDefault();
              setDismissed(true);
              return;
            }
            onKeyDown?.(e);
          }}
        />
        {/* Whenever the key would work — **not** only while focused. On focus alone it was
            invisible to someone scanning a filled-in form, which is exactly when it matters: the
            badge is what says "this field is still empty" about text that otherwise looks typed.
            It disappears the moment the suggestion is taken, so it doubles as feedback. */}
        {offering && (
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {acceptHint()}
          </span>
        )}
      </div>
    );
  },
);
SuggestInput.displayName = "SuggestInput";

export default SuggestInput;
