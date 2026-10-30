# Admission and interception

Use it when a policy mod decides which other packages load, withholds host namespaces from them, or watches and
intercepts other mods' host operations. The interceptor chain itself (order, `required`, `next`) is described in
[Interceptors](interceptors.md#apiintercept).

## Admission and API policy (`admission_api_policy_v1`)

`policy` is an authority grant with manifest `policy: {namespaces}` (up to 16 patterns, `*` wildcards). At every
reload, after native trust, digest and dependency checks, each other active package passes the `admission`
interceptors with this input (`source_use` is what the source calls):

```ts
{package: {id, version, sha256, source, scope, capabilities, dependencies, requires, services, registrations, source_use},
 reason: 'load'}
```

An `admission` interceptor answers in one of three ways:

- `next(e)` admits the package.
- `{deny: reason}` refuses it (`admission_denied`, listed in status `rejected`). Packages that depend on or require a
  refused package, or import a service only it provides, are refused with `dependency_not_admitted`.
- `{withhold: [namespace]}` admits the package without those host namespaces; its calls there fail with
  `capability_withheld: <namespace>`. Namespaces are an operation's prefix (`exec`, `workspace`, `http`, `agents`,
  ...) or `service:<name>/<method>` for service calls, and each must match the policy mods' `policy.namespaces`
  (`admission_policy_invalid` otherwise).

### Admission rules

Admission runs without host operations. An outer handler may only tighten the decision beneath it, so an ordinary
handler cannot undo a required one.

- Policy mods and their dependencies are never judged and cannot judge themselves.
- Decisions are cached by the package and policy digests, so changed content is judged again.
- A failing, timed-out or faulted required admission interceptor refuses every judged package with
  `admission_policy_unavailable`. Disabling or reloading the policy mod in `/omd` (or `omd-mod disable`) restores
  them, and an expired or revoked `policy` grant stops judging.
- Policy grants nothing: it cannot add capabilities, issue or widen grants, change broker or managed policy, or
  reach authority operations, which are not host operations.
- Delegated overrides of the user's own execpolicy rules stay the `approve.override` grant; managed rules are never
  overridable.

## `host_operation` interceptors

Host and service calls are intercepted with `api.intercept('host_operation')` (`middleware`). Inputs carry
`{operation, namespace, arguments}`, so `match: {namespace: 'http'}` or `{namespace: /^service:/}` selects by
namespace.

`next.origin` names the actual `caller`, the service `provider` when a provider makes the call on someone's behalf,
and the caller `chain`; the host sets them and a mod cannot.

Interception covers every host operation and service call, including nested provider calls, except calls made
inside an interceptor callback and `sessions.*` and `evidence.*` calls. Pure SDK functions and local rendering are
not host operations and are not intercepted.

## `host_operation` middleware event

Experimental.

The `host_operation` middleware event (`middleware`) reports every other mod's host call as `{phase, caller,
operation}` plus `arguments` before, and `result` or `error` after.

For `store.*`, `environment.read`, `credentials.*`, `http.*`, `exec.*`, `sessions.*` and `evidence.*` the
`arguments` and `result` are `null` and an error is `private_operation_failed`; the operation, caller and whether
it failed stay visible. Other operations are shown in full.

Masking applies to the event only: a `host_operation` interceptor still receives the `arguments` and answer of the
calls it matches, except `sessions.*` and `evidence.*`, which are never intercepted. Because of that, `middleware`
is listed in the grant exposure text at trust, install and status; it is not one of the authority grants that
expire.
