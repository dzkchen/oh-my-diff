# omd_graph_navigator

Opt-in. `/omd_graph_navigator:graph` opens a searchable list of the live source
code and impact graph from `omd_repository_analysis` (enable both). Typing in
the search field filters, Previous/Next page, and selecting a node inserts its
revalidated graph evidence into the composer, refused when it exceeds 16 KiB.
`graph search QUERY`, `graph next`, `graph previous`, `graph refresh` and
`graph close` work as commands; they hop to the mod's own channel handler, which
calls the analysis service with the session.

Setting: `root` (a repository-relative subdirectory). Capabilities: `commands`,
`services`, `store`, `terminal`, `events`, `composer`.
