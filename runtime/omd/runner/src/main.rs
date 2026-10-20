mod crypto;

use serde_json::Map;
use serde_json::Value;
use std::cell::Cell;
use std::cell::RefCell;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::io::BufRead;
use std::io::Write;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Duration;
use std::time::Instant;

const BOOTSTRAP: &str = include_str!("bootstrap.js");
const DISPATCH: &str = include_str!("dispatch.js");
const STEP: &str = include_str!("step.js");
const INPUT_LIMIT: usize = 1_048_576;
const OUTPUT_LIMIT: usize = 262_144;
const CACHE_LIMIT: usize = 1_048_576;
const HEAP_LIMIT: usize = 64 << 20;
const FLAGS: &str = "--single-threaded --no-lazy --disallow-code-generation-from-strings --no-maglev --no-turbolev \
    --no-turbo-inline-array-builtins";

static STARTED: OnceLock<Instant> = OnceLock::new();

struct Compiled {
    code: String,
    data: Vec<u8>,
}

#[derive(Default)]
struct Graph {
    assets: Value,
    base: String,
    modules: Vec<(v8::Global<v8::Module>, String)>,
    linked: Vec<(String, v8::Global<v8::Module>)>,
    aliases: Vec<(String, v8::Global<v8::Module>)>,
    json: Vec<(v8::Global<v8::Module>, String)>,
}

thread_local! {
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static LIVE: Cell<i32> = const { Cell::new(0) };
    static GRAPH: RefCell<Graph> = RefCell::new(Graph::default());
    static CACHE: RefCell<(HashMap<String, Compiled>, VecDeque<String>, usize)> = RefCell::new(Default::default());
}

fn read_line() -> Result<String, &'static str> {
    INPUT.with_borrow_mut(|input| {
        let stdin = std::io::stdin();
        let mut stdin = stdin.lock();
        loop {
            if let Some(end) = input.iter().position(|byte| *byte == b'\n') {
                let line = String::from_utf8_lossy(&input[..end]).into_owned();
                input.drain(..=end);
                return Ok(line);
            }
            if input.len() > INPUT_LIMIT {
                return Err("input_limit");
            }
            let chunk = stdin.fill_buf().map_err(|_| "input_closed")?;
            if chunk.is_empty() {
                let line = String::from_utf8_lossy(input).into_owned();
                input.clear();
                return Ok(line);
            }
            let read = chunk.len();
            input.extend_from_slice(chunk);
            stdin.consume(read);
        }
    })
}

fn write_out(text: &str) -> bool {
    let mut stdout = std::io::stdout().lock();
    stdout
        .write_all(text.as_bytes())
        .and_then(|()| stdout.flush())
        .is_ok()
}

struct Watchdog {
    deadline: Mutex<Option<Instant>>,
    wake: Condvar,
}

impl Watchdog {
    fn start(handle: v8::IsolateHandle) -> Arc<Self> {
        let watchdog = Arc::new(Self {
            deadline: Mutex::new(None),
            wake: Condvar::new(),
        });
        let thread = watchdog.clone();
        std::thread::spawn(move || {
            let mut deadline = thread
                .deadline
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            loop {
                deadline = match *deadline {
                    None => thread
                        .wake
                        .wait(deadline)
                        .unwrap_or_else(|error| error.into_inner()),
                    Some(at) if Instant::now() >= at => {
                        handle.terminate_execution();
                        *deadline = None;
                        deadline
                    }
                    Some(at) => {
                        let wait = at.saturating_duration_since(Instant::now());
                        thread
                            .wake
                            .wait_timeout(deadline, wait)
                            .unwrap_or_else(|error| error.into_inner())
                            .0
                    }
                };
            }
        });
        watchdog
    }

    fn arm(&self, budget: Option<u64>) {
        *self
            .deadline
            .lock()
            .unwrap_or_else(|error| error.into_inner()) =
            budget.map(|ms| Instant::now() + Duration::from_millis(ms));
        self.wake.notify_all();
    }
}

type Reported = Arc<Mutex<Vec<(String, Option<swc_common::Span>)>>>;

struct Diagnostics(Reported);

impl swc_common::errors::Emitter for Diagnostics {
    fn emit(&mut self, diagnostic: &mut swc_common::errors::DiagnosticBuilder<'_>) {
        if let Ok(mut reported) = self.0.lock() {
            reported.push((diagnostic.message(), diagnostic.span.primary_span()));
        }
    }
}

