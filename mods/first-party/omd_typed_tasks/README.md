# Typed tasks

Required result fields and required schema declarations must be own properties;
inherited names such as `constructor` do not satisfy a requirement.

`omd_typed_tasks` uses API `0.2.0-experimental.5` for bounded isolated workers with typed JSON results. `run` admits up to four tasks and persists the batch; `advance` validates results before requesting checks, review or integration; `cancel` releases remaining workers while retaining completed results and already integrated work.

The selected workflow must have an initialized immutable acceptance document. Read-only workers use a frozen candidate. Editing workers additionally require a configured executable `check` and a distinct authorized `review_route`. All typed results must validate before any editing result advances to its checks. Source references, the candidate and acceptance digests bind subsequent receipts. A host refusal, missing handle or interrupted batch never becomes successful integration or an automatic retry.

`run`, `advance` and `cancel` take an `operation_id` and the batch `expected_revision` (0 before the first run) and keep the newest 16 operation receipts with the batch, like `omd_workflow`: a retried call returns its committed result, conflicting reuse or a stale revision is refused, and a retry of an interrupted admission records it as interrupted and cancels this thread's typed workers instead of spawning them again. A review receipt or integration already recorded by the host is reused, never repeated. Each batch records the workflow checkpoint revision it was admitted against, which every worker prompt also states.

Activation grants no provider access. Configure host routes and limits separately, and select the workflow contract explicitly. Batch 2.55 runner acceptance covers typed validation, reviewed integration and interrupted batches; installed-profile and native workflow parity remain open.
