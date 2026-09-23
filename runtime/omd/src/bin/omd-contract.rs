use codex_omd::AssuranceLabel;
use codex_omd::ContractCatalog;
use codex_omd::ContractChoice;
use codex_omd::SelectionFile;
use codex_omd::SelectionSource;
use codex_omd::WorkflowContract;
use codex_omd::collect_selections;
use codex_omd::confirmation_token;
use codex_omd::read_selection;
use codex_omd::resolve_selection;
use codex_omd::write_selection;
use serde_json::Value;
use serde_json::json;
use std::io;
use std::path::Path;
use std::path::PathBuf;

fn usage() -> io::Error {
    io::Error::other(
        "usage: omd-contract list | status USER_SELECTION PROJECT_SELECTION [ID@VERSION] | plan USER_SELECTION PROJECT_SELECTION ID@VERSION | select USER_SELECTION ID@VERSION [CONFIRMATION] | require PROJECT_SELECTION ASSURANCE | clear SELECTION",
    )
}

fn optional(path: &str) -> Option<PathBuf> {
    (!path.is_empty() && path != "-").then(|| PathBuf::from(path))
}

fn assurance(value: &str) -> io::Result<AssuranceLabel> {
    serde_json::from_value(json!(value)).map_err(|_| {
        io::Error::other(
            "expected unreviewed, self_reviewed, independently_reviewed, or independently_verified",
        )
    })
}

fn resolve(
    user: Option<&Path>,
    project: Option<&Path>,
    task: Option<&ContractChoice>,
) -> io::Result<Value> {
    let catalog = ContractCatalog::bundled();
    let selections = collect_selections(&catalog, None, user, project, task)?;
    let confirmation = selections.confirmation.clone();
    match resolve_selection(selections.offers, selections.floor) {
        Ok(resolution) => {
            let satisfied =
                !resolution.requires_confirmation || resolution.confirmation_token == confirmation;
            Ok(json!({
                "schema": 1,
                "effective": resolution.effective.contract.summary()?,
                "requirements": resolution.effective.contract.requirements,
                "source": resolution.effective.source,
                "owner": resolution.effective.owner,
                "precedence": resolution.considered,
                "floor": resolution.floor,
                "weakens_default": resolution.weakens_default,
                "requires_confirmation": resolution.requires_confirmation,
                "confirmation_recorded": satisfied,
                "activates": satisfied,
                "note": if satisfied {
                    "this contract activates for the next task"
                } else {
                    "recorded selection is weaker than the bundled default and is not confirmed; the prior contract is retained"
                },
            }))
        }
        Err(conflict) => Ok(json!({
            "schema": 1,
            "activates": false,
            "conflict": conflict.to_string(),
            "retained": WorkflowContract::bundled_default().summary()?,
            "note": "resolve the conflict explicitly; no contract is selected and nothing is downgraded",
        })),
    }
}

fn plan(user: Option<&Path>, project: Option<&Path>, choice: &ContractChoice) -> io::Result<Value> {
    let catalog = ContractCatalog::bundled();
    let (next, owner) = catalog.get(choice)?;
    let current = collect_selections(&catalog, None, user, project, None)
        .and_then(|selections| resolve_selection(selections.offers, selections.floor))
        .map(|resolution| resolution.effective.contract)
        .unwrap_or_else(|_| WorkflowContract::bundled_default());
    let before = current.summary()?;
    let after = next.summary()?;
    let weakens = after.assurance < before.assurance;
    Ok(json!({
        "schema": 1,
        "before": before,
        "before_requirements": current.requirements,
        "after": after,
        "after_requirements": next.requirements,
        "owner": owner,
        "weakens": weakens,
        "changes": changes(&current, &next),
        "confirmation": weakens.then(|| confirmation_token(&before, &after)),
        "note": if weakens {
            "this selection reduces assurance; pass the confirmation to omd-contract select"
        } else {
            "this selection does not reduce assurance"
        },
    }))
}