/// Node's code frame for a strip error: the file and line, the line's text and a caret under the span.
fn frame(map: &swc_common::SourceMap, filename: &str, span: swc_common::Span) -> String {
    let start = map.lookup_char_pos(span.lo);
    let Some(text) = start.file.get_line(start.line - 1) else {
        return format!("{filename}:{}\n", start.line);
    };
    let column = start.col_display;
    if column >= text.chars().count() {
        return format!("{filename}:{}\n{text}\n\n", start.line);
    }
    let end = map.lookup_char_pos(span.hi);
    let width = if end.line == start.line {
        end.col_display.saturating_sub(column).max(1)
    } else {
        1
    };
    format!(
        "{filename}:{}\n{text}\n{}{}\n\n",
        start.line,
        " ".repeat(column),
        "^".repeat(width)
    )
}

/// Erases TypeScript types in place, keeping every line and column; non-erasable syntax is an error as in Node.
fn strip(source: &str, filename: &str) -> Result<String, (&'static str, String, String)> {
    use swc_ts_fast_strip::ErrorCode;
    let messages: Reported = Arc::new(Mutex::new(Vec::new()));
    let map: swc_common::sync::Lrc<swc_common::SourceMap> = Default::default();
    let handler = swc_common::errors::Handler::with_emitter(
        true,
        false,
        Box::new(Diagnostics(messages.clone())),
    );
    let options: swc_ts_fast_strip::Options = serde_json::from_value(serde_json::json!({
        "module": true, "filename": filename, "mode": "strip-only", "deprecatedTsModuleAsError": true,
    }))
    .map_err(|error| ("ERR_INVALID_TYPESCRIPT_SYNTAX", error.to_string(), String::new()))?;
    let result = swc_common::GLOBALS.set(&Default::default(), || {
        swc_common::errors::HANDLER.set(&handler, || {
            swc_ts_fast_strip::operate(&map, &handler, source.to_owned(), options)
        })
    });
    result.map(|output| output.code).map_err(|error| {
        let code = match error.code {
            ErrorCode::UnsupportedSyntax => "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX",
            _ => "ERR_INVALID_TYPESCRIPT_SYNTAX",
        };
        let reported = messages
            .lock()
            .map(|reported| reported.clone())
            .unwrap_or_default();
        let located = reported
            .iter()
            .find_map(|(_, span)| *span)
            .map(|span| frame(&map, filename, span))
            .unwrap_or_default();
        let message = reported
            .into_iter()
            .map(|(message, _)| message)
            .collect::<Vec<_>>()
            .join("\n");
        (
            code,
            if message.is_empty() {
                error.message
            } else {
                message
            },
            located,
        )
    })
}

fn string<'s>(scope: &v8::PinScope<'s, '_>, text: &str) -> v8::Local<'s, v8::String> {
    v8::String::new(scope, text).unwrap_or_else(|| v8::String::empty(scope))
}

fn set<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    object: v8::Local<'s, v8::Object>,
    name: &str,
    value: v8::Local<'s, v8::Value>,
) {
    let key = string(scope, name);
    object.set(scope, key.into(), value);
}

fn get<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    object: v8::Local<'s, v8::Object>,
    name: &str,
) -> Option<v8::Local<'s, v8::Value>> {
    let key = string(scope, name);
    object.get(scope, key.into())
}

fn function<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    callback: impl v8::MapFnTo<v8::FunctionCallback>,
) -> v8::Local<'s, v8::Value> {
    v8::Function::new(scope, callback)
        .map(Into::into)
        .unwrap_or_else(|| v8::undefined(scope).into())
}

fn error<'s>(scope: &mut v8::PinScope<'s, '_>, message: &str) -> v8::Local<'s, v8::Value> {
    let message = string(scope, message);
    v8::Exception::error(scope, message)
}

fn throw(scope: &mut v8::PinScope<'_, '_>, message: &str) {
    let exception = error(scope, message);
    scope.throw_exception(exception);
}

fn exchange(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut reply: v8::ReturnValue<v8::Value>,
) {
    let generation = args.data().int32_value(scope).unwrap_or(-1);
    if generation <= 0 || LIVE.get() != generation {
        std::process::exit(1);
    }
    let frame = args.get(0).to_rust_string_lossy(scope);
    if !write_out(&(frame + "\n")) {
        std::process::exit(1);
    }
    match read_line() {
        Ok(line) => reply.set(string(scope, &line).into()),
        Err(_) => std::process::exit(1),
    }
}

fn clock(
    scope: &mut v8::PinScope,
    _: v8::FunctionCallbackArguments,
    mut reply: v8::ReturnValue<v8::Value>,
) {
    let elapsed = STARTED.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0;
    reply.set(v8::Number::new(scope, elapsed).into());
}

