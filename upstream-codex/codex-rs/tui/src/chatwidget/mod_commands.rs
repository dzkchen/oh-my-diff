use super::*;
use crate::mod_runtime::ModCommandResult;
use crate::mod_runtime::ModSlashCommand;
use ratatui::text::Line;

impl ChatWidget {
    pub(crate) fn run_mod_command(&mut self, command: ModSlashCommand, args: String) {
        let tx = self.app_event_tx.clone();
        let invocation = command.invocation.clone();
        self.add_info_message(format!("Running /{invocation}"), None);
        std::thread::spawn(move || {
            let result = crate::mod_runtime::run(&command.target, &args);
            tx.send(AppEvent::ModCommandFinished { invocation, result });
        });
    }

    pub(crate) fn on_mod_command_finished(
        &mut self,
        invocation: String,
        result: Result<ModCommandResult, String>,
    ) {
        let ModCommandResult { outcome, preview } = match result {
            Ok(result) => result,
            Err(error) => {
                self.add_error_message(format!("/{invocation} failed: {error}"));
                return;
            }
        };
        if let Some(display) = outcome.display {
            let mut lines = vec![Line::from(format!("• /{invocation}")).bold()];
            lines.extend(display.lines().map(|line| Line::from(format!("  {line}"))));
            self.add_plain_history_lines(lines);
        }
        if let Some(insert) = outcome.insert {
            if !self.bottom_pane.composer_is_empty() {
                self.insert_str("\n");
            }
            self.insert_str(&insert);
        }
        if let Some(submit) = outcome.submit {
            self.submit_mod_text(submit);
        }
        if let Some(preview) = preview {
            crate::mod_ui::preview(preview);
        }
        self.request_redraw();
    }

    pub(crate) fn add_mod_activity(&mut self, activity: codex_omd::ModActivity) {
        let line = match activity.status.as_str() {
            "completed" => format!("• Ran {} ({})", activity.label, activity.tool),
            status => format!("• {} {status} ({})", activity.label, activity.tool),
        };
        self.add_plain_history_lines(vec![Line::from(line).dim()]);
    }

    pub(crate) fn submit_mod_text(&mut self, text: String) {
        let user_message = UserMessage::from(text);
        if self.is_session_configured() && !self.turn_lifecycle.agent_turn_running {
            let _ = self.submit_user_message_with_shell_escape_policy(
                user_message,
                ShellEscapePolicy::Disallow,
            );
        } else {
            self.queue_user_message(user_message);
        }
    }
}
