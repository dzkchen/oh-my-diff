use super::Result;
use super::code_cache::CodeCache;
use super::failure;
use serde_json::Value;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
use std::process::ChildStdin;
use std::process::ChildStdout;
use std::process::Command;
use std::process::Stdio;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;

/// The runner installed beside the host executable, as release artifacts and cargo targets lay them out.
pub(super) fn runner_path() -> Result<PathBuf> {
    let host = std::env::current_exe()?.canonicalize()?;
    let runner = host.with_file_name("omd-runner");
    match runner.canonicalize() {
        Ok(runner) if runner.is_file() => Ok(runner),
        _ => Err(failure(format!(
            "runner_unavailable: {} is missing; reinstall Oh My Diff",
            runner.display()
        ))),
    }
}

fn sandboxed(program: &Path) -> Result<Command> {
    if !cfg!(target_os = "macos") {
        return Err(failure("unsupported_platform: mods require macOS Seatbelt"));
    }
    let literal = serde_json::to_string(program)?;
    let profile = format!(
        "(version 1)(deny default)(allow process-exec (literal {literal}))(allow process-info* (target self))(allow sysctl-read)(allow signal (target self))(allow file-read* (literal \"/\")(literal {literal})(subpath \"/System/Library\")(subpath \"/usr/lib\")(literal \"/dev/null\")(literal \"/dev/urandom\")(literal \"/dev/random\"))(allow file-write* (literal \"/dev/null\"))"
    );
    let mut command = Command::new("/usr/bin/sandbox-exec");
    command
        .args(["-p", &profile])
        .arg(program)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .current_dir("/");
    Ok(command)
}

type Spares = (Vec<Child>, Option<Instant>);

static SPARES: Mutex<Spares> = Mutex::new((Vec::new(), None));
const BUSY_RUNNERS: usize = 3;
const IDLE_AFTER: Duration = Duration::from_secs(5);

/// Stops a runner, reporting whether the memory watchdog had already killed it.
fn stop(mut child: Child) -> bool {
    let exceeded = untrack(child.id());
    let _ = child.kill();
    let _ = child.wait();
    exceeded
}

const MEMORY_LIMIT: u64 = 512 << 20;
const MEMORY_POLL: Duration = Duration::from_millis(50);
/// Live runner pids `(exceeded, reaped)`; signals and reaps both happen under this lock, so a reused pid is never killed.
static TRACKED: Mutex<BTreeMap<u32, (bool, bool)>> = Mutex::new(BTreeMap::new());

fn untrack(pid: u32) -> bool {
    TRACKED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(&pid)
        .is_some_and(|(exceeded, _)| exceeded)
}

/// `try_wait` under the watchdog's lock: whether the runner has exited (or cannot be polled).
fn exited(child: &mut Child) -> bool {
    let mut tracked = TRACKED.lock().unwrap_or_else(PoisonError::into_inner);
    let exited = !matches!(child.try_wait(), Ok(None));
    if exited && let Some((_, reaped)) = tracked.get_mut(&child.id()) {
        *reaped = true;
    }
    exited
}

fn memory_failure() -> std::io::Error {
    failure(format!(
        "mod_out_of_memory: the mod's runner exceeded {} MiB of memory",
        MEMORY_LIMIT >> 20
    ))
}

#[cfg(target_os = "macos")]
fn footprint(pid: u32) -> Option<u64> {
    let mut info = std::mem::MaybeUninit::<libc::rusage_info_v4>::zeroed();
    // SAFETY: `info` is a writable `rusage_info_v4`, the size `RUSAGE_INFO_V4` asks for.
    let status = unsafe {
        libc::proc_pid_rusage(
            pid as libc::c_int,
            libc::RUSAGE_INFO_V4,
            info.as_mut_ptr().cast(),
        )
    };
    // SAFETY: a zero status filled `info`.
    (status == 0).then(|| unsafe { info.assume_init() }.ri_lifetime_max_phys_footprint)
}

