# Admission and interception

Use it when a policy mod controls which other packages load, withholds host namespaces from them, or watches and
intercepts other mods' host operations. The interceptor chain itself (order, `required`, `next`) is described in
[Interceptors](interceptors.md#apiintercept).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](stability-and-migration.md#experimental-entries-in-the-registry)). Runs on Apple Silicon macOS.

## Admission and API policy (`admission_api_policy_v1`)

A policy mod controls which other packages load. It needs the `policy` authority grant, declared in the manifest as
`policy: {namespaces}` (up to 16 patterns, `*` wildcards). At every reload, after the native trust, digest and
dependency checks, the host passes each other active package to the `admission` interceptors with this input:

```ts
{package: {id, version, sha256, source, scope, capabilities, dependencies, requires, services, registrations, source_use},
 reason: 'load'}
```

`source_use` is what the package's source calls.

An `admission` interceptor answers in one of three ways:

- `next(e)` admits the package.
- `{deny: reason}` refuses it (`admission_denied`, listed in status `rejected`). Packages that depend on or require a
  refused package, or import a service only it provides, are refused with `dependency_not_admitted`.
- `{withhold: [namespace]}` admits the package without those host namespaces; its calls there fail with
  `capability_withheld: <namespace>`. A namespace is an operation's prefix (`exec`, `workspace`, `http`, `agents`,
  ...) or `service:<name>/<method>` for a service call. Each withheld namespace must match a pattern in the
  `policy.namespaces` of the policy mods, or the decision fails with `admission_policy_invalid`.

### Admission rules

Admission runs without host operations. An outer handler may only tighten the decision beneath it, so an ordinary
handler cannot undo a required one.

- Policy mods and their dependencies are never judged and cannot judge themselves.
- Decisions are cached by the package and policy digests, so changed content is judged again.
- A failing, timed-out or faulted required admission interceptor refuses every judged package with
  `admission_policy_unavailable`. Disabling or reloading the policy mod in `/omd` (or with `omd-mod
  disable`) restores the refused packages. An expired or revoked `policy` grant stops judging.
- The `policy` grant gives a policy mod no authority of its own. It cannot add capabilities, issue or widen grants,
  change broker or managed policy, or reach authority operations, which are not host operations.
- Approving a command that the user's own execpolicy rules forbid needs the `approve.override` grant (see
  [forbidden commands](app-bridge-and-approvals.md#forbidden-commands-and-non-delegable-requests)). Managed rules are
  never overridable.

## `host_operation` interceptors

Host and service calls are intercepted with `api.intercept('host_operation')` (`middleware`). Inputs contain
`{operation, namespace, arguments}`, so `match: {namespace: 'http'}` or `{namespace: /^service:/}` selects by
namespace.

`next.origin` names the actual `caller`, the service `provider` when a provider makes the call on someone's behalf,
and the caller `chain`; the host sets them and a mod cannot.

Interception covers every host operation and service call, including nested provider calls, with two exceptions:

- calls made inside an interceptor callback;
- `sessions.*` and `evidence.*` calls.

Pure SDK functions and local rendering are not host operations, so they are never intercepted.

## `host_operation` middleware event

Experimental.

The `host_operation` middleware event (`middleware`) reports every other mod's host call as `{phase, caller,
operation}` plus `arguments` before, and `result` or `error` after.

For `store.*`, `environment.read`, `credentials.*`, `http.*`, `exec.*`, `sessions.*` and `evidence.*` the
`arguments` and `result` are `null` and an error is `private_operation_failed`; the operation, caller and whether
it failed stay visible. Other operations are shown in full.

Masking applies to the event only: a `host_operation` interceptor still receives the `arguments` and answer of the
calls it matches, except `sessions.*` and `evidence.*`, which are never intercepted.

Because a `host_operation` interceptor sees unmasked arguments and answers, trust, install and status list
`middleware` in the grant exposure text. `middleware` is not an authority grant, so it doesn't expire.
