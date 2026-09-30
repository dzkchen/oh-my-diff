# Optional terminal candidates

`omd_focus_flow` is a retained public-API candidate requiring `omd_workspace` and is **not a supported release package**. It is absent from both installation profiles. The selected opt-in theme moved to [`mods/first-party/omd_theme`](../first-party/omd_theme/README.md) and is installed inactive in OMD+; OMD Core users can install it explicitly.

Focus flow offers an F9 toggle for native compaction of successful completed agent-tool output. Failures, prompts, active work, evidence, the complete transcript and recovery remain native and visible.

The [revisit audit](../../.docs/audits/theme-focus-revisit-20260922.md) remains historical rejection evidence: theme added 57.708 ms cold activation and 49.697 ms callback p95; focus flow added 56.641 ms and 49.599 ms. Neither enters the active default. Theme's renewed delivery is selected by Batch 3aa; focus flow stays deferred.