/// Runners exist only on macOS (`command`).
#[cfg(not(target_os = "macos"))]
fn footprint(_pid: u32) -> Option<u64> {
    None
}

/// Checked on every reply because a callback can allocate and answer between two watchdog polls.
fn overran(child: &Child) -> bool {
    footprint(child.id()).is_some_and(|bytes| bytes > MEMORY_LIMIT)
}

/// The V8 heap flag does not bound ArrayBuffers, so one shared thread kills any runner whose peak physical footprint passes `MEMORY_LIMIT`.
fn track(child: &Child) {
    static WATCHDOG: std::sync::Once = std::sync::Once::new();
    TRACKED
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(child.id(), (false, false));
    WATCHDOG.call_once(|| {
        std::thread::spawn(|| {
            loop {
                std::thread::sleep(MEMORY_POLL);
                let mut tracked = TRACKED.lock().unwrap_or_else(PoisonError::into_inner);
                for (pid, (exceeded, _)) in tracked
                    .iter_mut()
                    .filter(|(_, (exceeded, reaped))| !*exceeded && !*reaped)
                {
                    if footprint(*pid).is_some_and(|bytes| bytes > MEMORY_LIMIT) {
                        // SAFETY: an unreaped child's pid cannot be reused, and reaping waits for this lock.
                        unsafe { libc::kill(*pid as libc::pid_t, libc::SIGKILL) };
                        *exceeded = true;
                    }
                }
            }
        });
    });
}

/// Trims the warm pool to one runner after five idle seconds and stops render runners unused for a minute.
fn reap() {
    static REAPER: std::sync::Once = std::sync::Once::new();
    REAPER.call_once(|| {
        std::thread::spawn(|| {
            loop {
                std::thread::sleep(Duration::from_secs(1));
                for runner in retire_warm(|runner| {
                    runner.pinned.is_none() && runner.used.elapsed() >= WARM_IDLE
                }) {
                    runner.stop();
                }
                let surplus = {
                    let Ok(mut spares) = SPARES.lock() else {
                        return;
                    };
                    if spares.1.is_some_and(|last| last.elapsed() >= IDLE_AFTER)
                        && !spares.0.is_empty()
                    {
                        spares.0.split_off(1)
                    } else {
                        Vec::new()
                    }
                };
                for child in surplus {
                    stop(child);
                }
            }
        });
    });
}

fn spawn() -> Result<Child> {
    let runner = runner_path()?;
    super::store::check_runner(&runner)?;
    let child = sandboxed(&runner)?
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    track(&child);
    Ok(child)
}

fn runner() -> Result<Child> {
    let mut spares = SPARES.lock().map_err(|_| failure("mod_runner_poisoned"))?;
    let busy = spares.1.is_some_and(|last| last.elapsed() < IDLE_AFTER);
    spares.1 = Some(Instant::now());
    for child in spares.0.extract_if(.., exited) {
        stop(child);
    }
    let warm = (!spares.0.is_empty()).then(|| spares.0.remove(0));
    while spares.0.len() < if busy { BUSY_RUNNERS } else { 1 } {
        match spawn() {
            Ok(child) => spares.0.push(child),
            Err(_) => break,
        }
    }
    reap();
    warm.map_or_else(spawn, Ok)
}

pub(super) const INPUT_LIMIT: usize = 1_048_576;

fn request_line(request: &impl serde::Serialize) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(request)?;
    if bytes.len() > INPUT_LIMIT {
        return Err(failure("input_limit"));
    }
    bytes.push(b'\n');
    Ok(bytes)
}

/// Package-identity fields a reused runner keeps, so matching requests omit them and stay under the pipe buffer.
const KEPT_FIELDS: [&str; 4] = ["source", "assets", "surface", "field_policies"];

