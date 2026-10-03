# omd_recovery

Opt-in; needs `omd_coordination`. When an eligible tool step fails with an
allowed failure class, `recover` escalates it to one bounded read-only advisory
call on `advisory_route` with the exact failing evidence; `advice` returns the
answer and `delegate` hands a repair to the workflow. `outage_action` decides
what happens on a provider outage (`opposite_lead` or `pause`).

`/omd_recovery:outage` shows the outage action and recorded decisions. Settings:
`failure_policy`, `allowed_failure_classes`, `evidence_bytes`, `eligible_tools`,
`outage_action`, `advisory_route`.