fn changes(before: &WorkflowContract, after: &WorkflowContract) -> Vec<String> {
    let (old, new) = (before.requirements, after.requirements);
    let mut changes = Vec::new();
    for (label, was, now) in [
        ("delegation", old.delegation, new.delegation),
        ("child agents", old.child_agents, new.child_agents),
        ("opposite-lead calls", old.opposite_lead, new.opposite_lead),
        ("escalation", old.escalation, new.escalation),
        ("checkpoints", old.checkpoints, new.checkpoints),
        (
            "milestone review",
            old.milestone_review,
            new.milestone_review,
        ),
    ] {
        if was != now {
            changes.push(format!(
                "{label}: {} -> {}",
                if was { "allowed" } else { "denied" },
                if now { "allowed" } else { "denied" }
            ));
        }
    }
    if old.final_review != new.final_review {
        changes.push(format!(
            "final review: {:?} -> {:?}",
            old.final_review, new.final_review
        ));
    }
    if old.completion != new.completion {
        changes.push(format!(
            "completion: {:?} -> {:?}",
            old.completion, new.completion
        ));
    }
    if before.assurance() != after.assurance() {
        changes.push(format!(
            "assurance: {} -> {}",
            before.assurance().label(),
            after.assurance().label()
        ));
    }
    changes
}

fn run(args: &[String]) -> io::Result<Value> {
    match args {
        [command] if command == "list" => ContractCatalog::bundled().list(),
        [command, user, project] if command == "status" => resolve(
            optional(user).as_deref(),
            optional(project).as_deref(),
            None,
        ),
        [command, user, project, choice] if command == "status" => resolve(
            optional(user).as_deref(),
            optional(project).as_deref(),
            Some(&ContractChoice::parse(choice)?),
        ),
        [command, user, project, choice] if command == "plan" => plan(
            optional(user).as_deref(),
            optional(project).as_deref(),
            &ContractChoice::parse(choice)?,
        ),
        [command, user, choice] | [command, user, choice, _] if command == "select" => {
            let confirmation = match args {
                [_, _, _, token] => Some(token.clone()),
                _ => None,
            };
            let path = PathBuf::from(user);
            let choice = ContractChoice::parse(choice)?;
            let catalog = ContractCatalog::bundled();
            let (next, _) = catalog.get(&choice)?;
            let existing = path
                .exists()
                .then(|| read_selection(&path, SelectionSource::UserDefault))
                .transpose()?;
            let selection = SelectionFile {
                schema: 1,
                contract: Some(choice.clone()),
                minimum_assurance: None,
                confirmation: confirmation.clone(),
            };
            write_selection(&path, &selection, SelectionSource::UserDefault)?;
            Ok(json!({
                "schema": 1,
                "selected": next.summary()?,
                "previous": existing.map(|(file, _)| file.contract).unwrap_or_default(),
                "path": path,
                "confirmation_recorded": confirmation.is_some(),
                "note": "selection applies to the next task; run omd-contract status to see whether it activates",
            }))
        }
        [command, project, minimum] if command == "require" => {
            let path = PathBuf::from(project);
            let selection = SelectionFile {
                schema: 1,
                contract: None,
                minimum_assurance: Some(assurance(minimum)?),
                confirmation: None,
            };
            write_selection(&path, &selection, SelectionSource::ProjectRecommendation)?;
            Ok(json!({
                "schema": 1,
                "minimum_assurance": selection.minimum_assurance,
                "path": path,
                "note": "a weaker selection now conflicts visibly and fails closed",
            }))
        }
        [command, path] if command == "clear" => {
            std::fs::remove_file(path)?;
            Ok(
                json!({"schema": 1, "cleared": path, "note": "the bundled default applies unless another selection remains"}),
            )
        }
        _ => Err(usage()),
    }
}

fn main() {
    match run(&std::env::args().skip(1).collect::<Vec<_>>()) {
        Ok(value) => println!(
            "{}",
            serde_json::to_string_pretty(&value).unwrap_or_default()
        ),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
