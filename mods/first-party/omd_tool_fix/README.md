# omd_tool_fix

Fixes tool calls whose arguments are wrong in a clear-cut way, such as `"200"` where the tool wants a number, so
the call runs instead of failing and costing the model a retry. Each fix is recorded. When more than one fix would
fit, it sends the call back to the model and says exactly what to change.

## Turn it on

It comes with OMD+ but starts off. Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_tool_fix
```

## Use it

There is nothing to run. `/toolfix` shows what it fixed in this thread: counts, the last 12 changes, whether each
fixed call ran and the evidence record that holds the original and fixed arguments. Arguments over 32 KB keep only
the list of changes.

It changes a call only when it doesn't match the tool's own schema, and only in these ways:

| Arrived as | Becomes |
| --- | --- |
| A number written as text, such as `"200"` or `"2.5"` | The number, if the schema wants a number |
| `"true"` or `"false"` | `true` or `false`, if the schema wants a boolean |
| An object or list written as JSON text | The object or list, if the schema wants one |
| `"FAST"` where the schema lists `"fast"` | `"fast"`, if exactly one listed value matches ignoring case |
| `maxOutputTokens` where the schema names `max_output_tokens` | The schema's name, if exactly one name matches |
| JSON with a trailing comma, or wrapped in a ```` ```json ```` fence | The same JSON without them |

## Needs and limits

- It never changes text the tool expects as text, so commands, paths and file contents are never rewritten. It
  never turns `"05"`, `"+5"`, `"5.0"` or `5.5` into an integer, `"1"` or `"yes"` into a boolean, a single value
  into a list, or a number into text, and never drops a field, even a `null` one.
- Calls whose arguments already match, freeform tools such as `apply_patch`, tools without a schema and tools
  whose schema uses `oneOf`, `allOf` or `$ref` pass through untouched.
- The host checks every fixed call against the tool's registered schema again and applies its usual permissions
  and approvals. A fix the host rejects counts as rejected, and the same call is not fixed a third time. The
  same applies to an ambiguous call the model keeps sending.
- It checks each call against the schema it arrives with, so a tool whose schema changes is never fixed against an
  old one.
- It runs on every tool call: one quick check for calls that already match. JSON repair runs only on finished
  tool calls, never on streamed text.
