# omd_tool_fix

Fixes tool calls whose arguments are wrong in a clear-cut way, such as `"200"` where the tool expects a number, so the
call runs instead of failing and costing the model a retry. It's off by default in OMD+. OMD Core doesn't include it.

Each fix is recorded. When more than one fix would fit, it sends the call back to the model and says exactly what to
change.

## Turn it on

Turn it on in `/mods`, or run:

```sh
omd mods enable omd_tool_fix
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

## Use it

There is nothing to run. `/toolfix` shows what it fixed in this thread: counts, the last 12 changes, whether each
fixed call ran and the evidence record that contains the original and fixed arguments. For arguments over 32 KiB,
the record contains only the list of changes.

It changes a call only when the call doesn't match the tool's schema (its list of argument names and types), and only
in these ways:

| Arrived as | Becomes |
| --- | --- |
| A number written as text, such as `"200"` or `"2.5"` | The number, if the schema expects a number |
| `"true"` or `"false"` | `true` or `false`, if the schema expects a boolean |
| An object or list written as JSON text | The object or list, if the schema expects one |
| `"FAST"` where the schema lists `"fast"` | `"fast"`, if exactly one listed value matches ignoring case |
| `maxOutputTokens` where the schema names `max_output_tokens` | The schema's name, if the schema sets `additionalProperties: false` and exactly one name matches ignoring case, `_` and `-` |
| JSON with a trailing comma, or wrapped in a Markdown `json` code fence | The same JSON without them |

## Settings

It has no settings.

## Needs and limits

- It asks to add `/toolfix`, check and change tool calls before they run, repair the JSON of finished tool calls in the
  model's response, and keep its records. The capabilities are `commands`, `interception`, `middleware` and `store` (see
  [Trust and permissions](../../../docs/trust-and-permissions.md#what-a-mod-can-do)).
- It never changes text the tool expects as text, so commands, paths and file contents are never rewritten. It
  never turns `"05"`, `"+5"`, `"5.0"` or `5.5` into an integer, `"1"` or `"yes"` into a boolean, a single value
  into a list, or a number into text, and never drops a field, even a `null` one.
- Calls whose arguments already match, freeform tools such as `apply_patch`, tools without a schema and tools
  whose schema uses `oneOf`, `allOf` or `$ref` pass through untouched.
- The host checks every fixed call against the tool's registered schema again and applies its usual permissions
  and approvals. A fix the host rejects counts as rejected, and the same call is not fixed a third time. The same
  applies to an ambiguous call the model keeps sending.
- It checks each call against the schema it arrives with, so a tool whose schema changes is never fixed against an
  old one.
- It runs on every tool call: one quick check for calls that already match. JSON repair runs only on finished tool
  calls, never on streamed text.

## More

- [Included mods](../../../docs/collection.md)
- [Interceptors reference](../../reference/interceptors.md) and [tools reference](../../reference/tools.md)
