use std::io;
use std::process::Command;
use std::time::Duration;
use std::time::Instant;

pub(crate) fn run() -> Option<io::Result<()>> {
    let mut arguments = std::env::args_os().skip(1);
    if arguments.next()?.to_str()? != "--omd-managed-service-v1" {
        return None;
    }
    Some((|| {
        let parent = arguments
            .next()
            .and_then(|v| v.to_str().and_then(|v| v.parse::<i32>().ok()))
            .filter(|v| *v > 1)
            .ok_or_else(|| io::Error::other("invalid_service_parent"))?;
        let seconds = arguments
            .next()
            .and_then(|v| v.to_str().and_then(|v| v.parse::<u64>().ok()))
            .filter(|v| (1..=86400).contains(v))
            .ok_or_else(|| io::Error::other("invalid_service_deadline"))?;
        let program = arguments
            .next()
            .ok_or_else(|| io::Error::other("missing_service_program"))?;
        let group = unsafe { libc::getpgrp() };
        if group != unsafe { libc::getpid() } || unsafe { libc::getppid() } != parent {
            return Err(io::Error::other("service_requires_owned_process_group"));
        }
        let mut child = Command::new(program).args(arguments).spawn()?;
        let deadline = Instant::now() + Duration::from_secs(seconds);
        loop {
            if unsafe { libc::getppid() } != parent
                || Instant::now() >= deadline
                || child
                    .try_wait()
                    .map(|status| status.is_some())
                    .unwrap_or(true)
            {
                unsafe {
                    libc::kill(-group, libc::SIGKILL);
                }
                return Err(io::Error::other("service_group_termination_failed"));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    })())
}
