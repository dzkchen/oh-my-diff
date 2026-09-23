use super::*;
use crate::app_event::AppEvent;
use crate::bottom_pane::SelectionItem;
use crate::bottom_pane::SelectionViewParams;
use crate::bottom_pane::popup_consts::standard_popup_hint_line;
use codex_omd::ModStore;
use ratatui::text::Line;
use ratatui::widgets::Paragraph;

impl ChatWidget {
    pub(crate) fn open_omd_extensions(&mut self) {
        let mut lines = vec![
            Line::from("Extensions".bold()),
            Line::from("Project mod selection takes precedence over the same user mod."),
            Line::from("Changes to mods take effect at the next turn boundary."),
        ];
        let mut items = Vec::new();
        let runtime = crate::omd::mod_status();
        if let Some(root) = crate::omd::mod_paths().and_then(|paths| paths.store) {
            lines.push(Line::from(format!("Mod store {}", root.display())));
            lines.push(Line::from(
                "Update preview: omd-mod package-plan STORE REQUEST_JSON",
            ));
            lines.push(Line::from(
                "Broken mod recovery: disable it here or use omd-mod package-disable STORE ID.",
            ));
            match ModStore::open(root).and_then(|store| store.selection_status()) {
                Ok(status) => {
                    for selection in status["selections"].as_array().into_iter().flatten() {
                        let path = selection["path"].as_str().map(PathBuf::from);
                        let id = selection["id"].as_str().unwrap_or("unreadable_mod");
                        let scope = selection["scope"].as_str().unwrap_or("unknown");
                        let enabled = selection["selected"] == true;
                        let managed = selection["managed"] == true;
                        let reason = selection["error"]
                            .as_str()
                            .or_else(|| selection["reason"].as_str())
                            .unwrap_or("unknown");
                        let prior_failure = runtime.as_ref().and_then(|runtime| {
                            runtime["rejected"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .find(|item| item["path"] == selection["path"])
                                .and_then(|item| item["reason"].as_str())
                                .or_else(|| {
                                    runtime["mods"]
                                        .as_array()
                                        .into_iter()
                                        .flatten()
                                        .find(|item| item["id"] == selection["id"])
                                        .and_then(|item| item["error"].as_str())
                                })
                        });
                        let Some(path) = path else {
                            continue;
                        };
                        let label = format!(
                            "{} {id} ({scope})",
                            if enabled { "Disable" } else { "Enable" }
                        );
                        let mut description = format!(
                            "{} · {} · {reason} · {}",
                            if enabled { "selected" } else { "disabled" },
                            if managed { "managed" } else { "local" },
                            path.display()
                        );
                        if let Some(failure) = prior_failure {
                            description.push_str(&format!(" · last runtime: {failure}"));
                        }
                        let id = id.to_owned();
                        items.push(SelectionItem {
                            name: label,
                            description: Some(description),
                            is_disabled: !enabled && !selection["error"].is_null(),
                            disabled_reason: (!enabled && !selection["error"].is_null())
                                .then(|| reason.to_owned()),
                            require_explicit_confirmation: true,
                            actions: vec![Box::new(move |tx| {
                                tx.send(AppEvent::OmdModToggle {
                                    id: id.clone(),
                                    path: path.clone(),
                                    managed,
                                    enabled: !enabled,
                                });
                            })],
                            dismiss_on_select: true,
                            ..Default::default()
                        });
                    }
                }
                Err(error) => lines.push(Line::from(format!("Mod status unavailable: {error}"))),
            }
        } else {
            lines.push(Line::from("Mod store is not configured in this session."));
        }
        items.push(SelectionItem {
            name: "Plugins".to_string(),
            description: Some(
                "Installed and active state, details and toggles in /plugins".to_string(),
            ),
            actions: vec![Box::new(|tx| tx.send(AppEvent::OmdOpenPlugins))],
            dismiss_on_select: true,
            ..Default::default()
        });
        items.push(SelectionItem {
            name: "Skills".to_string(),
            description: Some("Enabled state and toggles in /skills".to_string()),
            actions: vec![Box::new(|tx| tx.send(AppEvent::OpenManageSkillsPopup))],
            dismiss_on_select: true,
            ..Default::default()
        });
        let cwd = self.config.cwd.to_path_buf();
        items.push(SelectionItem {
            name: "Hooks".to_string(),
            description: Some("Effective lifecycle hooks, trust and toggles in /hooks".to_string()),
            actions: vec![Box::new(move |tx| {
                tx.send(AppEvent::FetchHooksList { cwd: cwd.clone() });
            })],
            dismiss_on_select: true,
            ..Default::default()
        });
        self.bottom_pane.show_selection_view(SelectionViewParams {
            view_id: Some("omd-extensions"),
            title: Some("Oh My Diff extensions".to_string()),
            subtitle: Some("On-demand controls; refresh by reopening".to_string()),
            header: Box::new(Paragraph::new(lines)),
            header_gap: 1,
            footer_hint: Some(standard_popup_hint_line()),
            items,
            ..Default::default()
        });
        self.request_redraw();
    }
}
