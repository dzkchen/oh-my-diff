use std::fs::File;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::time::Instant;

static TRACE: LazyLock<Option<Mutex<File>>> = LazyLock::new(|| {
    let path = std::env::var_os("OMD_FRAME_TRACE")?;
    File::options()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .ok()
        .map(Mutex::new)
});

fn cpu() -> u64 {
    let mut time = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    unsafe {
        libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut time);
    }
    time.tv_sec as u64 * 1_000_000_000 + time.tv_nsec as u64
}

pub struct Stage {
    stage: &'static str,
    start: Option<(Instant, u64)>,
}

pub fn stage(name: &'static str) -> Stage {
    Stage {
        stage: name,
        start: TRACE.as_ref().map(|_| (Instant::now(), cpu())),
    }
}

impl Drop for Stage {
    fn drop(&mut self) {
        if let Some((start, before)) = self.start {
            record(
                self.stage,
                start.elapsed().as_nanos(),
                cpu().saturating_sub(before),
            );
        }
    }
}

pub fn waited(name: &'static str, deadline: Instant) {
    if TRACE.is_some() {
        record(name, deadline.elapsed().as_nanos(), 0);
    }
}

fn record(name: &str, wall: u128, used: u64) {
    if let Some(trace) = TRACE.as_ref()
        && let Ok(mut file) = trace.lock()
    {
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |time| time.as_nanos());
        let _ = writeln!(
            file,
            "{{\"stage\":\"{}\",\"wall_ns\":{},\"cpu_ns\":{},\"at_ns\":{}}}",
            name, wall, used, at
        );
    }
}