fn kept_digest<R>(request: &R) -> Result<[u8; 32]>
where
    R: for<'a> std::ops::Index<&'a str, Output = Value>,
{
    use sha2::Digest;
    let mut digest = sha2::Sha256::new();
    for field in KEPT_FIELDS {
        digest.update(serde_json::to_vec(&request[field])?);
        digest.update([0]);
    }
    Ok(digest.finalize().into())
}

fn kept_line(request: &impl serde::Serialize) -> Result<Vec<u8>> {
    let mut line = serde_json::to_value(request)?;
    if let Some(fields) = line.as_object_mut() {
        for field in KEPT_FIELDS {
            fields.remove(field);
        }
        fields.insert("kept".into(), serde_json::json!(KEPT_FIELDS));
    }
    request_line(&line)
}

fn lines(stdout: ChildStdout) -> (mpsc::Receiver<Vec<u8>>, std::thread::JoinHandle<()>) {
    let (sender, lines) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut stdout = BufReader::new(stdout);
        loop {
            let mut line = Vec::new();
            match (&mut stdout).take(262_145).read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if sender.send(line).is_err() {
                        break;
                    }
                }
            }
        }
    });
    (lines, reader)
}

/// How long a fresh runner may take to report ready; its callback budget starts then.
const RUNNER_START: Duration = Duration::from_secs(10);

#[allow(clippy::too_many_arguments)]
fn converse(
    stdin: &mut ChildStdin,
    lines: &mpsc::Receiver<Vec<u8>>,
    bytes: &[u8],
    cache: Option<&CodeCache>,
    fresh: bool,
    budget: Duration,
    active: &dyn Fn() -> bool,
    host: &mut dyn FnMut(Value) -> Result<Value>,
) -> (Result<Option<Value>>, Instant) {
    let budgeted = || Instant::now() + budget + Duration::from_millis(250);
    let mut deadline = if fresh {
        Instant::now() + RUNNER_START
    } else {
        budgeted()
    };
    if let Err(error) = stdin.write_all(bytes) {
        return (Err(error), deadline);
    }
    let output = loop {
        if !active() {
            break Err(failure("callback_cancelled"));
        }
        let line = match lines.recv_timeout(Duration::from_millis(10)) {
            Ok(line) => line,
            Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() < deadline => continue,
            Err(mpsc::RecvTimeoutError::Timeout) => break Err(failure("callback_timeout")),
            Err(mpsc::RecvTimeoutError::Disconnected) => break Ok(None),
        };
        if line.len() > 262_144 {
            break Err(failure("output_limit"));
        }
        let frame = match serde_json::from_slice::<Value>(&line) {
            Ok(frame) if frame.get("call").is_some() => frame,
            Ok(frame) if frame == serde_json::json!({"ready": true}) => {
                deadline = budgeted();
                continue;
            }
            Ok(frame) if frame.get("code_cache").is_some() => {
                if let Some(cache) = cache {
                    cache.keep(&frame["code_cache"]);
                }
                continue;
            }
            Ok(frame) => break Ok(Some(frame)),
            Err(_) => break Ok(None),
        };
        let started = Instant::now();
        let receipt = match host(frame) {
            Ok(receipt) => receipt,
            Err(error) => break Err(error),
        };
        deadline += started.elapsed();
        let mut receipt = receipt.to_string().into_bytes();
        receipt.push(b'\n');
        if let Err(error) = stdin.write_all(&receipt) {
            break Err(error);
        }
    };
    (output, deadline)
}

struct Warm {
    key: String,
    child: Child,
    stdin: ChildStdin,
    lines: mpsc::Receiver<Vec<u8>>,
    reader: std::thread::JoinHandle<()>,
    errors: std::thread::JoinHandle<Vec<u8>>,
    used: Instant,
    serve: bool,
    /// A mounted component's runner and its owner (`""` for the terminal, else the client): never idle-retired or evicted, only unmounted or retired by a newer package identity.
    pinned: Option<String>,
    born: Instant,
    /// Bytes of the activation request outside its serve fields.
    base: usize,
    /// Digest of the `KEPT_FIELDS` a reused runner holds.
    kept: Option<[u8; 32]>,
}

