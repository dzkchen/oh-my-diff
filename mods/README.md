# @oh-my-diff/mod-api

The TypeScript SDK for Oh My Diff (OMD) mods: the API types, the `omd-mod-author` command and the test helpers. OMD
installs it together with `omd-mod` and `omd`. It isn't on npm.

Start a mod:

```sh
omd-mod-author create ./my_mod my_mod
```

## Learn

- [Write your first mod](https://github.com/dzkchen/oh-my-diff/blob/main/docs/mod-authors/first-mod.md): create,
  test, run and install a `/hello` command.
- [Build a notes mod](https://github.com/dzkchen/oh-my-diff/blob/main/docs/mod-authors/notes-mod.md): tools, saved
  state, settings and a line on screen.

## Do a task

- [Run and debug a mod](https://github.com/dzkchen/oh-my-diff/blob/main/docs/mod-authors/run-and-debug.md)
- [Test a mod](https://github.com/dzkchen/oh-my-diff/blob/main/docs/mod-authors/test-a-mod.md)
- [Publish a mod](https://github.com/dzkchen/oh-my-diff/blob/main/docs/mod-authors/publish-a-mod.md)
- [Bundle a mod in a plugin](https://github.com/dzkchen/oh-my-diff/blob/main/docs/mod-authors/bundle-in-a-plugin.md)
- [Change a mod's saved state](https://github.com/dzkchen/oh-my-diff/blob/main/docs/mod-authors/migrate-state.md)
- [Write terminal components in JSX](https://github.com/dzkchen/oh-my-diff/blob/main/docs/mod-authors/jsx.md)

## Look it up

- [Mod API reference](reference/README.md): every operation, event, view field and layout component.
  [`REFERENCE.md`](REFERENCE.md) has all of it in one file.
- [`api.d.ts`](api.d.ts): the types the reference describes.
- [Agent mod guide](https://github.com/dzkchen/oh-my-diff/blob/main/docs/AGENT_MOD_GUIDE.md): rules and lookups for
  coding agents.
- [Support](https://github.com/dzkchen/oh-my-diff/blob/main/docs/support.md): platforms, versions and API stability.
