use std::path::PathBuf;
use std::sync::Arc;

fn main() -> std::process::ExitCode {
    let root = PathBuf::from(codex_omd::broker::ROOT);
    let served = codex_omd::broker::listener().and_then(|listener| {
        let broker = Arc::new(codex_omd::broker::Broker::open(root.clone())?);
        broker.serve(listener, Arc::new(codex_omd::broker::Pinned::new(&root)));
        Ok(())
    });
    match served {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("omd-broker: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}
