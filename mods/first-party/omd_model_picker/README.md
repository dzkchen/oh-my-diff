# omd_model_picker

Default-active in OMD+. It redraws the `/model` and reasoning-effort pickers as
compact lists with the current choice marked, keeping the native selection and
keyboard behavior. When `omd_profiles` is enabled it lists the profiles below the
models; switch with `/profile use NAME`.

Settings: `layout` (`compact` or `native`, which leaves the pickers untouched)
and `brand` (title prefix). Capabilities: `terminal` (`list` replacement),
`events`, `store`.
