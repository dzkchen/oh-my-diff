use codex_omd::ReactiveRule;
use codex_omd::ReactiveRuleSet;
use codex_omd::ReactiveRules;
use codex_omd::ReactiveScope;
use codex_omd::ReactiveToolOutcome;
use codex_omd::ReactiveTrigger;

fn trigger(tool: &str, outcome: ReactiveToolOutcome) -> ReactiveTrigger {
    ReactiveTrigger::ToolFinished {
        tool: tool.into(),
        outcome,
    }
}

fn rule(id: &str, scope: ReactiveScope, tool: &str) -> ReactiveRule {
    ReactiveRule {
        id: id.into(),
        scope,
        trigger: trigger(tool, ReactiveToolOutcome::CompletedHostFailure),
        instruction: "Inspect the observed failure before choosing a different bounded attempt."
            .into(),
        max_activations: 2,
        max_context_reactivations: 1,
    }
}

fn rules(entries: Vec<ReactiveRule>) -> ReactiveRuleSet {
    ReactiveRuleSet {
        schema: 1,
        version: "reactive-v1".into(),
        rules: entries,
    }
}

fn runtime(entries: Vec<ReactiveRule>) -> ReactiveRules {
    ReactiveRules::new(
        rules(entries),
        "/private/tmp/reactive-rules.json".into(),
        "a".repeat(64),
    )
    .unwrap()
}

#[test]
fn exact_scoped_match_activates_only_the_selected_rule() {
    let reactive = runtime(vec![
        rule("lead-edit", ReactiveScope::Lead, "exec_command"),
        rule("worker-edit", ReactiveScope::Worker, "exec_command"),
    ]);
    let exact = trigger("exec_command", ReactiveToolOutcome::CompletedHostFailure);
    let activation = reactive
        .activate("thread-lead", "lead", &exact)
        .unwrap()
        .unwrap();
    assert_eq!(activation.rule_id, "lead-edit");
    assert_eq!(activation.activation, 1);
    assert!(
        reactive
            .activate(
                "thread-lead",
                "lead",
                &trigger("functions.exec", ReactiveToolOutcome::CompletedHostFailure)
            )
            .unwrap()
            .is_none()
    );
}

#[test]
fn ambiguous_matches_and_unbounded_rules_are_rejected() {
    let duplicate = rule("second", ReactiveScope::Lead, "exec_command");
    assert!(
        ReactiveRules::new(
            rules(vec![
                rule("first", ReactiveScope::Lead, "exec_command"),
                duplicate
            ]),
            "source".into(),
            "b".repeat(64)
        )
        .is_err()
    );
    let mut unbounded = rule("unbounded", ReactiveScope::Lead, "exec_command");
    unbounded.max_activations = 9;
    assert!(ReactiveRules::new(rules(vec![unbounded]), "source".into(), "b".repeat(64)).is_err());
}

#[test]
fn lead_and_worker_scopes_are_not_ambiguous() {
    let reactive = runtime(vec![
        rule("lead-edit", ReactiveScope::Lead, "exec_command"),
        rule("worker-edit", ReactiveScope::Worker, "exec_command"),
    ]);
    let exact = trigger("exec_command", ReactiveToolOutcome::CompletedHostFailure);
    assert_eq!(
        reactive
            .activate("thread-worker", "agent:worker", &exact)
            .unwrap()
            .unwrap()
            .rule_id,
        "worker-edit"
    );
}

#[test]
fn activation_is_bounded_and_does_not_claim_retry_or_rollback() {
    let reactive = runtime(vec![rule(
        "failed-edit",
        ReactiveScope::Lead,
        "exec_command",
    )]);
    let exact = trigger("exec_command", ReactiveToolOutcome::CompletedHostFailure);
    let first = reactive
        .activate("thread", "lead", &exact)
        .unwrap()
        .unwrap();
    let second = reactive
        .activate("thread", "lead", &exact)
        .unwrap()
        .unwrap();
    assert!(
        reactive
            .activate("thread", "lead", &exact)
            .unwrap()
            .is_none()
    );
    assert_eq!((first.activation, second.activation), (1, 2));
    assert!(!second.executed_effects_rolled_back);
    assert!(!second.retry_started);
    let prompt = second.prompt();
    assert!(prompt.contains("subordinate to current user and project instructions"));
    assert!(prompt.contains("no executed effect was rolled back"));
    assert!(prompt.contains("shared task allowance and request accounting"));
    assert!(prompt.contains("reactive-v1"));
    assert!(prompt.contains(&"a".repeat(64)));
}

#[test]
fn active_rule_survives_until_one_bounded_context_reactivation() {
    let reactive = runtime(vec![rule(
        "failed-edit",
        ReactiveScope::Lead,
        "exec_command",
    )]);
    let exact = trigger("exec_command", ReactiveToolOutcome::CompletedHostFailure);
    reactive
        .activate("thread", "lead", &exact)
        .unwrap()
        .unwrap();
    let after_compaction = reactive.context_prompts("thread").unwrap();
    assert_eq!(after_compaction.len(), 1);
    assert!(after_compaction[0].starts_with("Reactivated after a context rebuild:"));
    assert!(reactive.context_prompts("thread").unwrap().is_empty());
    assert!(reactive.context_prompts("other-thread").unwrap().is_empty());
}
