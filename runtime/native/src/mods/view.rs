use super::*;
use codex_omd::ModActivity;
use codex_omd::ModPanel;
use codex_omd::ModTerminalView;
use codex_omd::ModViewSnapshot;

#[derive(Default)]
struct State {
    snapshot: ModViewSnapshot,
    presentation: Value,
    sequence: u64,
    diagnostics: BTreeMap<String, String>,
}

pub(super) struct Views {
    state: Mutex<State>,
    published: Mutex<Option<Arc<ModViewSnapshot>>>,
    /// Set while re-rendering for a roster change: an unchanged view keeps its revision.
    pub(super) quiet: AtomicBool,
}

/// Keeps at most `limit` UTF-8 bytes, matching `ModViewSnapshot::read`.
fn visible(text: &str, limit: usize) -> String {
    let mut output = String::new();
    for character in text.chars().filter(|c| !c.is_control()) {
        if output.len() + character.len_utf8() > limit {
            break;
        }
        output.push(character);
    }
    output
}

impl Views {
    pub(super) fn start_thread(&self, thread: &codex_extension_api::ExtensionData) -> Value {
        let phase = if thread.get::<codex_extension_api::ResumedThread>().is_some()
            || thread
                .get::<codex_extension_api::ForkedFromThread>()
                .is_some()
        {
            "resumed"
        } else {
            "fresh"
        };
        self.presentation(thread.level_id(), Some(phase))
    }

    pub(super) fn presentation(&self, thread: &str, phase: Option<&str>) -> Value {
        let Ok(mut state) = self.state.lock() else {
            return Value::Null;
        };
        if state.presentation["thread_id"].as_str() != Some(thread) {
            state.presentation = json!({"thread_id": thread, "phase": "fresh"});
        }
        if let Some(phase) = phase {
            state.presentation["phase"] = json!(phase);
        }
        state.presentation.clone()
    }

    pub(super) fn current_presentation(&self) -> Value {
        self.state
            .lock()
            .map(|state| state.presentation.clone())
            .unwrap_or(Value::Null)
    }

    pub(super) fn new() -> Self {
        let epoch = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| u64::try_from(elapsed.as_nanos()).unwrap_or(u64::MAX))
            .unwrap_or_default();
        Self {
            state: Mutex::new(State {
                snapshot: ModViewSnapshot {
                    epoch,
                    ..ModViewSnapshot::default()
                },
                ..State::default()
            }),
            published: Mutex::new(None),
            quiet: AtomicBool::new(false),
        }
    }

    pub(super) fn published(&self) -> Option<Arc<ModViewSnapshot>> {
        self.published.lock().ok()?.clone()
    }

    fn update(&self, owner: &Host, change: impl FnOnce(&mut State)) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        change(&mut state);
        state.snapshot.diagnostics = state.diagnostics.values().take(16).cloned().collect();
        let _ = owner.persist_json("mod-view.json", &state.snapshot);
        if let Ok(mut published) = self.published.lock() {
            *published = Some(Arc::new(state.snapshot.clone()));
        }
        super::clients::reconcile(self, &state.snapshot);
        codex_omd::client_surface::redraw();
    }

    pub(super) fn base(
        &self,
        owner: &Host,
        terminal: ModTerminalView,
        input: Value,
        rendered_ms: u64,
    ) {
        let quiet = self.quiet.load(Ordering::Acquire);
        self.update(owner, |state| {
            let snapshot = &state.snapshot;
            if !quiet
                || snapshot.view != terminal.view
                || snapshot.conflicts != terminal.conflicts
                || snapshot.contributors != terminal.contributors
                || snapshot.component_owners != terminal.component_owners
                || snapshot.layout_owner != terminal.layout_owner
            {
                state.snapshot.revision = state.snapshot.revision.saturating_add(1);
            }
            state.snapshot.rendered_ms = rendered_ms;
            state.snapshot.view = terminal.view;
            state.snapshot.conflicts = terminal.conflicts;
            state.snapshot.contributors = terminal.contributors;
            state.snapshot.component_owners = terminal.component_owners;
            state.snapshot.layout_owner = terminal.layout_owner;
            state.snapshot.input = input;
            state
                .diagnostics
                .retain(|key, _| !key.starts_with("terminal:"));
            for (index, diagnostic) in terminal.diagnostics.into_iter().enumerate() {
                state
                    .diagnostics
                    .insert(format!("terminal:{index}"), visible(&diagnostic, 512));
            }
        });
    }

    pub(super) fn diagnostic(&self, owner: &Host, key: &str, message: Option<String>) {
        self.update(owner, |state| match message {
            Some(message) => {
                state
                    .diagnostics
                    .insert(key.to_owned(), visible(&message, 512));
            }
            None => {
                state.diagnostics.remove(key);
            }
        });
    }

    pub(super) fn progress(&self, owner: &Host, label: &str, text: &str) {
        let lines = text
            .split('\n')
            .map(|line| visible(line, 1024))
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>();
        let start = lines.len().saturating_sub(8);
        self.update(owner, |state| {
            state.snapshot.progress = Some(ModPanel {
                title: visible(label, 128),
                lines: lines[start..].to_vec(),
            });
        });
    }

    pub(super) fn finish(&self, owner: &Host, mod_id: &str, tool: &str, label: &str, status: &str) {
        self.update(owner, |state| {
            state.snapshot.progress = None;
            state.sequence += 1;
            state.snapshot.activity.push(ModActivity {
                sequence: state.sequence,
                mod_id: mod_id.to_owned(),
                tool: visible(tool, 128),
                label: visible(label, 128),
                status: status.to_owned(),
            });
            let excess = state.snapshot.activity.len().saturating_sub(32);
            state.snapshot.activity.drain(..excess);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::Views;

    #[test]
    fn welcome_phase_survives_ready_reload_and_rejected_input_until_accepted_start() {
        let views = Views::new();
        assert_eq!(
            views.presentation("thread-a", Some("fresh"))["phase"],
            "fresh"
        );
        assert_eq!(views.presentation("thread-a", None)["phase"], "fresh");
        views.presentation("thread-a", Some("started"));
        assert_eq!(views.presentation("thread-a", None)["phase"], "started");
        assert_eq!(views.current_presentation()["phase"], "started");
        views.presentation("thread-b", Some("resumed"));
        assert_eq!(views.presentation("thread-b", None)["phase"], "resumed");
        assert_eq!(views.presentation("thread-c", None)["phase"], "fresh");
    }

    #[test]
    fn welcome_resume_and_fork_markers_are_latched_before_ready_publication() {
        let views = Views::new();
        let thread = codex_extension_api::ExtensionData::new("resumed");
        thread.insert(codex_extension_api::ResumedThread);
        views.start_thread(&thread);
        assert_eq!(views.current_presentation()["phase"], "resumed");
        assert_eq!(
            views.presentation(thread.level_id(), None)["phase"],
            "resumed"
        );
        let fork = codex_extension_api::ExtensionData::new("forked");
        fork.insert(codex_extension_api::ForkedFromThread(
            codex_protocol::ThreadId::new(),
        ));
        views.start_thread(&fork);
        assert_eq!(views.current_presentation()["phase"], "resumed");
        assert_eq!(views.current_presentation()["thread_id"], "forked");
    }

}
