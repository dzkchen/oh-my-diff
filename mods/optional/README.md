# Optional terminal candidates

`omd_theme` and `omd_focus_flow` are separate public-API mod packages that require `omd_workspace`. They are retained for further work and are **not supported release packages**. Neither is listed in the private-preview lock or enabled by installing the default bundle.

The theme offers midnight, paper and high-contrast palettes, semantic colors, and ASCII or Unicode symbols. Focus flow offers an F9 toggle for native compaction of successful completed agent-tool output. Failures, prompts, active work, evidence, the complete transcript and recovery remain native and visible.

Both fail the predeclared responsiveness gate in the [revisit audit](../../.docs/audits/theme-focus-revisit-20260922.md): theme adds 57.708 ms cold activation and 49.697 ms callback p95; focus flow adds 56.641 ms and 49.599 ms. They stay opt-in candidates until a later host cost fix or explicit scope decision. Do not add them to the default preview lock or installer based on these results.
