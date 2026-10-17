# omd_model_picker

Shows the `/model` and reasoning-effort pickers as compact lists with your current choice marked.

## Turn it off

It is on by default in OMD+. Turn it off in `/mods`, or run:

```sh
omd-package mod disable omd_model_picker
```

## Use it

Open `/model` as usual. Selection and keys work as before. With `omd_profiles` on, your profiles are listed under the models. `/profile use NAME` switches.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `layout` | `compact` | `native` leaves the pickers as Codex draws them. |
| `brand` | `oh my diff` | Text before the picker title. Empty hides it. |