fn utf8_length(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut reply: v8::ReturnValue<v8::Value>,
) {
    let length = args
        .get(0)
        .to_string(scope)
        .map_or(0, |text| text.utf8_length(scope));
    reply.set(v8::Number::new(scope, length as f64).into());
}

fn utf8_into(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut reply: v8::ReturnValue<v8::Value>,
) {
    let (Some(text), Ok(destination), Ok(result)) = (
        args.get(0).to_string(scope),
        v8::Local::<v8::Uint8Array>::try_from(args.get(1)),
        v8::Local::<v8::Float64Array>::try_from(args.get(2)),
    ) else {
        reply.set(v8::Boolean::new(scope, false).into());
        return;
    };
    let capacity = destination.byte_length();
    if result.byte_length() < 16 || (capacity > 0 && destination.data().is_null()) {
        reply.set(v8::Boolean::new(scope, false).into());
        return;
    }
    let buffer: &mut [u8] = match capacity {
        0 => &mut [],
        // SAFETY: the view's data pointer covers `capacity` bytes, and V8 writes no more than that.
        _ => unsafe { std::slice::from_raw_parts_mut(destination.data().cast::<u8>(), capacity) },
    };
    let mut read = 0;
    let written = text.write_utf8_v2(
        scope,
        buffer,
        v8::WriteFlags::kReplaceInvalidUtf8,
        Some(&mut read),
    );
    // SAFETY: the result view holds at least two doubles.
    unsafe {
        let counts = result.data().cast::<f64>();
        counts.write_unaligned(read as f64);
        counts.add(1).write_unaligned(written as f64);
    }
    reply.set(v8::Boolean::new(scope, true).into());
}

fn compile<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    source: &str,
    identifier: &str,
    typescript: bool,
) -> Option<v8::Local<'s, v8::Module>> {
    let key = format!("{typescript}:{source}");
    let cached = CACHE.with_borrow(|(entries, ..)| {
        entries
            .get(&key)
            .map(|entry| (entry.code.clone(), entry.data.clone()))
    });
    let (code, data) = match cached {
        Some(entry) => entry,
        None if typescript => match strip(source, identifier) {
            Ok(code) => (code, Vec::new()),
            Err((code, message, located)) => {
                let text = string(scope, &message);
                let exception = v8::Exception::syntax_error(scope, text);
                if let Ok(object) = v8::Local::<v8::Object>::try_from(exception) {
                    let code_value = string(scope, code);
                    set(scope, object, "code", code_value.into());
                    let stack = string(scope, &format!("{located}SyntaxError [{code}]: {message}"));
                    set(scope, object, "stack", stack.into());
                }
                scope.throw_exception(exception);
                return None;
            }
        },
        None => (source.to_owned(), Vec::new()),
    };
    let text = string(scope, &code);
    let name = string(scope, identifier);
    let origin = v8::ScriptOrigin::new(
        scope,
        name.into(),
        0,
        0,
        false,
        0,
        None,
        false,
        false,
        true,
        None,
    );
    let module = if data.is_empty() {
        let mut source = v8::script_compiler::Source::new(text, Some(&origin));
        let compiled = {
            let tc = std::pin::pin!(v8::TryCatch::new(scope));
            let tc = &mut tc.init();
            match v8::script_compiler::compile_module(tc, &mut source) {
                Some(module) => Ok(module),
                None => Err(tc.exception().map(|exception| {
                    let located = tc.message().map_or_else(String::new, |message| {
                        let line = message.get_line_number(tc).unwrap_or(0);
                        let text = message
                            .get_source_line(tc)
                            .map(|text| text.to_rust_string_lossy(tc))
                            .unwrap_or_default();
                        let (start, end) = (message.get_start_column(), message.get_end_column());
                        let caret = "^".repeat(end.saturating_sub(start).max(1));
                        format!(
                            "{identifier}:{line}\n{text}\n{}{caret}\n\n",
                            " ".repeat(start)
                        )
                    });
                    (exception, located)
                })),
            }
        };
        let module = match compiled {
            Ok(module) => module,
            Err(caught) => {
                if let Some((exception, located)) = caught {
                    if let Ok(object) = v8::Local::<v8::Object>::try_from(exception)
                        && let Some(stack) = get(scope, object, "stack")
                    {
                        let stack = located + &stack.to_rust_string_lossy(scope);
                        let stack = string(scope, &stack);
                        set(scope, object, "stack", stack.into());
                    }
                    scope.throw_exception(exception);
                }
                return None;
            }
        };
        let cache = module.get_unbound_module_script(scope).create_code_cache();
        if let Some(cache) = cache {
            remember(key, code, cache.to_vec());
        }
        module
    } else {
        let mut source = v8::script_compiler::Source::new_with_cached_data(
            text,
            Some(&origin),
            v8::script_compiler::CachedData::new(&data),
        );
        v8::script_compiler::compile_module2(
            scope,
            &mut source,
            v8::script_compiler::CompileOptions::ConsumeCodeCache,
            v8::script_compiler::NoCacheReason::NoReason,
        )?
    };
    let global = v8::Global::new(scope, module);
    GRAPH.with_borrow_mut(|graph| graph.modules.push((global, identifier.to_owned())));
    Some(module)
}