impl Warm {
    fn stop(self) -> Vec<u8> {
        self.halt().0
    }

    fn halt(self) -> (Vec<u8>, bool) {
        if let Some(owner) = &self.pinned
            && let Ok(mut mounted) = MOUNTED.lock()
        {
            mounted.remove(&(owner.clone(), self.key.clone()));
        }
        let exceeded = stop(self.child);
        let _ = self.reader.join();
        (self.errors.join().unwrap_or_default(), exceeded)
    }

    /// Stops a failed runner; a watchdog kill outranks the failure it caused.
    fn fail(self, error: Option<std::io::Error>) -> std::io::Error {
        match self.halt() {
            (_, true) => memory_failure(),
            (errors, false) => error.unwrap_or_else(|| process_failure(&errors)),
        }
    }
}

/// Stops every pooled and spare runner, so the next callback starts as at launch.
pub(super) fn stop_runners() {
    for runner in retire_warm(|_| true) {
        runner.stop();
    }
    let spares = std::mem::take(&mut SPARES.lock().unwrap_or_else(PoisonError::into_inner).0);
    for child in spares {
        stop(child);
    }
}

/// Live runners other than idle spares, and the sum of their peak physical footprints.
pub(super) fn runner_usage() -> (usize, u64) {
    let spares: Vec<u32> = SPARES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .0
        .iter()
        .map(Child::id)
        .collect();
    let tracked = TRACKED.lock().unwrap_or_else(PoisonError::into_inner);
    let live: Vec<u32> = tracked
        .iter()
        .filter(|(pid, (_, reaped))| !*reaped && !spares.contains(pid))
        .map(|(pid, _)| *pid)
        .collect();
    (live.len(), live.into_iter().filter_map(footprint).sum())
}

pub(super) fn invalidate_warm(key: &str) {
    for runner in retire_warm(|runner| runner.key == key) {
        runner.stop();
    }
}

/// Unmounts that a runner mid-step outside the pool must honour when it returns: owner, key part, time.
static UNMOUNTED: Mutex<Vec<(String, String, Instant)>> = Mutex::new(Vec::new());

fn retire_pinned(owner: &str, part: String) {
    if let Ok(mut unmounted) = UNMOUNTED.lock() {
        unmounted.retain(|(.., at)| at.elapsed() < WARM_IDLE);
        unmounted.push((owner.to_owned(), part.clone(), Instant::now()));
    }
    let mut retired =
        retire_warm(|runner| runner.pinned.as_deref() == Some(owner) && runner.key.contains(&part));
    if retired.is_empty() {
        return;
    }
    if let Ok(mut mounted) = MOUNTED.lock() {
        for runner in &mut retired {
            if let Some(by) = runner.pinned.take() {
                mounted.remove(&(by, runner.key.clone()));
            }
        }
    }
    // Callers hold view and instance locks; the runners are already out of the pool and the mount count.
    std::thread::spawn(move || {
        for runner in retired {
            runner.stop();
        }
    });
}

pub(super) fn unmount(owner: &str, id: &str, component: &str) {
    retire_pinned(owner, format!(":component:{id}:{component}:"));
}

pub(super) fn detach(client: &str) {
    retire_pinned(client, ":component:".to_owned());
}

static WARM: Mutex<Vec<Warm>> = Mutex::new(Vec::new());
/// Every live pinned runner, pooled or mid-step, by owner and key: the cap on a mount.
static MOUNTED: Mutex<BTreeSet<(String, String)>> = Mutex::new(BTreeSet::new());
/// Pinned keys with a step running, so a second step of one instance waits instead of spawning a runner.
static STEPPING: (Mutex<BTreeSet<String>>, Condvar) = (Mutex::new(BTreeSet::new()), Condvar::new());
const WARM_RUNNERS: usize = 4;
const PINNED_RUNNERS: usize = 4;
const REUSED_RUNNERS: usize = 2;
const MAX_REUSED_RUNNERS: usize = 8;
static REUSED_POOL: Mutex<BTreeMap<u64, usize>> = Mutex::new(BTreeMap::new());
const WARM_IDLE: Duration = Duration::from_secs(60);

