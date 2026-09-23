use super::*;
use pretty_assertions::assert_eq;

fn mod_target(id: &str, command: &str) -> ModSlashTarget {
    ModSlashTarget::Mod {
        id: id.to_owned(),
        command: command.to_owned(),
    }
}

#[test]
fn namespaced_commands_always_exist_and_bare_aliases_only_when_unique() {
    let commands = build(vec![
        test_entry(
            "counter:reset",
            "reset",
            "Reset",
            mod_target("counter", "reset"),
        ),
        test_entry(
            "other:reset",
            "reset",
            "Reset other",
            mod_target("other", "reset"),
        ),
        test_entry(
            "counter:model",
            "model",
            "Shadowed",
            mod_target("counter", "model"),
        ),
        test_entry(
            "counter:tally",
            "tally",
            "Tally",
            mod_target("counter", "tally"),
        ),
        test_entry(
            "pi:review",
            "review",
            "Review a file (Pi prompt)",
            ModSlashTarget::PiPrompt {
                name: "review".to_owned(),
            },
        ),
    ]);
    let invocations = commands
        .iter()
        .map(|command| command.invocation.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        invocations,
        vec![
            "counter:reset",
            "other:reset",
            "counter:model",
            "counter:tally",
            "tally",
            "pi:review",
        ]
    );
    assert_eq!(
        commands[0].description,
        "Reset · bare /reset unavailable: defined by more than one mod or prompt"
    );
    assert_eq!(
        commands[2].description,
        "Shadowed · bare /model unavailable: conflicts with built-in /model"
    );
    assert_eq!(commands[4].description, "Tally (/counter:tally)");
    assert_eq!(
        commands[5].description,
        "Review a file (Pi prompt) · bare /review unavailable: conflicts with built-in /review"
    );
}
