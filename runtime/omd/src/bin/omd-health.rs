use codex_omd::GraphLimits;
use codex_omd::HealthBaseline;
use codex_omd::HealthConstraints;
use serde::Serialize;
use std::error::Error;
use std::io;
use std::path::Path;

type AppResult<T> = Result<T, Box<dyn Error>>;

fn print<T: Serialize>(value: &T) -> AppResult<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn run(args: Vec<String>) -> AppResult<bool> {
    match args.as_slice() {
        [_, command, repository, constraints_path, baseline_path, revision]
            if command == "baseline" =>
        {
            let constraints = HealthConstraints::read(Path::new(constraints_path))?;
            let baseline = HealthBaseline::build(
                Path::new(repository),
                &constraints,
                revision.clone(),
                GraphLimits::default(),
            )?;
            baseline.write(Path::new(baseline_path))?;
            print(&baseline)?;
            Ok(false)
        }
        [_, command, repository, constraints_path, baseline_path, report_path, revision]
            if command == "check" =>
        {
            let constraints = HealthConstraints::read(Path::new(constraints_path))?;
            let baseline = HealthBaseline::read(Path::new(baseline_path))?;
            let report = baseline.check(Path::new(repository), &constraints, revision.clone())?;
            report.write(Path::new(report_path))?;
            print(&report)?;
            Ok(report.has_introduced_findings())
        }
        _ => Err(io::Error::other(
            "usage: omd-health baseline REPOSITORY CONSTRAINTS BASELINE REVISION | check REPOSITORY CONSTRAINTS BASELINE REPORT REVISION",
        )
        .into()),
    }
}

fn main() {
    match run(std::env::args().collect()) {
        Ok(true) => std::process::exit(2),
        Ok(false) => {}
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