struct Stepping(Option<String>);

impl Stepping {
    fn enter(key: &str, pinned: bool) -> Self {
        if !pinned {
            return Self(None);
        }
        let (stepping, freed) = &STEPPING;
        let mut stepping = stepping.lock().unwrap_or_else(PoisonError::into_inner);
        while stepping.contains(key) {
            stepping = freed.wait(stepping).unwrap_or_else(PoisonError::into_inner);
        }
        stepping.insert(key.to_owned());
        Self(Some(key.to_owned()))
    }
}

impl Drop for Stepping {
    fn drop(&mut self) {
        if let Some(key) = self.0.take() {
            let (stepping, freed) = &STEPPING;
            stepping
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&key);
            freed.notify_all();
        }
    }
}

/// Registers a new pinned runner, refusing a fifth for its owner and retiring the owner's runner of the same instance under an older package identity.
fn mount(owner: &str, key: &str) -> Result<()> {
    let instance = key.rsplit_once(':').map_or(key, |(instance, _)| instance);
    for stale in retire_warm(|runner| {
        runner.pinned.as_deref() == Some(owner)
            && runner.key != key
            && runner.key.rsplit_once(':').map(|(prefix, _)| prefix) == Some(instance)
    }) {
        stale.stop();
    }
    let mut mounted = MOUNTED
        .lock()
        .map_err(|_| failure("mod_runtime_poisoned"))?;
    if mounted.iter().filter(|(by, _)| by == owner).count() >= PINNED_RUNNERS {
        return Err(failure(format!(
            "component_limit: at most {PINNED_RUNNERS} modules stay mounted at once for the terminal or one client"
        )));
    }
    mounted.insert((owner.to_owned(), key.to_owned()));
    Ok(())
}