fn remember(key: String, code: String, data: Vec<u8>) {
    let bytes = key.len() + code.len() + data.len();
    if bytes > CACHE_LIMIT {
        return;
    }
    CACHE.with_borrow_mut(|(entries, order, total)| {
        while *total + bytes > CACHE_LIMIT {
            let Some(oldest) = order.pop_front() else {
                break;
            };
            if let Some(entry) = entries.remove(&oldest) {
                *total -= oldest.len() + entry.code.len() + entry.data.len();
            }
        }
        order.push_back(key.clone());
        entries.insert(key, Compiled { code, data });
        *total += bytes;
    });
}

fn identifier_of(scope: &v8::PinScope<'_, '_>, module: v8::Local<v8::Module>) -> Option<String> {
    GRAPH.with_borrow(|graph| {
        graph
            .modules
            .iter()
            .find(|(global, _)| v8::Local::new(scope, global) == module)
            .map(|(_, identifier)| identifier.clone())
    })
}

fn json_export<'s>(
    context: v8::Local<'s, v8::Context>,
    module: v8::Local<v8::Module>,
) -> Option<v8::Local<'s, v8::Value>> {
    v8::callback_scope!(unsafe scope, context);
    let text = GRAPH.with_borrow(|graph| {
        graph
            .json
            .iter()
            .find(|(global, _)| v8::Local::new(scope, global) == module)
            .map(|(_, text)| text.clone())
    })?;
    let text = string(scope, &text);
    let value = v8::json::parse(scope, text)?;
    let name = string(scope, "default");
    module.set_synthetic_module_export(scope, name, value)?;
    Some(v8::undefined(scope).into())
}

fn refuse_import<'s>(
    context: v8::Local<'s, v8::Context>,
    _: v8::Local<'s, v8::String>,
    _: v8::Local<'s, v8::FixedArray>,
    _: v8::Local<'s, v8::Module>,
) -> Option<v8::Local<'s, v8::Module>> {
    v8::callback_scope!(unsafe scope, context);
    throw(scope, "unsupported_import");
    None
}

fn refuse_adapter_import<'s>(
    context: v8::Local<'s, v8::Context>,
    _: v8::Local<'s, v8::String>,
    _: v8::Local<'s, v8::FixedArray>,
    _: v8::Local<'s, v8::Module>,
) -> Option<v8::Local<'s, v8::Module>> {
    v8::callback_scope!(unsafe scope, context);
    throw(
        scope,
        "unsupported_import: adapter modules are self-contained",
    );
    None
}

fn refuse_alias_import<'s>(
    context: v8::Local<'s, v8::Context>,
    _: v8::Local<'s, v8::String>,
    _: v8::Local<'s, v8::FixedArray>,
    _: v8::Local<'s, v8::Module>,
) -> Option<v8::Local<'s, v8::Module>> {
    v8::callback_scope!(unsafe scope, context);
    throw(
        scope,
        "unsupported_import: adapter aliases are self-contained",
    );
    None
}

