# omd_update

Tells you when a newer Oh My Diff release is out and controls how OMD updates itself. It is active in OMD Core and OMD+.

The installer does the work: the OMD launcher runs a bounded background check against the GitHub releases of
`dzkchen/oh-my-diff` at most once per cadence, caches the result and passes it to this mod as `OH_MY_DIFF_UPDATE`.
The mod never reaches the network and never replaces a running session.

- A fresh session's welcome area shows a newer compatible release once a day until you choose **Remind me in a week**
  or **Skip this version**, plus one line after an update succeeded or failed. The host draws no welcome area in
  `--no-alt-screen` sessions; `/update` works there.
- `/update` shows the installed and available versions, the release notes, the `omd update` command and incompatible
  user mods, and has buttons for update checks, automatic updates, the channel (stable, beta or nightly) and the cadence (daily
  or weekly). **Update now** queues the release for the next start, because a running session keeps its host and mods.
- The same settings, plus an exact version `pin`, are editable in `/mods` and with `omd update checks|channel|cadence|pin`
  and `omd update enable|disable` in a shell.

Updates install only when OMD starts while no other OMD session is open, through the installer's verified transaction
(checksum, compatibility preflight, atomic switch, automatic rollback on failure). Automatic updates are off by default,
stop retrying a release that failed once, and never update mods you installed yourself. See `INSTALL.md`.

At launch, staged releases must still match the current pin, channel and runtime requirements.
Automatic staging also rechecks automatic-update policy and enabled user-mod compatibility.
Explicit manual updates still apply with automatic updates disabled.

Nightly is opt-in and includes only nightly prereleases that passed hosted validation. Stable and beta never
offer nightlies. Use `omd update channel nightly` or `/update channel nightly` to select it.
