//! Draft revisions handed from the terminal to the prompt submission they produced.

use std::collections::BTreeMap;
use std::sync::Mutex;

static SUBMITTED: Mutex<BTreeMap<String, u64>> = Mutex::new(BTreeMap::new());

pub fn submitted(client_id: &str, revision: u64) {
    if let Ok(mut submitted) = SUBMITTED.lock() {
        if submitted.len() >= 64 {
            submitted.clear();
        }
        submitted.insert(client_id.to_owned(), revision);
    }
}

pub fn take(client_id: &str) -> Option<u64> {
    SUBMITTED.lock().ok()?.remove(client_id)
}