fn resolve<'s>(
    context: v8::Local<'s, v8::Context>,
    specifier: v8::Local<'s, v8::String>,
    _: v8::Local<'s, v8::FixedArray>,
    referrer: v8::Local<'s, v8::Module>,
) -> Option<v8::Local<'s, v8::Module>> {
    v8::callback_scope!(unsafe scope, context);
    let specifier = specifier.to_rust_string_lossy(scope);
    let alias = GRAPH.with_borrow(|graph| {
        graph
            .aliases
            .iter()
            .find(|(name, _)| *name == specifier)
            .map(|(_, module)| module.clone())
    });
    if let Some(alias) = alias {
        return Some(v8::Local::new(scope, alias));
    }
    let importer = identifier_of(scope, referrer).unwrap_or_default();
    let base = GRAPH.with_borrow(|graph| graph.base.clone());
    if (specifier.starts_with("./") || specifier.starts_with("../")) && importer.starts_with(&base)
    {
        let mut parts: Vec<&str> = importer[base.len()..].split('/').collect();
        parts.pop();
        for part in specifier.split('/') {
            if part == ".." {
                if parts.pop().is_none() {
                    break;
                }
            } else if part != "." {
                parts.push(part);
            }
        }
        let name = parts.join("/");
        let linked = GRAPH.with_borrow(|graph| {
            graph
                .linked
                .iter()
                .find(|(linked, _)| *linked == name)
                .map(|(_, module)| module.clone())
        });
        if let Some(module) = linked {
            return Some(v8::Local::new(scope, module));
        }
        let asset = GRAPH.with_borrow(|graph| {
            graph
                .assets
                .get(&name)
                .map(|asset| asset["text"].as_str().unwrap_or_default().to_owned())
        });
        if let Some(text) = asset {
            let identifier = base + &name;
            let module = if name.ends_with(".json") {
                let id = string(scope, &identifier);
                let export = [string(scope, "default")];
                let module = v8::Module::create_synthetic_module(scope, id, &export, json_export);
                let global = v8::Global::new(scope, module);
                GRAPH.with_borrow_mut(|graph| graph.json.push((global, text)));
                module
            } else {
                compile(scope, &text, &identifier, name.ends_with(".ts"))?
            };
            let global = v8::Global::new(scope, module);
            GRAPH.with_borrow_mut(|graph| graph.linked.push((name, global)));
            return Some(module);
        }
    }
    throw(
        scope,
        &format!(
            "unsupported_import: {specifier}; import package assets by relative path, and the SDK by type only"
        ),
    );
    None
}

fn dynamic_import<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    _: v8::Local<'s, v8::Data>,
    _: v8::Local<'s, v8::Value>,
    _: v8::Local<'s, v8::String>,
    _: v8::Local<'s, v8::FixedArray>,
) -> Option<v8::Local<'s, v8::Promise>> {
    let resolver = v8::PromiseResolver::new(scope)?;
    let refusal = error(scope, "unsupported_import: dynamic import");
    resolver.reject(scope, refusal);
    Some(resolver.get_promise(scope))
}

type Thrown<'s> = Option<v8::Local<'s, v8::Value>>;

/// Runs microtasks until `value` settles; with no event loop a promise still pending can never settle.
fn settle<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    value: v8::Local<'s, v8::Value>,
) -> Result<v8::Local<'s, v8::Value>, Thrown<'s>> {
    let Ok(promise) = v8::Local::<v8::Promise>::try_from(value) else {
        return Ok(value);
    };
    scope.perform_microtask_checkpoint();
    if scope.is_execution_terminating() {
        return Err(None);
    }
    match promise.state() {
        v8::PromiseState::Fulfilled => Ok(promise.result(scope)),
        v8::PromiseState::Rejected => Err(Some(promise.result(scope))),
        v8::PromiseState::Pending => {
            eprintln!("Warning: Detected unsettled top-level await");
            std::process::exit(13);
        }
    }
}

fn evaluate<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    module: v8::Local<'s, v8::Module>,
    watchdog: &Watchdog,
    budget: Option<u64>,
) -> Result<v8::Local<'s, v8::Value>, Thrown<'s>> {
    watchdog.arm(budget);
    let result = match module.evaluate(scope) {
        Some(value) => settle(scope, value),
        None => Err(None),
    };
    watchdog.arm(None);
    if result.is_ok() {
        scope.cancel_terminate_execution();
    }
    result
}

fn link<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    module: v8::Local<'s, v8::Module>,
    resolver: impl v8::MapFnTo<v8::ResolveModuleCallback<'s>>,
) -> Result<(), Thrown<'s>> {
    module
        .instantiate_module(scope, resolver)
        .map(drop)
        .ok_or(None)
}

struct Prepared {
    context: v8::Global<v8::Context>,
    bootstrap: v8::Global<v8::Module>,
    generation: i32,
}

