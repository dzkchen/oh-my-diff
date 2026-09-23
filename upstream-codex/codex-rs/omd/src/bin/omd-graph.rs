use codex_omd::CodeGraph;
use codex_omd::GraphFreshness;
use codex_omd::GraphLimits;
use serde::Serialize;
use std::error::Error;
use std::io;
use std::path::Path;

type AppResult<T> = Result<T, Box<dyn Error>>;

fn print<T: Serialize>(value: &T) -> AppResult<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn ensure_fresh(graph: &CodeGraph, repository: &Path) -> AppResult<()> {
    match graph.freshness(repository)? {
        GraphFreshness::Fresh => Ok(()),
        stale => Err(io::Error::other(format!(
            "graph snapshot is stale; regenerate it: {}",
            serde_json::to_string(&stale)?
        ))
        .into()),
    }
}

fn build(
    repository: &str,
    graph_path: &str,
    identity: &str,
    revision: &str,
) -> AppResult<CodeGraph> {
    let graph = CodeGraph::build(
        Path::new(repository),
        identity.to_string(),
        revision.to_string(),
        GraphLimits::default(),
    )?;
    graph.write(Path::new(graph_path))?;
    Ok(graph)
}

fn run(args: Vec<String>) -> AppResult<()> {
    match args.as_slice() {
        [_, command, repository, graph_path, identity, revision] if command == "build" => {
            print(&build(repository, graph_path, identity, revision)?.repository)
        }
        [_, command, repository, graph_path, html_path, identity, revision] if command == "snapshot" => {
            let graph = build(repository, graph_path, identity, revision)?;
            graph.write_html(Path::new(html_path))?;
            print(&graph.repository)
        }
        [_, command, repository, graph_path, html_path] if command == "html" => {
            let graph = CodeGraph::read(Path::new(graph_path))?;
            ensure_fresh(&graph, Path::new(repository))?;
            graph.write_html(Path::new(html_path))?;
            print(&graph.repository)
        }
        [_, command, repository, graph_path] if command == "validate" => {
            let graph = CodeGraph::read(Path::new(graph_path))?;
            ensure_fresh(&graph, Path::new(repository))?;
            print(&graph.repository)
        }
        [_, command, repository, graph_path, ids @ ..] if command == "select" && !ids.is_empty() => {
            let graph = CodeGraph::read(Path::new(graph_path))?;
            ensure_fresh(&graph, Path::new(repository))?;
            print(&graph.select(ids)?)
        }
        _ => Err(io::Error::other(
            "usage: omd-graph build REPOSITORY GRAPH REPOSITORY_ID REVISION | snapshot REPOSITORY GRAPH HTML REPOSITORY_ID REVISION | html REPOSITORY GRAPH HTML | validate REPOSITORY GRAPH | select REPOSITORY GRAPH NODE_ID [...]",
        )
        .into()),
    }
}

fn main() {
    if let Err(error) = run(std::env::args().collect()) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
