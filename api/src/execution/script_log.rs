//! Capturing `print()` and `debug()` output from scripts.
//!
//! Rhai's default handler sends both to the server's stdout, where a test author
//! never sees them — so a script's only way to say something was to fail. These
//! land in the run's log instead, beside the engine's own messages.
//!
//! The sink is a thread-local because `Engine::on_print` wants a `'static`
//! closure while the engines themselves are shared. That is sound here: a Rhai
//! evaluation is synchronous, so two evaluations cannot interleave on one thread,
//! and each Tokio worker thread gets its own sink.

use std::cell::RefCell;

use rhai::Engine;

/// Enough for a script explaining itself; a runaway loop is already bounded by
/// the engines' `max_operations`, so this is only a memory backstop.
const MAX_LINES: usize = 200;

thread_local! {
    static SINK: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

/// Route a script engine's `print` / `debug` output into the current sink.
pub fn capture(engine: &mut Engine) {
    engine.on_print(|text| push(text.to_string()));
    engine.on_debug(|text, source, pos| {
        push(match (source, pos.is_none()) {
            (Some(src), _) => format!("{} ({}): {}", src, pos, text),
            (None, true) => text.to_string(),
            (None, false) => format!("{}: {}", pos, text),
        })
    });
}

fn push(line: String) {
    SINK.with(|sink| {
        let mut sink = sink.borrow_mut();
        if sink.len() < MAX_LINES {
            sink.push(line);
        } else if sink.len() == MAX_LINES {
            sink.push(format!("… further output dropped after {} lines", MAX_LINES));
        }
    });
}

/// Begin collecting for one script run, discarding anything left behind.
pub fn start() {
    SINK.with(|sink| sink.borrow_mut().clear());
}

/// Take what the run printed. Called on the error path too — output written
/// before a script threw is exactly what explains the throw.
pub fn take() -> Vec<String> {
    SINK.with(|sink| sink.borrow_mut().drain(..).collect())
}

/// Turn a Rhai "variable not found" into advice, when the missing name is a
/// JavaScript habit. Scripts look enough like JS that reaching for `console.log`
/// is the expected first move, and the bare message doesn't hint at a way out.
///
/// `data` is here for a different reason: it existed in an earlier data-driven
/// design and scripts written against it still fail this way, with a message that
/// gives no clue the feature moved.
pub fn hint_for(message: &str) -> Option<&'static str> {
    const HINTS: &[(&str, &str)] = &[
        (
            "console",
            "Rhai has no console — use print(\"…\") and the output appears in this run's log.",
        ),
        ("typeof", "Rhai spells this type_of(x)."),
        (
            "data",
            "There is no data.* — a dataset row states what it expects in its own \
             Expect column, and this script runs only for the request as authored. \
             Assert the literal here (response.status == 201).",
        ),
        (
            "JSON",
            "There is no JSON object — response.json is already parsed. \
             Print a value with debug(x).",
        ),
        ("null", "Rhai writes an absent value as () — e.g. response.json.x != ()."),
        ("undefined", "Rhai writes an absent value as () — e.g. response.json.x != ()."),
    ];
    // Two shapes reach here: an unknown name ("Variable not found: console") and a
    // name Rhai reserves, which fails earlier as a syntax error ("'null' is a
    // reserved keyword"). Both are the same author mistake.
    let name = if let Some(rest) = message
        .strip_prefix("Variable not found: ")
        .or_else(|| message.strip_prefix("Function not found: "))
    {
        rest.split(|c: char| !c.is_alphanumeric() && c != '_').next()?
    } else {
        let start = message.find('\'')? + 1;
        let rest = &message[start..];
        let name = &rest[..rest.find('\'')?];
        if !message[start + name.len()..].contains("is a reserved keyword") {
            return None;
        }
        name
    };
    HINTS.iter().find(|(js, _)| *js == name).map(|(_, hint)| *hint)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn print_output_is_captured_in_order() {
        let mut engine = Engine::new();
        capture(&mut engine);
        start();
        engine.run(r#"print("first"); print("second");"#).unwrap();
        assert_eq!(take(), vec!["first".to_string(), "second".to_string()]);
    }

    #[test]
    fn output_written_before_a_failure_survives() {
        let mut engine = Engine::new();
        capture(&mut engine);
        start();
        assert!(engine.run(r#"print("got here"); nope + 1;"#).is_err());
        assert_eq!(take(), vec!["got here".to_string()]);
    }

    #[test]
    fn debug_output_is_captured_too() {
        // The JSON hint tells authors to use debug(x), so it has to be captured.
        let mut engine = Engine::new();
        capture(&mut engine);
        start();
        engine.run(r#"debug(#{"a": 1});"#).unwrap();
        let out = take();
        assert_eq!(out.len(), 1, "{:?}", out);
        assert!(out[0].contains("\"a\""), "{:?}", out);
    }

    #[test]
    fn taking_twice_yields_nothing_the_second_time() {
        let mut engine = Engine::new();
        capture(&mut engine);
        start();
        engine.run(r#"print("once");"#).unwrap();
        assert_eq!(take().len(), 1);
        assert!(take().is_empty());
    }

    #[test]
    fn a_flood_of_output_is_capped() {
        let mut engine = Engine::new();
        capture(&mut engine);
        start();
        engine.run("for i in 0..500 { print(i); }").unwrap();
        let out = take();
        assert_eq!(out.len(), MAX_LINES + 1);
        assert!(out.last().unwrap().contains("further output dropped"));
    }

    #[test]
    fn javascript_habits_get_a_hint() {
        assert!(hint_for("Variable not found: console (line 1, position 1)")
            .unwrap()
            .contains("print("));
        // A JS-ism can surface as a missing variable or a missing function.
        assert!(hint_for("Variable not found: typeof").unwrap().contains("type_of"));
        assert!(hint_for("Function not found: typeof (i64) (line 1, position 1)")
            .unwrap()
            .contains("type_of"));
        assert!(hint_for("Variable not found: JSON").unwrap().contains("already parsed"));
        // Not a JS habit — a script written against the retired dataset columns.
        assert!(hint_for("Variable not found: data (line 5, position 20)")
            .unwrap()
            .contains("Expect column"));
        assert_eq!(hint_for("Function not found: myHelper (i64)"), None);
        assert!(hint_for("Variable not found: null").unwrap().contains("()"));
        // Rhai reserves `null`, so a JS-style null check fails as a syntax error.
        assert!(hint_for("Syntax error: 'null' is a reserved keyword (line 1, position 18)")
            .unwrap()
            .contains("()"));
        assert_eq!(hint_for("Syntax error: 'fn' is a reserved keyword"), None);
        // Not a JS-ism, and not a "variable not found" at all: no advice invented.
        assert_eq!(hint_for("Variable not found: myTypo"), None);
        assert_eq!(hint_for("Runtime error: division by zero"), None);
    }
}
