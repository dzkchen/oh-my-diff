# Typed tasks

`omd_typed_tasks` uses API `0.2.0-experimental.1` for bounded isolated workers with typed JSON results. `run` admits up to four tasks and persists the batch; `advance` validates results before requesting checks, review or integration; `cancel` releases remaining workers while retaining completed results and already integrated work.

The selected workflow must have an initialized immutable acceptance document. Read-only workers use a frozen candidate. Editing workers additionally require a configured executable `check` and a distinct authorized `review_route`. All typed results must validate before any editing result advances to its checks. Source references, the candidate and acceptance digests bind subsequent receipts. A host refusal, missing handle or interrupted batch never becomes successful integration or an automatic retry.

Activation grants no provider access. Configure host routes and limits separately, and select the workflow contract explicitly. Batch 2.55 runner acceptance covers typed validation, reviewed integration and interrupted batches; installed-profile and native workflow parity remain open.
