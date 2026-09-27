use super::*;
use codex_omd::ModActivity;
use codex_omd::ModPanel;
use codex_omd::ModTerminalView;
use codex_omd::ModViewSnapshot;

#[derive(Default)]
struct State {
    snapshot: ModViewSnapshot,
    sequence: u64,
    diagnostics: BTreeMap<String, String>,
}

pub(super) struct Views {
    state: Mutex<State>,
}

/// Keeps at most `limit` UTF-8 bytes, matching the byte bounds that
/// `ModViewSnapshot::read` enforces on the persisted snapshot.
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
        }
    }

    fn update(&self, owner: &Host, change: impl FnOnce(&mut State)) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        change(&mut state);
        state.snapshot.diagnostics = state.diagnostics.values().take(16).cloned().collect();
        let _ = owner.persist_json("mod-view.json", &state.snapshot);
    }

    pub(super) fn base(&self, owner: &Host, terminal: ModTerminalView, input: Value) {
        self.update(owner, |state| {
            state.snapshot.revision = state.snapshot.revision.saturating_add(1);
            state.snapshot.view = terminal.view;
            state.snapshot.owner = terminal.owner;
            state.snapshot.contributors = terminal.contributors;
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
    use super::visible;

    #[test]
    fn visible_bounds_bytes_on_a_character_boundary() {
        let text = visible(&"💥".repeat(300), 512);
        assert_eq!(text.len(), 512);
        assert_eq!(text.chars().count(), 128);
        assert_eq!(visible("a\u{7}é", 2), "a");
    }
}
