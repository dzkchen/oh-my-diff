use super::*;
use codex_omd::peers::BrokerSeal;
use codex_omd::peers::Endpoint;
use codex_omd::peers::Peers;
use std::time::Duration;

const POLL: Duration = Duration::from_secs(1);
const DEFAULT_TTL_MS: u64 = 60_000;

/// Peer registrations by lead thread; a session registers only while a mod holds a peers grant.
#[derive(Default)]
pub(super) struct Registry {
    sessions: Mutex<BTreeMap<String, Arc<Peers>>>,
}

fn endpoints(runtime: &ModHost) -> Vec<Endpoint> {
    runtime
        .owners()
        .into_iter()
        .filter_map(|(id, _)| {
            let grants = runtime.grants(&id)?;
            let access = grants.peer_access?;
            Some(Endpoint {
                package: id,
                sha256: grants.source_sha256,
                projects: access.projects,
            })
        })
        .collect()
}

impl Registry {
    fn session(&self, lead: &Lead, endpoints: &[Endpoint]) -> Result<Arc<Peers>, String> {
        let thread = lead.thread.to_string();
        let mut sessions = self.sessions.lock().map_err(|_| "peer_registry_poisoned")?;
        if let Some(peers) = sessions.get(&thread) {
            return Ok(peers.clone());
        }
        let peers = Arc::new(
            Peers::open(&lead.host.root, &thread, &lead.host.repository)
                .map_err(|error| error.to_string())?,
        );
        peers.publish(endpoints).map_err(|error| error.to_string())?;
        sessions.insert(thread, peers.clone());
        Ok(peers)
    }

    fn close(&self, thread: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(thread);
        }
    }

    pub(super) fn call(
        &self,
        lead: &Lead,
        caller: &operations::Caller<'_>,
        request: ModHostCall,
        endpoints: Vec<Endpoint>,
    ) -> Result<Value, String> {
        if lead.owner != "lead" {
            return Err("peers_lead_only: agent threads have no peer session".into());
        }
        let endpoint = endpoints
            .iter()
            .find(|endpoint| endpoint.package == caller.id)
            .cloned()
            .ok_or("grant_expired: peers")?;
        let peers = self.session(lead, &endpoints)?;
        let arguments = &request.arguments;
        let package = arguments
            .get("package")
            .and_then(Value::as_str)
            .unwrap_or(caller.id)
            .to_owned();
        match request.operation.as_str() {
            "peers.list" => peers
                .list(&endpoint, &package)
                .map(|sessions| json!({"session": peers.session(), "peers": sessions}))
                .map_err(|error| error.to_string()),
            "peers.send" => {
                let to = arguments["to"].as_str().ok_or("peer_address_invalid")?;
                peers
                    .send(
                        &BrokerSeal,
                        &endpoint,
                        to,
                        &package,
                        arguments.get("data").cloned().unwrap_or(Value::Null),
                        arguments["correlation"].as_str().map(str::to_owned),
                        arguments["ttl_ms"].as_u64().unwrap_or(DEFAULT_TTL_MS),
                    )
                    .map_err(|error| error.to_string())
            }
            operation => Err(format!("unsupported_host_operation: {operation}")),
        }
    }
}

pub(super) async fn current_endpoints(core: &Core) -> Vec<Endpoint> {
    let runtime = core.runtime.clone();
    tokio::task::spawn_blocking(move || runtime.lock().map(|runtime| endpoints(&runtime)).unwrap_or_default())
        .await
        .unwrap_or_default()
}

