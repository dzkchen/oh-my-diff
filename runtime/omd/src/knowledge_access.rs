use crate::resource_data::{ResourceRef, ResourceStore, contains_secret};
use crate::{
    KnowledgeAction, KnowledgeApproval, KnowledgeMode, KnowledgeRemoval, KnowledgeReset,
    KnowledgeStore, LessonCandidate, RecordKind, SourceAnchor, SourceFact, SourceFactInput,
    SourceFactStatus, TaskEvidenceInput,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io;
use std::path::Path;

pub struct KnowledgeAccess<'a> {
    pub store: &'a KnowledgeStore,
    pub repository: &'a Path,
    pub resources: ResourceStore<'a>,
    pub user_action: Option<KnowledgeAction>,
    pub readable: &'a dyn Fn(&Path) -> bool,
}

impl KnowledgeAccess<'_> {
    fn verify(&self) -> io::Result<()> {
        if self.store.repository_identity()? != self.resources.binding.repository
            || self.repository.canonicalize()? != self.repository
        {
            return Err(io::Error::other("knowledge_repository_mismatch"));
        }
        Ok(())
    }

    fn check(&self, source: &SourceAnchor, excerpt: &str) -> io::Result<()> {
        if !(self.readable)(&crate::workspace_path(self.repository, &source.path)?) {
            return Err(io::Error::other("knowledge_source_denied"));
        }
        if contains_secret(excerpt) {
            return Err(io::Error::other("knowledge_secret_source_excluded"));
        }
        Ok(())
    }

    fn fresh(&self, fact: &SourceFact) -> io::Result<()> {
        match &fact.status {
            SourceFactStatus::Fresh { version } => self.check(&fact.source, &version.excerpt),
            SourceFactStatus::Invalidated { .. } => {
                Err(io::Error::other("knowledge_source_invalidated"))
            }
        }
    }

    pub fn call(
        &self,
        operation: &str,
        arguments: Value,
        active: impl Fn() -> bool,
    ) -> io::Result<Value> {
        self.verify()?;
        if !active() {
            return Err(io::Error::other("knowledge_cancelled"));
        }
        if serde_json::to_vec(&arguments)?.len() > 16384 || contains_secret(&arguments.to_string())
        {
            return Err(io::Error::other("knowledge_input_excluded"));
        }
        let value = match operation {
            "knowledge.inspect" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Input {
                    #[serde(default)]
                    ids: Option<Vec<String>>,
                }
                let input: Input = serde_json::from_value(arguments)?;
                if input.ids.as_ref().is_some_and(|ids| ids.len() > 64) {
                    return Err(io::Error::other("knowledge_inspection_limit"));
                }
                let mut inspection = self.store.inspect(self.repository)?;
                if let Some(ids) = input.ids {
                    inspection.facts.retain(|fact| ids.contains(&fact.id));
                    inspection.lessons.retain(|lesson| ids.contains(&lesson.id));
                    inspection
                        .evidence
                        .retain(|evidence| ids.contains(&evidence.id));
                }
                for fact in &mut inspection.facts {
                    if let Err(error) = self.fresh(fact)
                        && matches!(fact.status, SourceFactStatus::Fresh { .. })
                    {
                        fact.status = SourceFactStatus::Invalidated {
                            reason: error.to_string(),
                        };
                    }
                }
                inspection.events.clear();
                serde_json::to_value(inspection)?
            }
            "knowledge.retain" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Input {
                    expected_revision: u64,
                    id: String,
                    label: String,
                    source: Option<SourceAnchor>,
                    evidence: Option<ResourceRef>,
                }
                let input: Input = serde_json::from_value(arguments)?;
                match (input.source, input.evidence) {
                    (Some(source), None) => {
                        let version = crate::knowledge::read_source(self.repository, &source)
                            .map_err(|error| {
                                if error.kind() == io::ErrorKind::NotFound {
                                    io::Error::other("knowledge_source_missing")
                                } else {
                                    error
                                }
                            })?;
                        self.check(&source, &version.excerpt)?;
                        serde_json::to_value(self.store.retain_source_fact(
                            self.repository,
                            SourceFactInput {
                                expected_revision: input.expected_revision,
                                id: input.id,
                                label: input.label,
                                source,
                                task_id: self.resources.binding.thread.clone(),
                            },
                        )?)?
                    }
                    (None, Some(reference)) => {
                        let evidence = self.resources.load(&reference, "turn")?;
                        if contains_secret(&evidence.to_string()) {
                            return Err(io::Error::other("knowledge_secret_evidence_excluded"));
                        }
                        serde_json::to_value(
                            self.store.retain_evidence(TaskEvidenceInput {
                                expected_revision: input.expected_revision,
                                id: input.id,
                                summary: input.label,
                                kind: "turn".into(),
                                workspace_sha256: evidence["workspace_sha256"]
                                    .as_str()
                                    .ok_or_else(|| io::Error::other("evidence_workspace_required"))?
                                    .into(),
                                artifact: self.resources.artifact(&reference, "turn")?,
                                task_id: self.resources.binding.thread.clone(),
                            })?,
                        )?
                    }
                    _ => return Err(io::Error::other("knowledge_exactly_one_source_required")),
                }
            }
            "knowledge.propose" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Input {
                    expected_revision: u64,
                    id: String,
                    text: String,
                    evidence_ids: Vec<String>,
                }
                let input: Input = serde_json::from_value(arguments)?;
                serde_json::to_value(self.store.propose_lesson(LessonCandidate {
                    expected_revision: input.expected_revision,
                    id: input.id,
                    text: input.text,
                    evidence_ids: input.evidence_ids,
                    task_id: self.resources.binding.thread.clone(),
                })?)?
            }
            "knowledge.approve" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Input {
                    expected_revision: u64,
                    lesson_id: String,
                }
                let input: Input = serde_json::from_value(arguments)?;
                let action = self
                    .user_action
                    .clone()
                    .ok_or_else(|| io::Error::other("knowledge_explicit_user_action_required"))?;
                serde_json::to_value(self.store.approve_lesson(KnowledgeApproval {
                    expected_revision: input.expected_revision,
                    lesson_id: input.lesson_id,
                    action,
                })?)?
            }
            "knowledge.remove" | "knowledge.reset" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Input {
                    expected_revision: u64,
                    kind: Option<RecordKind>,
                    id: Option<String>,
                }
                let input: Input = serde_json::from_value(arguments)?;
                let action = self
                    .user_action
                    .clone()
                    .ok_or_else(|| io::Error::other("knowledge_explicit_user_action_required"))?;
                if operation == "knowledge.reset" {
                    if input.kind.is_some() || input.id.is_some() {
                        return Err(io::Error::other("knowledge_reset_scope_invalid"));
                    }
                    serde_json::to_value(self.store.reset(KnowledgeReset {
                        expected_revision: input.expected_revision,
                        action,
                    })?)?
                } else {
                    self.store.remove(KnowledgeRemoval {
                        expected_revision: input.expected_revision,
                        kind: input
                            .kind
                            .ok_or_else(|| io::Error::other("knowledge_kind_required"))?,
                        id: input
                            .id
                            .ok_or_else(|| io::Error::other("knowledge_id_required"))?,
                        action,
                    })?;
                    json!({"revision":self.store.revision()?})
                }
            }
            "knowledge.snapshot" | "context.freeze" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Input {
                    mode: KnowledgeMode,
                    ids: Vec<String>,
                    max_bytes: Option<usize>,
                }
                let input: Input = serde_json::from_value(arguments)?;
                if input.ids.len() > 64 {
                    return Err(io::Error::other("knowledge_selection_limit"));
                }
                let mut session = self.store.session(self.repository, input.mode, 262144)?;
                session.facts.retain(|fact| input.ids.contains(&fact.id));
                session
                    .approved_lessons
                    .retain(|lesson| input.ids.contains(&lesson.id));
                for fact in &session.facts {
                    self.fresh(fact)?;
                }
                let max = input.max_bytes.unwrap_or(32768);
                let payload = serde_json::to_value(&session)?;
                if max == 0 || max > 262144 || serde_json::to_vec(&payload)?.len() > max {
                    return Err(io::Error::other("knowledge_context_bound"));
                }
                serde_json::to_value(self.resources.save("knowledge", payload)?)?
            }
            "context.deliver" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Input {
                    snapshot: ResourceRef,
                }
                let input: Input = serde_json::from_value(arguments)?;
                let frozen: crate::KnowledgeSession =
                    serde_json::from_value(self.resources.load(&input.snapshot, "knowledge")?)?;
                let current = self.store.session(self.repository, frozen.mode, 262144)?;
                if current.generation != frozen.generation {
                    return Err(io::Error::other("knowledge_snapshot_revoked"));
                }
                for fact in &frozen.facts {
                    self.fresh(fact)?;
                    if !current.facts.contains(fact) {
                        return Err(io::Error::other("knowledge_snapshot_source_changed"));
                    }
                }
                for lesson in &frozen.approved_lessons {
                    if !current.approved_lessons.contains(lesson) {
                        return Err(io::Error::other("knowledge_snapshot_lesson_revoked"));
                    }
                }
                serde_json::to_value(frozen)?
            }
            _ => return Err(io::Error::other("knowledge_operation_unavailable")),
        };
        if !active() {
            return Err(io::Error::other("knowledge_cancelled"));
        }
        if serde_json::to_vec(&value)?.len() > 32768 || contains_secret(&value.to_string()) {
            return Err(io::Error::other("knowledge_output_excluded_or_oversized"));
        }
        Ok(value)
    }
}
