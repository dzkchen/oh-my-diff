---
name: omd-structured-reports
description: Return the exact OMD worker report object for implementation, review, fallback, or escalation work. Use for worker output only when structured_worker_reports is selected; native validation remains authoritative.
---

# OMD structured reports

Return only one JSON object with exactly these fields:

```json
{
  "schema": 1,
  "status": "completed",
  "summary": "Bounded result",
  "scope": ["work actually handled"],
  "uncertainty": [],
  "evidence": [],
  "required_clarification": []
}
```

Use `completed`, `partial`, or `blocked` for `status`. Keep `summary` nonempty and `scope` nonempty. Use unique, nonempty strings in every array. Report all material uncertainty, useful file/check/source evidence, and every clarification the lead must obtain.

Use `blocked` only with at least one required clarification. Use `completed` only with no required clarification. Do not claim that partial or blocked work is integrated or complete.

This skill does not relax the native schema, size limits, integration gate, review gate, or rejection of incomplete reports.