/// Delivers inbox messages and receipts for one lead thread until its session ends.
pub(super) fn start(core: &Arc<Core>, thread: ThreadId) {
    let core = core.clone();
    tokio::spawn(async move {
        let mut published = Vec::new();
        loop {
            tokio::time::sleep(POLL).await;
            let Some(lead) = core.expansion.lead(thread) else {
                core.peering.close(&thread.to_string());
                return;
            };
            if !core.expansion.peers.load(Ordering::Acquire) {
                core.peering.close(&thread.to_string());
                published.clear();
                continue;
            }
            let endpoints = current_endpoints(&core).await;
            if endpoints.is_empty() {
                core.peering.close(&thread.to_string());
                published.clear();
                continue;
            }
            let peers = match core.peering.session(&lead, &endpoints) {
                Ok(peers) => peers,
                Err(error) => {
                    core.views.diagnostic(&core.host, "peers", Some(error));
                    continue;
                }
            };
            if published != endpoints {
                if let Err(error) = peers.publish(&endpoints) {
                    core.views
                        .diagnostic(&core.host, "peers", Some(error.to_string()));
                }
                published = endpoints.clone();
            }
            if let Err(error) = deliver(&core, &lead, &peers, &endpoints).await {
                core.views.diagnostic(&core.host, "peers", Some(error));
            }
        }
    });
}

async fn deliver(
    core: &Arc<Core>,
    lead: &Lead,
    peers: &Arc<Peers>,
    endpoints: &[Endpoint],
) -> Result<(), String> {
    let receiving = peers.clone();
    let inbound = tokio::task::spawn_blocking(move || receiving.receive(&BrokerSeal))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    for message in inbound.into_iter().map(|inbound| inbound.message) {
        let package = message["to"]["package"].as_str().unwrap_or_default().to_owned();
        let (status, reason) = match endpoints.iter().find(|endpoint| endpoint.package == package) {
            None => ("refused", Some("package_unavailable".to_owned())),
            Some(endpoint) if !peers.admits(endpoint, &message) => {
                ("refused", Some("peer_scope_denied".to_owned()))
            }
            Some(_) => receive(core, lead, &package, &message).await,
        };
        let replying = peers.clone();
        let _ = tokio::task::spawn_blocking(move || {
            replying.receipt(&BrokerSeal, &message, status, reason)
        })
        .await;
    }
    let settling = peers.clone();
    let receipts = tokio::task::spawn_blocking(move || settling.receipts(&BrokerSeal))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    for (package, receipt) in receipts {
        expansion::invoke_one(core, lead, package, "peer_receipt", receipt).await;
    }
    Ok(())
}

/// Runs `peer_receive` interceptors, then hands the message to its package as untrusted data.
pub(super) async fn receive(
    core: &Arc<Core>,
    lead: &Lead,
    package: &str,
    message: &Value,
) -> (&'static str, Option<String>) {
    let mut input = json!({"id": message["id"], "from": message["from"], "to": message["to"],
        "correlation": message["correlation"], "untrusted": true, "data": message["data"]});
    let (runtime, id) = (core.runtime.clone(), package.to_owned());
    let (required, registered) = tokio::task::spawn_blocking(move || {
        runtime
            .lock()
            .map(|runtime| {
                (
                    runtime.intercepts("peer_receive"),
                    runtime.registered(&id, "peer_message"),
                )
            })
            .unwrap_or((None, false))
    })
    .await
    .unwrap_or((None, false));
    if !registered {
        return ("refused", Some("no_peer_message_handler".to_owned()));
    }
    if let Some(required) = required {
        let chain = intercept::chain(
            core.clone(),
            Arc::new(lead.clone()),
            core.runtime.clone(),
            "peer_receive",
            required,
            input.clone(),
            json!({"caller": "peer", "thread_id": lead.thread.to_string()}),
            Arc::new(AtomicBool::new(false)),
            |effective| Ok(json!({"data": effective["data"]})),
        )
        .await;
        match chain {
            Err(error) => return ("refused", Some(format!("peer_receive_failed: {error}"))),
            Ok(chain) => {
                if let Some(reason) = chain.result["deny"].as_str() {
                    return ("refused", Some(reason.chars().take(512).collect()));
                }
                input["data"] = chain.result["data"].clone();
            }
        }
    }
    input["sent_at_ms"] = message["sent_at_ms"].clone();
    match expansion::invoke_one(core, lead, package.to_owned(), "peer_message", input).await {
        Some(Err(error)) => ("failed", Some(error.chars().take(512).collect())),
        _ => ("delivered", None),
    }
}