/// Every callback takes a context that has never run mod code; the next one is built while the runner idles.
fn prepare(isolate: &mut v8::OwnedIsolate, generation: i32) -> Option<Prepared> {
    v8::scope!(let scope, isolate);
    let context = v8::Context::new(scope, Default::default());
    context.set_allow_generation_from_strings(false);
    let scope = &mut v8::ContextScope::new(scope, context);
    let global = context.global(scope);
    let data = v8::Integer::new(scope, generation);
    let exchange = v8::Function::builder(exchange)
        .data(data.into())
        .build(scope)?;
    set(scope, global, "__exchange", exchange.into());
    let clock = function(scope, clock);
    set(scope, global, "__clock", clock);
    let utf8 = v8::Object::new(scope);
    let length = function(scope, utf8_length);
    set(scope, utf8, "length", length);
    let into = function(scope, utf8_into);
    set(scope, utf8, "into", into);
    set(scope, global, "__utf8", utf8.into());
    GRAPH.with_borrow_mut(|graph| *graph = Graph::default());
    crypto::forget();
    let bootstrap = compile(scope, BOOTSTRAP, "bootstrap", false)?;
    bootstrap.instantiate_module(scope, refuse_import)?;
    Some(Prepared {
        context: v8::Global::new(scope, context),
        bootstrap: v8::Global::new(scope, bootstrap),
        generation,
    })
}

/// The thrown value's stack or text; `None` when the watchdog stopped the mod code that describes it.
fn describe<'s>(scope: &mut v8::PinScope<'s, '_>, thrown: Thrown<'s>) -> Option<String> {
    let Some(thrown) = thrown else {
        return Some("Error: mod_runner_failed".to_owned());
    };
    let tc = std::pin::pin!(v8::TryCatch::new(scope));
    let scope = &mut tc.init();
    let stack = v8::Local::<v8::Object>::try_from(thrown)
        .ok()
        .and_then(|object| get(scope, object, "stack"))
        .filter(|stack| !stack.is_null_or_undefined());
    if scope.has_terminated() {
        return None;
    }
    let text = stack.unwrap_or(thrown).to_rust_string_lossy(scope);
    (!scope.has_terminated()).then_some(text)
}

fn callback<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    global: v8::Local<'s, v8::Object>,
    bootstrap: v8::Local<'s, v8::Module>,
    request: &Value,
    watchdog: &Watchdog,
) -> Result<Option<String>, Thrown<'s>> {
    let budget = request["hook_budget_ms"].as_u64().unwrap_or(1000);
    evaluate(scope, bootstrap, watchdog, Some(budget))?;
    let source = request["source"].as_str().unwrap_or_default();
    let filename = request["filename"].as_str().unwrap_or_default();
    let module = compile(scope, source, filename, true).ok_or(None)?;
    let adapter = &request["surface"]["adapter"];
    let mut adapt: v8::Local<v8::Value> = v8::null(scope).into();
    if adapter.is_object() {
        let source = adapter["source"].as_str().unwrap_or_default();
        let filename = adapter["filename"].as_str().unwrap_or_default();
        let adapter_module = compile(scope, source, filename, true).ok_or(None)?;
        link(scope, adapter_module, refuse_adapter_import)?;
        evaluate(scope, adapter_module, watchdog, Some(budget))?;
        let namespace = v8::Local::<v8::Object>::try_from(adapter_module.get_module_namespace())
            .map_err(|_| None)?;
        adapt = get(scope, namespace, "default").ok_or(None)?;
        if !adapt.is_function() {
            return Err(Some(error(scope, "adapter_default_export_required")));
        }
        for (specifier, alias) in adapter["aliases"].as_object().into_iter().flatten() {
            let filename = alias["filename"].as_str().unwrap_or_default();
            let source = alias["source"].as_str().unwrap_or_default();
            let aliased =
                compile(scope, source, filename, filename.ends_with(".ts")).ok_or(None)?;
            link(scope, aliased, refuse_alias_import)?;
            let aliased = v8::Global::new(scope, aliased);
            GRAPH.with_borrow_mut(|graph| graph.aliases.push((specifier.clone(), aliased)));
        }
    }
    set(scope, global, "__adapt", adapt);
    let omd = get(scope, global, "__omd").ok_or(None)?;
    let omd = v8::Local::<v8::Object>::try_from(omd).map_err(|_| None)?;
    let base = get(scope, omd, "base")
        .ok_or(None)?
        .to_rust_string_lossy(scope);
    let entry = filename.get(base.len()..).unwrap_or_default().to_owned();
    let entry_module = v8::Global::new(scope, module);
    GRAPH.with_borrow_mut(|graph| {
        graph.base = base;
        graph.linked.push((entry.clone(), entry_module));
    });
    link(scope, module, resolve)?;
    let names: Vec<Value> = GRAPH.with_borrow(|graph| {
        graph
            .linked
            .iter()
            .filter(|(name, _)| *name != entry)
            .map(|(name, _)| Value::from(name.as_str()))
            .collect()
    });
    let registrations = get(scope, omd, "registrations").ok_or(None)?;
    let registrations = v8::Local::<v8::Object>::try_from(registrations).map_err(|_| None)?;
    let names = string(scope, &Value::from(names).to_string());
    let names = v8::json::parse(scope, names).ok_or(None)?;
    set(scope, registrations, "modules", names);
    evaluate(scope, module, watchdog, Some(budget))?;
    let namespace =
        v8::Local::<v8::Object>::try_from(module.get_module_namespace()).map_err(|_| None)?;
    let activate = get(scope, namespace, "default").ok_or(None)?;
    set(scope, global, "__activate", activate);
    let dispatch = compile(scope, DISPATCH, "dispatch", false).ok_or(None)?;
    link(scope, dispatch, refuse_import)?;
    evaluate(
        scope,
        dispatch,
        watchdog,
        (request["interactive"] != true).then_some(budget),
    )?;
    let result = get(scope, global, "__result").ok_or(None)?;
    let result = v8::Local::<v8::String>::try_from(result).map_err(|_| None)?;
    if result.length() > OUTPUT_LIMIT {
        return Err(Some(error(scope, "output_limit")));
    }
    let result = result.to_rust_string_lossy(scope);
    let reuse = request["reuse"] == true;
    if request["serve"] != true {
        LIVE.set(0);
        if reuse {
            scope.perform_microtask_checkpoint();
        }
        return Ok(Some(result + if reuse { "\n" } else { "" }));
    }
    let step = compile(scope, STEP, "step", false).ok_or(None)?;
    link(scope, step, refuse_import)?;
    evaluate(scope, step, watchdog, None)?;
    let step = get(scope, global, "__step").ok_or(None)?;
    let step = v8::Local::<v8::Function>::try_from(step).map_err(|_| None)?;
    let mut result = result;
    loop {
        if !write_out(&(result + "\n")) {
            std::process::exit(1);
        }
        let line = read_line().map_err(|refusal| Some(error(scope, refusal)))?;
        if line.is_empty() {
            return Ok(None);
        }
        let line = string(scope, &line);
        let receiver = v8::undefined(scope).into();
        let value = step.call(scope, receiver, &[line.into()]).ok_or(None)?;
        let value = settle(scope, value)?;
        let value = v8::Local::<v8::String>::try_from(value).map_err(|_| None)?;
        if value.length() > OUTPUT_LIMIT {
            return Err(Some(error(scope, "output_limit")));
        }
        result = value.to_rust_string_lossy(scope);
    }
}

