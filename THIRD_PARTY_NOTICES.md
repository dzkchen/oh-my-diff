# Third-party notices

OMD first-party packages that port behavior from other projects credit them here and in the package README.

| OMD package | Source | Author | Reviewed version | License | Use |
| --- | --- | --- | --- | --- | --- |
| `omd-anchored-edit` hashline anchors | [@d3ara1n/pi-hashline-edit](https://github.com/d3ara1n/pi-extensions) | d3ara1n | 0.7.1 | MIT (declared in package metadata; no license text published) | `LINE#HASH` format, line-number hash and bounded relocation reimplemented over the OMD mod API |
| `omd-anchored-edit` search and atomic batches | [pi-hashline-edit-pro](https://github.com/YuGiMob/pi-hashline-edit-pro) | RimuruW and Yugimob | 4.4.4 | MIT | Anchored search and all-or-nothing batch behavior adapted; reimplemented |
| `omd_advisor` on-demand and triggered advice | [pi-advisor-flow](https://github.com/philipbrembeck/pi-advisor) | Philip Brembeck | 0.9.0 | MIT | Ask tool, command, failure/loop triggers, prompt principles and secret patterns adapted; reimplemented |
| `omd_lsp_sync` post-edit diagnostics | [pi-lens](https://github.com/apmantza/pi-lens) | Apostolos Mantzaris | 4.3.0 | MIT | Introduced/resolved diagnostic feedback after writes adapted; reimplemented |
| `omd-browser` plugin | [BetterWright](https://github.com/BetterWright/betterwright) | The BetterWright Project and contributors | 2.8.8 | MIT | Session, snapshot, network-policy, handoff, vault and CAPTCHA behavior reimplemented; no code copied |
| `omd-browser` design mode (`omd_browser` mod) | [terminal-browser](https://github.com/zenbu-labs/terminal-browser/tree/ea63ea4904785649c5505b612d5fdbb704b203fa/claude-code-plugin) | Zenbu Labs, Inc. | 0.0.2 (`ea63ea4`) | MIT | Manual element selection, annotation tray and delivery of picked HTML, styles and screenshots to the agent reimplemented over managed Chromium and the OMD mod API; no code copied |
| `omd_preview` `/preview` | [pi-markdown-preview](https://github.com/omaclaren/pi-markdown-preview) | Oliver MacLaren | 0.19.1 | MIT | Preview behavior reimplemented with an OMD renderer; no code copied |
| `omd_preview` inline Mermaid diagrams | [claude-mermaid](https://github.com/galElmalah/claude-mods/tree/b19a0f0d09bf214c010b15cc2849c0c1a11d7b0d) | Gal Elmalah | 0.3.1 | MIT | Text drawing of six Mermaid families in assistant messages reimplemented with an OMD renderer; no code copied |
| `omd_preview` draft image thumbnails | [Claude Image View](https://github.com/jarrodwatts/claude-image-view) | Jarrod Watts | 0.1.0 | MIT | Thumbnails of pasted images above the prompt reimplemented over public draft attachment resources; no code copied |
| `omd-review-policy` simplify skill and `/simplify` | [pi-simplify](https://github.com/MattDevy/pi-extensions/tree/main/packages/pi-simplify) | Matt Devy | 0.2.3 | MIT | Command and review principles adapted; reimplemented over the OMD mod API |
| `omd_claude_cli` | [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) | Eli Dickinson | 0.9.0 | MIT | Model catalog, context-window, thinking, effort, rate-limit and AskClaude behavior reimplemented over the OMD mod API |
| `omd_muse` | [pi-muse-msp](https://github.com/jwise7/pi-muse-msp) | Jesse Wise | 0.2.4 | MIT | `muse serve` MSP client behavior ported; UUIDv7 command ids and durable-log recovery adapted |
| `omd_panes`, `omd_notes`, `omd_lsp_view` with the `omd.lsp` service in `omd_lsp_sync` | [neoism](https://github.com/parkers0405/neoism) | Parker Settle and the Neoism contributors | main, 2026-09-29 | MIT | Pane, file-tree, editor code-intelligence and notes-vault behavior reimplemented over the OMD mod API; no code copied |
| `omd_frecency` | [@ff-labs/pi-fff](https://github.com/dmtrKovalenko/fff/tree/main/packages/pi-fff) | Dmitriy Kovalenko | 0.11.0 | MIT | Frecency, Git-status boosts, smart case and typo-tolerant `@` ranking reimplemented over the OMD mod API; no code copied |
| `omd_theme` powerline status line and prompt stash | [pi-powerline-footer](https://github.com/nicobailon/pi-powerline-footer) | Nico Bailon | 0.18.0 | MIT (declared in package metadata; no license text published) | Presets, segments, context warning thresholds, Nerd Font heuristics and the stash toggle reimplemented; no code copied |
| `omd_layout` command palette | [@d3ara1n/pi-command-palette](https://github.com/d3ara1n/pi-extensions/tree/main/packages/pi-command-palette) | d3ara1n | 0.8.0 | MIT | Nested pages, root search across pages, built-in actions, editor-text restore, model and session pages and the Ctrl+Shift+P binding reimplemented over the OMD mod API; no code copied |
| `omd_plan_panel` | [@juicesharp/rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) | juicesharp | 2.11.0 | MIT | Pinned panel, status glyphs, `done/total` heading, collapse key and completed-first overflow reimplemented over Codex's `update_plan`; no code copied |
| `omd_git` GitHub pull request status | [cc-pr-tracker](https://github.com/sezaakgun/cc-pr-tracker/tree/514da1edb4877cdb812ae1a25f79aa81fb6aa6db) | Seza Akgün | 514da1e | MIT | Explicit PR watches, merge state, review decision, required-check buckets, quiet first load and unknown merge states reimplemented over the OMD mod API; no code copied |
| `omd_git` GitHub CI status | [gh-ci-status](https://github.com/diegorv/claude-functions-hook/tree/11e1d052427e1bb9d38668d4779f343b0693c2b5/plugins/gh-ci-status) | Diego R. v. | 0.1.0 | None found (behavior reference only) | Adaptive polling and workflow-run rows independently reimplemented from public behavior; no code copied |
| `omd_privacy` secret rules and placeholders | [secret-redactor](https://github.com/ray-amjad/awesome-claude-code-function-hooks/tree/12b5fea27a4bd1b88cd9c9b6abc1efc0756c6625/plugins/secret-redactor) | ray-amjad | 12b5fea | MIT | Local secret and path rules, scoped redaction counts, allowlists and stable placeholders reimplemented over the OMD mod API; no code copied |
| `omd_privacy` PII, scopes and session placeholders | [Honmoon](https://github.com/pleaseai/honmoon/tree/e722aca593fa8bd2262f8f6451d27e47cc1cd054/packages/claude-plugin) | pleaseai | e722aca | Apache-2.0 | Optional PII, explicit scopes, session-salted placeholders and secret-free logs reimplemented over the OMD mod API; no code copied |

## pi-simplify

```text
MIT License

Copyright (c) 2026 Matt Devy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## pi-hashline-edit-pro

```text
MIT License

Copyright (c) 2026 RimuruW and Yugimob

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## pi-advisor-flow

```text
MIT License

Copyright (c) 2025 Philip Brembeck

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## pi-lens

```text
MIT License

Copyright (c) 2026 Apostolos Mantzaris and pi-lens contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## BetterWright

```text
MIT License

Copyright (c) 2026 The BetterWright Project and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## terminal-browser

```text
Copyright 2026 Zenbu Labs, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## pi-markdown-preview

```text
MIT License

Copyright (c) 2026 Oliver MacLaren

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## pi-claude-bridge

```text
MIT License

Copyright (c) 2026 Eli Dickinson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## pi-muse-msp

```text
MIT License

Copyright (c) 2026 Jesse Wise

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## neoism

```text
MIT License

Copyright (c) 2026-present Parker Settle and the Neoism contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## pi-fff

```text
MIT License

Copyright (c) 2025 Dmitriy Kovalenko

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## rpiv-todo

```text
MIT License

Copyright (c) 2026 juicesharp

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## cc-pr-tracker

```text
MIT License

Copyright (c) 2026 Seza Akgün

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
