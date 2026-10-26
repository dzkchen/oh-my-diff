use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::sync::Arc;

fn main() -> std::process::ExitCode {
    let root = PathBuf::from(codex_omd::broker::ROOT);
    let served = codex_omd::broker::listener().and_then(|listener| {
        if std::env::args().nth(1).as_deref() == Some("power") {
            let setting = Arc::new(codex_omd::power::Setting::open(
                PathBuf::from(codex_omd::power::PMSET),
                PathBuf::from(codex_omd::power::IOREG),
                PathBuf::from(codex_omd::power::RECORD),
                std::fs::metadata(&root)?.uid(),
            )?);
            setting.serve(listener);
            return Ok(());
        }
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
