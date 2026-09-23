use super::*;
use crate::app_event::AppEvent;
use crate::bottom_pane::SelectionItem;
use crate::bottom_pane::SelectionViewParams;
use crate::bottom_pane::popup_consts::standard_popup_hint_line;
use ratatui::text::Line;
use ratatui::widgets::Paragraph;

impl ChatWidget {
    pub(super) fn open_omd_inspector(&mut self) {
        let mode = match crate::omd::effective_mode() {
            Ok(mode) => mode,
            Err(error) => {
                self.add_error_message(format!("Oh My Diff mode is invalid: {error}"));
                return;
            }
        };
        if mode.mode == codex_omd::RuntimeMode::UpstreamDirect {
            let mut lines = crate::omd::direct_mode_details(mode)
                .into_iter()
                .map(Line::from)
                .collect::<Vec<_>>();
            lines[0] = lines[0].clone().bold();
            let header = Paragraph::new(lines);
            self.bottom_pane.show_selection_view(SelectionViewParams {
                view_id: Some("omd-inspector"),
                title: Some("Oh My Diff inspector".to_string()),
                subtitle: Some("Effective mode; refresh by reopening /omd".to_string()),
                header: Box::new(header),
                header_gap: 1,
                initial_selected_idx: Some(0),
                footer_hint: Some(standard_popup_hint_line()),
                items: vec![
                    SelectionItem {
                        name: "Extensions".to_string(),
                        description: Some(
                            "Inspect and manage mods, plugins, skills and hooks".to_string(),
                        ),
                        actions: vec![Box::new(|tx| tx.send(AppEvent::OmdOpenExtensions))],
                        dismiss_on_select: true,
                        ..Default::default()
                    },
                    SelectionItem {
                        name: "Close inspector".to_string(),
                        description: Some("Return to the transcript".to_string()),
                        dismiss_on_select: true,
                        ..Default::default()
                    },
                ],
                ..Default::default()
            });
            self.request_redraw();
            return;
        }
        if mode.mode == codex_omd::RuntimeMode::Platform {
            let status = crate::omd::mod_status();
            let active = status
                .as_ref()
                .and_then(|value| value["mods"].as_array())
                .map_or(0, Vec::len);
            let rejected = status
                .as_ref()
                .and_then(|value| value["rejected"].as_array())
                .map_or(0, Vec::len);
            let header = Paragraph::new(vec![
                Line::from("Oh My Diff · Modding platform only".bold()),
                Line::from(crate::omd::install_profile_status()),
                Line::from(format!("Selection {}", mode.source.label())),
                Line::from("Controlled task policy off; user-selected mod host on"),
                Line::from(format!(
                    "{active} active mods · {rejected} rejected selections"
                )),
                Line::from("Use /omd-mod for install, disable, and recovery"),
            ]);
            self.bottom_pane.show_selection_view(SelectionViewParams {
                view_id: Some("omd-inspector"),
                title: Some("Oh My Diff inspector".to_string()),
                subtitle: Some("Effective platform mode; refresh by reopening /omd".to_string()),
                header: Box::new(header),
                header_gap: 1,
                initial_selected_idx: Some(0),
                footer_hint: Some(standard_popup_hint_line()),
                items: vec![
                    SelectionItem {
                        name: "Extensions".to_string(),
                        description: Some(
                            "Inspect and manage mods, plugins, skills and hooks".to_string(),
                        ),
                        actions: vec![Box::new(|tx| tx.send(AppEvent::OmdOpenExtensions))],
                        dismiss_on_select: true,
                        ..Default::default()
                    },
                    SelectionItem {
                        name: "Close inspector".to_string(),
                        description: Some("Return to the transcript".to_string()),
                        dismiss_on_select: true,
                        ..Default::default()
                    },
                ],
                ..Default::default()
            });
            self.request_redraw();
            return;
        }
        let snapshot = match crate::omd::snapshot() {
            Ok(snapshot) => snapshot,
            Err(error) => {
                self.add_error_message(format!("Oh My Diff inspector unavailable: {error}"));
                return;
            }
        };
        let authorization = match snapshot.authorization {
            crate::omd::ContributorAuthorization::Authorized => "authorized",
            crate::omd::ContributorAuthorization::Revoked => "revoked",
            crate::omd::ContributorAuthorization::Invalid => "blocked",
            crate::omd::ContributorAuthorization::Disabled => "disabled",
        };
        let renderer = if crate::omd::ligatures_enabled() {
            "Unicode ligatures (OMD_TUI_ASCII=1 for literal ASCII)"
        } else {
            "literal ASCII"
        };
        let mouse = if crate::omd::mouse_enabled() && crate::omd::fullscreen_active() {
            "click-to-position and copy-on-highlight (OMD_TUI_MOUSE=off to disable)"
        } else if crate::omd::mouse_enabled() {
            "terminal-native selection in inline mode"
        } else {
            "terminal-native selection (OMD_TUI_MOUSE=off)"
        };
        let permissions = self
            .status_line_value(StatusLineItem::Permissions)
            .unwrap_or_else(|| "unknown".to_string());
        let approval = self
            .status_line_value(StatusLineItem::ApprovalMode)
            .unwrap_or_else(|| "unknown".to_string());
        let alternate_screen =
            format!("{:?}", self.local_settings.tui.alternate_screen).to_ascii_lowercase();
        let header = Paragraph::new(vec![
            Line::from("Oh My Diff · OMD enabled".bold()),
            Line::from(crate::omd::install_profile_status()),
            Line::from(format!("Selection {}", mode.source.label())),
            Line::from("Binary Oh My Diff custom binary; disabling OMD does not restore upstream"),
            Line::from(format!(
                "Task {} · {} live / {} archived workers",
                snapshot.task_status, snapshot.live_workers, snapshot.archived_workers
            )),
            Line::from(format!(
                "Allowance {}/{} requests · ${:.6}/${:.6} exposure",
                snapshot.requests_consumed,
                snapshot
                    .requests_consumed
                    .saturating_add(snapshot.requests_remaining),
                snapshot.exposure_consumed_microusd as f64 / 1_000_000.0,
                snapshot
                    .exposure_consumed_microusd
                    .saturating_add(snapshot.exposure_remaining_microusd) as f64
                    / 1_000_000.0,
            )),
            Line::from(format!(
                "Task cost ${:.6} settled charge · ${:.6} retained upper bound · {} raw usage records",
                snapshot.settled_task_charge_microusd as f64 / 1_000_000.0,
                snapshot.retained_exposure_upper_bound_microusd as f64 / 1_000_000.0,
                snapshot.raw_usage_attempts,
            )),
            Line::from(format!(
                "Work path {}",
                if snapshot.direct_single_agent {
                    "direct single-agent; delegation disabled"
                } else {
                    "direct or delegated"
                }
            )),
            Line::from(format!(
                "Capabilities {}",
                if snapshot.selected_capabilities.is_empty() {
                    "none".to_string()
                } else {
                    snapshot.selected_capabilities.join(", ")
                }
            )),
            Line::from(format!("Contributor {authorization}")),
            Line::from(format!("Permissions {permissions} · approvals {approval}")),
            Line::from(format!(
                "Display {} · configured alternate screen {alternate_screen} · {renderer}",
                if crate::omd::fullscreen_active() {
                    "fullscreen"
                } else {
                    "inline"
                }
            )),
            Line::from(format!("Mouse {mouse}")),
            Line::from("Accessibility Ctrl+T transcript · /raw screen-reader mode"),
            Line::from(format!("Evidence {}", snapshot.evidence.display()).dim()),
        ]);
        let can_revoke = snapshot.authorization == crate::omd::ContributorAuthorization::Authorized;
        self.bottom_pane.show_selection_view(SelectionViewParams {
            view_id: Some("omd-inspector"),
            title: Some("Oh My Diff inspector".to_string()),
            subtitle: Some("Effective runtime state; refresh by reopening /omd".to_string()),
            header: Box::new(header),
            header_gap: 1,
            initial_selected_idx: Some(0),
            footer_hint: Some(standard_popup_hint_line()),
            items: vec![
                SelectionItem {
                    name: "Extensions".to_string(),
                    description: Some("Inspect and manage mods, plugins, skills and hooks".to_string()),
                    actions: vec![Box::new(|tx| tx.send(AppEvent::OmdOpenExtensions))],
                    dismiss_on_select: true,
                    ..Default::default()
                },
                SelectionItem {
                    name: "Close inspector".to_string(),
                    description: Some("Return to the transcript".to_string()),
                    dismiss_on_select: true,
                    ..Default::default()
                },
                SelectionItem {
                    name: "Revoke Contributor authorization".to_string(),
                    description: Some(
                        "Create durable revocation evidence and block future Contributor dispatches"
                            .to_string(),
                    ),
                    is_disabled: !can_revoke,
                    disabled_reason: (!can_revoke)
                        .then(|| format!("Contributor authorization is {authorization}")),
                    require_explicit_confirmation: true,
                    actions: vec![Box::new(|tx| {
                        tx.send(AppEvent::OmdContributorRevocation {
                            result: crate::omd::revoke_contributor(),
                        });
                    })],
                    dismiss_on_select: true,
                    ..Default::default()
                },
            ],
            ..Default::default()
        });
        self.request_redraw();
    }
}
