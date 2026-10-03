# omd_session_anchor

Development package, not installed in either profile. It replaces compaction to
keep the current task, remaining acceptance work, candidate and check evidence
and unresolved failures, sets the threshold to 80% of the host's effective
compaction limit (leaving it alone when the host passes none), and after each
compaction reminds the agent to recheck those details.

Capabilities: `compaction`, `context`, `lifecycle`, `store`.