/// The error line a failed callback answers with: its own lines and at most four frames inside the package.
fn report(request: &Value, stack: &str) -> String {
    let adapter = &request["surface"]["adapter"];
    let files = [&request["filename"], &adapter["filename"]]
        .into_iter()
        .chain(
            adapter["aliases"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(_, alias)| &alias["filename"]),
        )
        .filter_map(Value::as_str)
        .filter(|file| !file.is_empty());
    let mut directories: Vec<&str> = Vec::new();
    for file in files {
        let directory = &file[..file.rfind('/').unwrap_or(0)];
        if !directories.contains(&directory) {
            directories.push(directory);
        }
    }
    let frame =
        |line: &&str| line.starts_with(char::is_whitespace) && line.trim_start().starts_with("at ");
    let lines: Vec<&str> = stack.split('\n').collect();
    let mut described: Vec<&str> = lines.iter().copied().filter(|line| !frame(line)).collect();
    described.extend(
        lines
            .iter()
            .copied()
            .filter(frame)
            .filter(|line| {
                directories
                    .iter()
                    .any(|directory| line.contains(&format!("{directory}/")))
            })
            .take(4),
    );
    let mut text = described.join("\n");
    for directory in &directories {
        let short = &directory[directory.rfind('/').map_or(0, |at| at + 1)..];
        text = text.replace(&format!("{directory}/"), &format!("{short}/"));
    }
    let units: Vec<u16> = text.encode_utf16().take(768).collect();
    let text = String::from_utf16_lossy(&units);
    serde_json::json!({ "error": text }).to_string()
        + if request["reuse"] == true { "\n" } else { "" }
}