fn warm_runner(key: &str, serve: bool) -> Result<Warm> {
    let mut child = runner()?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| failure("missing_stderr"))?;
    let errors = std::thread::spawn(move || {
        let mut stderr = stderr;
        let mut output = Vec::new();
        let mut chunk = [0; 1024];
        while let Ok(count) = stderr.read(&mut chunk) {
            if count == 0 {
                break;
            }
            output.extend_from_slice(&chunk[..count.min(769 - output.len())]);
        }
        output
    });
    let stdin = child.stdin.take().ok_or_else(|| failure("missing_stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| failure("missing_stdout"))?;
    let (lines, reader) = lines(stdout);
    Ok(Warm {
        key: key.to_owned(),
        child,
        stdin,
        lines,
        reader,
        errors,
        used: Instant::now(),
        serve,
        pinned: None,
        born: Instant::now(),
        base: 0,
        kept: None,
    })
}

/// Warm render runners are reused for the same `key` (package, settings and state, everything except the render's own input); other callbacks reuse a runner only of the same package identity, each in a fresh context.
pub(super) fn evaluate_warm<R>(
    key: &str,
    request: &R,
    cache_root: Option<&Path>,
    budget: Duration,
    active: &dyn Fn() -> bool,
    host: &mut dyn FnMut(Value) -> Result<Value>,
) -> Result<Value>
where
    R: serde::Serialize + for<'a> std::ops::Index<&'a str, Output = Value>,
{
    let kept = (request["reuse"] == true)
        .then(|| kept_digest(request))
        .transpose()?;
    let serve = if kept.is_some() {
        request_line(request)?
    } else {
        request_line(
            &[
                "name",
                "payload",
                "receipts",
                "state",
                "ui_state",
                "virtual_time_ms",
            ]
            .map(|field| (field, &request[field]))
            .into_iter()
            .collect::<std::collections::BTreeMap<_, _>>(),
        )?
    };
    let _stepping = Stepping::enter(key, request["event"] == "component");
    let mut reused = WARM.lock().ok().and_then(|mut runners| {
        let index = runners.iter().position(|runner| runner.key == key)?;
        Some(runners.swap_remove(index))
    });
    if let Some(dead) = reused.take_if(|warm| exited(&mut warm.child)) {
        let stateful = dead.serve || dead.pinned.is_some();
        if dead.halt().1 && stateful {
            return Err(memory_failure());
        }
    }
    let mut cache = None;
    let fresh = reused.is_none();
    let (mut warm, bytes) = match reused {
        Some(warm) if kept.is_some() && warm.kept == kept => (warm, kept_line(request)?),
        Some(warm) => {
            // The activation request differs from this one only in the serve fields.
            if warm.base + serve.len() > INPUT_LIMIT + 1 {
                pool(warm);
                return Err(failure("input_limit"));
            }
            (warm, serve)
        }
        None => {
            let bytes = request_line(request)?;
            let pinned = (request["event"] == "component").then(|| {
                request["payload"]["client"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned()
            });
            if let Some(owner) = &pinned {
                mount(owner, key)?;
            }
            let mut warm = match warm_runner(key, request["serve"] == true) {
                Ok(warm) => warm,
                Err(error) => {
                    if let (Some(owner), Ok(mut mounted)) = (&pinned, MOUNTED.lock()) {
                        mounted.remove(&(owner.clone(), key.to_owned()));
                    }
                    return Err(error);
                }
            };
            warm.pinned = pinned;
            warm.base = bytes.len().saturating_sub(serve.len());
            cache = cache_root.and_then(|root| CodeCache::open(root, request));
            (warm, offer(cache.as_ref(), bytes))
        }
    };
    warm.kept = kept;
    let (output, _) = converse(
        &mut warm.stdin,
        &warm.lines,
        &bytes,
        cache.as_ref(),
        fresh,
        budget,
        active,
        host,
    );
    let error = match output {
        Ok(Some(_)) if overran(&warm.child) => {
            warm.stop();
            return Err(memory_failure());
        }
        Ok(Some(value)) if value.get("error").is_none() => {
            pool(warm);
            return Ok(value);
        }
        Ok(Some(value)) => Some(failure(
            value["error"].as_str().unwrap_or("mod_process_failed"),
        )),
        Ok(None) => None,
        Err(error) => Some(error),
    };
    Err(warm.fail(error))
}

/// Keeps one warm callback runner per active package with a `terminal` handler; every host in the process shares the pool, so it fits the host with the most handlers (`None` forgets a host).
pub(super) fn size_reused_pool(host: u64, terminal_handlers: Option<usize>) {
    let mut sizes = REUSED_POOL.lock().unwrap_or_else(PoisonError::into_inner);
    match terminal_handlers {
        Some(count) => sizes.insert(host, count),
        None => sizes.remove(&host),
    };
}

fn reused_pool() -> usize {
    reused_size(&REUSED_POOL.lock().unwrap_or_else(PoisonError::into_inner))
}

fn reused_size(sizes: &BTreeMap<u64, usize>) -> usize {
    sizes
        .values()
        .max()
        .copied()
        .unwrap_or_default()
        .clamp(REUSED_RUNNERS, MAX_REUSED_RUNNERS)
}

fn retire_warm(retire: impl FnMut(&mut Warm) -> bool) -> Vec<Warm> {
    WARM.lock()
        .map(|mut runners| runners.extract_if(.., retire).collect())
        .unwrap_or_default()
}

/// Returns a runner to the pool, stopping the least recently used of its kind beyond that kind's size, or stopping it if unmounted while out of the pool.
fn pool(mut runner: Warm) {
    runner.used = Instant::now();
    let kind = (runner.serve, runner.pinned.clone());
    let size = match kind {
        (_, Some(_)) => usize::MAX,
        (true, None) => WARM_RUNNERS,
        (false, None) => reused_pool(),
    };
    let evicted = match WARM.lock() {
        Ok(mut runners) => {
            let unmounted = kind.1.as_ref().is_some_and(|owner| {
                UNMOUNTED.lock().is_ok_and(|unmounted| {
                    unmounted.iter().any(|(by, part, at)| {
                        by == owner && runner.key.contains(part) && runner.born <= *at
                    })
                })
            });
            if unmounted {
                drop(runners);
                runner.stop();
                return;
            }
            runners.push(runner);
            let mut evicted = Vec::new();
            while runners
                .iter()
                .filter(|runner| (runner.serve, &runner.pinned) == (kind.0, &kind.1))
                .count()
                > size
            {
                let oldest = runners
                    .iter()
                    .enumerate()
                    .filter(|(_, runner)| (runner.serve, &runner.pinned) == (kind.0, &kind.1))
                    .min_by_key(|(_, runner)| runner.used)
                    .map_or(0, |(index, _)| index);
                evicted.push(runners.swap_remove(oldest));
            }
            evicted
        }
        Err(_) => vec![runner],
    };
    for runner in evicted {
        runner.stop();
    }
}

/// Puts the cached modules a fresh runner may use on their own line before its request.
fn offer(cache: Option<&CodeCache>, request: Vec<u8>) -> Vec<u8> {
    match cache.and_then(|cache| cache.line(INPUT_LIMIT)) {
        Some(mut line) => {
            line.extend(request);
            line
        }
        None => request,
    }
}

fn process_failure(errors: &[u8]) -> std::io::Error {
    let errors = String::from_utf8_lossy(errors);
    if errors.contains("heap out of memory") || errors.contains("Reached heap limit") {
        failure("mod_out_of_memory: the mod exceeded its 64 MB heap")
    } else {
        failure(format!(
            "mod_process_failed: {}",
            errors.lines().next().unwrap_or_default()
        ))
    }
}

pub(super) fn evaluate<R>(
    request: &R,
    cache: Option<&Path>,
    budget: Duration,
    active: &dyn Fn() -> bool,
    host: &mut dyn FnMut(Value) -> Result<Value>,
) -> Result<Value>
where
    R: serde::Serialize + for<'a> std::ops::Index<&'a str, Output = Value>,
{
    let cache = cache.and_then(|root| CodeCache::open(root, request));
    let bytes = offer(cache.as_ref(), request_line(request)?);
    let mut child = runner()?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| failure("missing_stderr"))?;
    let errors = std::thread::spawn(move || {
        let mut output = Vec::new();
        let _ = stderr.take(769).read_to_end(&mut output);
        output
    });
    let mut stdin = child.stdin.take().ok_or_else(|| failure("missing_stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| failure("missing_stdout"))?;
    let (lines, reader) = lines(stdout);
    let (output, deadline) = converse(
        &mut stdin,
        &lines,
        &bytes,
        cache.as_ref(),
        true,
        budget,
        active,
        host,
    );
    let overran = overran(&child);
    drop(stdin);
    if output.is_ok() {
        while !exited(&mut child) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    let exceeded = untrack(child.id());
    let _ = child.kill();
    let status = child.wait();
    let _ = reader.join();
    let errors = errors.join().unwrap_or_default();
    if exceeded || overran {
        return Err(memory_failure());
    }
    let output = output?;
    let status = status?;
    let value = output.ok_or_else(|| process_failure(&errors))?;
    if !status.success() || value.get("error").is_some() {
        return Err(failure(
            value["error"].as_str().unwrap_or("mod_process_failed"),
        ));
    }
    Ok(value)
}

#[cfg(test)]
#[path = "process_tests.rs"]
mod tests;
