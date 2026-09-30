# OMD welcome

`omd_logo` is the default presentation package in OMD+ and OMD Core. It adds
the installed profile to Codex's source-backed version heading and places the
approved OMD mark in the fresh session's blank transcript area. It requires
only `terminal`; it changes no task policy and stores no session state. The
heading and greeting policy apply before the first editable frame.

The mark stays while composing, pasting, editing, clearing, or correcting a
rejected submission. The host's accepted turn start ends it. Running and
resumed sessions do not restore it on reload or on later turns. The mark
shrinks to its three original rows below 60 columns and to `OMD` below 15.
If the transcript leaves no room, the renderer preserves the transcript.
Inline and raw output retain the profile heading without a centered mark.

Startup greetings are hidden by default. The opt-in
[`omd_theme`](../omd_theme/README.md) package can enable or customize them.
Its later greeting patch overrides the logo's empty default independently of
the mark. `icons: "ascii"` uses the approved ASCII mark. Disabling or breaking
this package restores the upstream heading and welcome behavior. Other enabled
presentation packages keep their overrides; direct and zero-first-party-mod
sessions use the upstream fallback.