fn run(
    isolate: &mut v8::OwnedIsolate,
    prepared: Prepared,
    request: &Value,
    line: &str,
    watchdog: &Watchdog,
) -> Result<Option<String>, String> {
    v8::scope!(let scope, isolate);
    let context = v8::Local::new(scope, &prepared.context);
    let scope = &mut v8::ContextScope::new(scope, context);
    let tc = std::pin::pin!(v8::TryCatch::new(scope));
    let scope = &mut tc.init();
    let global = context.global(scope);
    let bootstrap = v8::Local::new(scope, &prepared.bootstrap);
    let line = string(scope, line);
    set(scope, global, "__request", line.into());
    if request["environment"]
        .as_array()
        .is_some_and(|names| names.iter().any(|name| name == "crypto"))
    {
        let bridge = crypto::bridge(scope);
        set(scope, global, "__crypto", bridge.into());
    }
    GRAPH.with_borrow_mut(|graph| graph.assets = request["assets"].clone());
    match callback(scope, global, bootstrap, request, watchdog) {
        Ok(output) => Ok(output),
        Err(thrown) => {
            watchdog.arm(None);
            LIVE.set(0);
            let budget = request["hook_budget_ms"].as_u64().unwrap_or(1000);
            let timeout = format!("Error: Script execution timed out after {budget}ms");
            let stack = if scope.is_execution_terminating() {
                timeout
            } else {
                let thrown = thrown.or_else(|| scope.exception());
                watchdog.arm(Some(budget));
                let stack = describe(scope, thrown);
                watchdog.arm(None);
                stack.unwrap_or(timeout)
            };
            scope.cancel_terminate_execution();
            Err(report(request, &stack))
        }
    }
}

unsafe extern "C" fn out_of_memory(_: *const std::ffi::c_char, _: &v8::OomDetails) {
    let _ = std::io::stderr().write_all(
        b"FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n",
    );
    // SAFETY: the heap is exhausted; exit without unwinding or destructors.
    unsafe { libc::_exit(134) };
}

extern "C" fn no_wasm(_: v8::Local<v8::Context>, _: v8::Local<v8::String>) -> bool {
    false
}

fn main() {
    STARTED.get_or_init(Instant::now);
    if v8::icu::set_common_data_77(deno_core_icudata::ICU_DATA).is_err() {
        eprintln!("mod_runner_failed: ICU data");
        std::process::exit(1);
    }
    v8::V8::set_flags_from_string(FLAGS);
    v8::V8::initialize_platform(v8::new_single_threaded_default_platform(false).make_shared());
    v8::V8::initialize();
    let mut isolate = v8::Isolate::new(
        v8::CreateParams::default().set_max_old_generation_size_in_bytes(HEAP_LIMIT),
    );
    isolate.set_oom_error_handler(out_of_memory);
    isolate.set_allow_wasm_code_generation_callback(no_wasm);
    isolate.set_host_import_module_dynamically_callback(dynamic_import);
    isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
    let watchdog = Watchdog::start(isolate.thread_safe_handle());
    let mut generation = 1;
    let mut spare = prepare(&mut isolate, generation);
    let mut kept: Option<Map<String, Value>> = None;
    loop {
        let mut line = match read_line() {
            Ok(line) => line,
            Err(refusal) => {
                eprintln!("Error: {refusal}");
                std::process::exit(1);
            }
        };
        if line.is_empty() {
            break;
        }
        let Ok(mut request) = serde_json::from_str::<Value>(&line) else {
            eprintln!("SyntaxError: invalid runner request");
            std::process::exit(1);
        };
        if let Some(names) = request["kept"].as_array().cloned() {
            let Some(fields) = &mut kept else { break };
            fields.retain(|field, _| names.iter().any(|name| name == field));
            let mut text = String::new();
            for name in names.iter().filter_map(Value::as_str) {
                if let Some(value) = fields.get(name) {
                    request[name] = value.clone();
                    text += &format!(",{}:{value}", Value::from(name));
                }
            }
            line = format!("{}{text}}}", &line[..line.len() - 1]);
        } else if request["reuse"] == true {
            kept = request.as_object().cloned();
        }
        let Some(prepared) = spare.take() else {
            eprintln!("mod_runner_failed: context");
            std::process::exit(1);
        };
        LIVE.set(prepared.generation);
        let reuse = request["reuse"] == true;
        match run(&mut isolate, prepared, &request, &line, &watchdog) {
            Ok(Some(output)) => {
                if !write_out(&output) {
                    std::process::exit(1);
                }
            }
            Ok(None) => {}
            Err(failure) => {
                write_out(&failure);
                std::process::exit(1);
            }
        }
        if !reuse {
            break;
        }
        generation += 1;
        spare = prepare(&mut isolate, generation);
    }
    std::process::exit(0);
}
