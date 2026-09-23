use super::*;
use crate::app_event::AppEvent;
use crate::bottom_pane::SelectionDescriptionLayout;
use crate::bottom_pane::SelectionItem;
use crate::bottom_pane::SelectionViewParams;
use crate::bottom_pane::popup_consts::standard_popup_hint_line;
use codex_omd::CodeGraph;
use codex_omd::GraphConfidence;
use codex_omd::GraphNode;
use codex_omd::GraphNodeKind;
use ratatui::text::Line;
use ratatui::widgets::Paragraph;

fn node_kind(kind: GraphNodeKind) -> &'static str {
    match kind {
        GraphNodeKind::Module => "module",
        GraphNodeKind::Symbol => "symbol",
        GraphNodeKind::Test => "test",
        GraphNodeKind::Unknown => "unknown",
    }
}

fn confidence(value: GraphConfidence) -> &'static str {
    match value {
        GraphConfidence::Extracted => "extracted",
        GraphConfidence::Inferred => "inferred",
        GraphConfidence::Unknown => "unknown",
    }
}

fn source_link(node: &GraphNode) -> String {
    node.anchor
        .as_ref()
        .map(|anchor| format!("{}:{}", anchor.path.display(), anchor.start_line))
        .unwrap_or_else(|| "unresolved source target".to_string())
}

fn selection_params(graph: &CodeGraph, snapshot: &Path) -> SelectionViewParams {
    let header = Paragraph::new(vec![
        Line::from(format!(
            "{} · {}",
            graph.repository.identity, graph.repository.revision
        )),
        Line::from(format!(
            "{} files · {} nodes · {} relationships",
            graph.sources.len(),
            graph.nodes.len(),
            graph.edges.len()
        )),
        Line::from(format!(
            "Source {} · snapshot {}",
            &graph.repository.source_digest[..12],
            snapshot.display()
        ))
        .dim(),
        Line::from("Enter adds one node and its bounded impact neighborhood to the composer."),
    ]);
    let items = graph
        .nodes
        .iter()
        .map(|node| {
            let selected_id = node.id.clone();
            let packet = graph.selection_prompt(std::slice::from_ref(&selected_id));
            let relationships = graph
                .edges
                .iter()
                .filter(|edge| edge.from == node.id || edge.to == node.id)
                .collect::<Vec<_>>();
            let extracted = relationships
                .iter()
                .filter(|edge| edge.confidence == GraphConfidence::Extracted)
                .count();
            let inferred = relationships
                .iter()
                .filter(|edge| edge.confidence == GraphConfidence::Inferred)
                .count();
            let unknown = relationships
                .iter()
                .filter(|edge| edge.confidence == GraphConfidence::Unknown)
                .count();
            let description = format!(
                "{} · {} · {} extracted / {} inferred / {} unknown",
                node_kind(node.kind),
                source_link(node),
                extracted,
                inferred,
                unknown
            );
            let search_value = relationships
                .iter()
                .map(|edge| {
                    format!(
                        "{} {} {} {}",
                        edge.from,
                        edge.to,
                        confidence(edge.confidence),
                        edge.detail
                    )
                })
                .chain(std::iter::once(description.clone()))
                .collect::<Vec<_>>()
                .join(" ");
            SelectionItem {
                name: node.name.clone(),
                description: Some(description),
                search_value: Some(search_value),
                is_disabled: packet.is_err(),
                disabled_reason: packet.as_ref().err().map(ToString::to_string),
                actions: packet
                    .ok()
                    .map(|prompt| {
                        vec![Box::new(move |tx: &AppEventSender| {
                            tx.send(AppEvent::OmdGraphSelection {
                                prompt: prompt.clone(),
                            });
                        })
                            as crate::bottom_pane::SelectionAction]
                    })
                    .unwrap_or_default(),
                dismiss_on_select: true,
                ..Default::default()
            }
        })
        .collect();
    SelectionViewParams {
        view_id: Some("omd-code-graph"),
        title: Some("Oh My Diff code/impact graph".to_string()),
        subtitle: Some(
            "Search symbols, modules, tests, source paths, or relationship confidence".to_string(),
        ),
        header: Box::new(header),
        items,
        is_searchable: true,
        search_placeholder: Some("Type to filter graph evidence...".to_string()),
        description_layout: SelectionDescriptionLayout::HideWhenNarrow {
            min_description_width: 34,
        },
        footer_hint: Some(standard_popup_hint_line()),
        ..Default::default()
    }
}

impl ChatWidget {
    pub(super) fn open_omd_graph(&mut self) {
        let (graph, path) = match crate::omd::load_graph(self.config.cwd.as_path()) {
            Ok(value) => value,
            Err(error) => {
                self.add_error_message(format!("Oh My Diff graph unavailable: {error}"));
                return;
            }
        };
        self.bottom_pane
            .show_selection_view(selection_params(&graph, &path));
        self.request_redraw();
    }

    pub(crate) fn insert_omd_graph_selection(&mut self, prompt: &str) {
        if !self.bottom_pane.composer_is_empty() {
            self.insert_str("\n");
        }
        self.insert_str(prompt);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_omd::GraphLimits;
    use std::fs;

    #[test]
    fn navigator_uses_the_canonical_graph_for_search_and_selection() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("lib.rs"),
            "pub fn entry() { helper(); }\nfn helper() {}\n",
        )
        .unwrap();
        let graph = CodeGraph::build(
            temp.path(),
            "fixture/repository".to_string(),
            "fixture-revision".to_string(),
            GraphLimits::default(),
        )
        .unwrap();
        let params = selection_params(&graph, &temp.path().join("graph.json"));
        assert!(params.is_searchable);
        assert_eq!(params.items.len(), graph.nodes.len());
        let entry = params
            .items
            .iter()
            .find(|item| item.name == "entry")
            .unwrap();
        assert!(!entry.is_disabled);
        assert!(entry.description.as_deref().unwrap().contains("inferred"));
        assert_eq!(entry.actions.len(), 1);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        entry.actions[0](&AppEventSender::new(tx));
        let AppEvent::OmdGraphSelection { prompt } = rx.try_recv().unwrap() else {
            panic!("selection should emit graph evidence")
        };
        assert!(prompt.contains("fixture-revision"));
        assert!(prompt.contains("source_digest"));
    }
}
