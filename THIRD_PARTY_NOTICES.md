# Third-party notices

OMD first-party packages and the ports in `mods/ports` that adapt or reimplement behavior from other projects credit them here and in the package README. Sections below reproduce the license text for some of the projects; rows without one record the license the upstream project declares.

| OMD package | Source | Author | Reviewed version | License | Use |
| --- | --- | --- | --- | --- | --- |
| `omd-anchored-edit` hashline anchors | [@d3ara1n/pi-hashline-edit](https://github.com/d3ara1n/pi-extensions) | d3ara1n | 0.7.1 | MIT (declared in package metadata; no license text published) | `LINE#HASH` format, line-number hash and bounded relocation reimplemented over the OMD mod API |
| `omd-anchored-edit` search and atomic batches | [pi-hashline-edit-pro](https://github.com/YuGiMob/pi-hashline-edit-pro) | RimuruW and Yugimob | 4.4.4 | MIT | Anchored search and all-or-nothing batch behavior adapted; reimplemented |
| `omd_advisor` on-demand and triggered advice | [pi-advisor-flow](https://github.com/philipbrembeck/pi-advisor) | Philip Brembeck | 0.9.0 | MIT | Ask tool, command, failure/loop triggers, prompt principles and secret patterns adapted; reimplemented |
| `omd_lsp_sync` post-edit diagnostics | [pi-lens](https://github.com/apmantza/pi-lens) | Apostolos Mantzaris | 4.3.0 | MIT | Introduced/resolved diagnostic feedback after writes adapted; reimplemented |
| `omd_preview` `/preview` | [pi-markdown-preview](https://github.com/omaclaren/pi-markdown-preview) | Oliver MacLaren | 0.19.1 | MIT | Preview behavior reimplemented with an OMD renderer; no code copied |
| `omd_preview` inline Mermaid diagrams | [claude-mermaid](https://github.com/galElmalah/claude-mods/tree/b19a0f0d09bf214c010b15cc2849c0c1a11d7b0d) | Gal Elmalah | 0.3.1 | MIT | Text drawing of six Mermaid families in assistant messages reimplemented with an OMD renderer; no code copied |
| `omd_preview` draft image thumbnails | [Claude Image View](https://github.com/jarrodwatts/claude-image-view) | Jarrod Watts | 0.1.0 | MIT | Thumbnails of pasted images above the prompt reimplemented over public draft attachment resources; no code copied |
| `omd_claude_cli` | [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) | Eli Dickinson | 0.9.0 | MIT | Model catalog, context-window, thinking, effort, rate-limit and AskClaude behavior reimplemented over the OMD mod API |
| `omd_lsp_view` with the `omd.lsp` service in `omd_lsp_sync` | [neoism](https://github.com/parkers0405/neoism) | Parker Settle and the Neoism contributors | main, 2026-09-29 | MIT | Editor code-intelligence behavior reimplemented over the OMD mod API; no code copied |
| `omd_frecency` | [@ff-labs/pi-fff](https://github.com/dmtrKovalenko/fff/tree/main/packages/pi-fff) | Dmitriy Kovalenko | 0.11.0 | MIT | Frecency, Git-status boosts, smart case and typo-tolerant `@` ranking reimplemented over the OMD mod API; no code copied |
| `omd_privacy` secret rules and placeholders | [secret-redactor](https://github.com/ray-amjad/awesome-claude-code-function-hooks/tree/12b5fea27a4bd1b88cd9c9b6abc1efc0756c6625/plugins/secret-redactor) | ray-amjad | 12b5fea | MIT | Local secret and path rules, scoped redaction counts, allowlists and stable placeholders reimplemented over the OMD mod API; no code copied |
| `omd_privacy` PII, scopes and session placeholders | [Honmoon](https://github.com/pleaseai/honmoon/tree/e722aca593fa8bd2262f8f6451d27e47cc1cd054/packages/claude-plugin) | pleaseai | e722aca | Apache-2.0 | Optional PII, explicit scopes, session-salted placeholders and secret-free logs reimplemented over the OMD mod API; no code copied |
| `omd_plan_panel` | [@juicesharp/rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) | juicesharp | 2.11.0 | MIT | Pinned panel, status glyphs, `done/total` heading, collapse key and completed-first overflow reimplemented over Codex's `update_plan`; no code copied |
| `omd_mini` | [OpenCode mini mode](https://opencode.ai/v2/docs/cli/) | Anomaly and the OpenCode contributors | v2 CLI docs | MIT | Scrollback-first mini presentation reimplemented over the OMD mod API; no code copied |
| `omd_programmable_context` | [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) | Prime Intellect | `e75f59efc6f7` | No license declared | REPL context variables and the refine skill's evidence-linked harness changes reimplemented as behavior only; no code copied |
| `burn_meter` | [burn-meter](https://github.com/OneWave-AI/claude-code-mods/tree/e6da26ca36a88eec3be25605d30fa20f2c1c0cec/burn-meter) | OneWave AI | 0.1.0 | MIT | Spend fire bar, food comparisons, plan bars, per-turn chart, lifetime total and threshold notices reimplemented over the OMD mod API |
| `token_weather` | [token-weather](https://github.com/anthropics/claude-code-playground/tree/e9ab132d4575390ecbadfc54649712432b1a3351/claude-code/mods/token-weather) | Claude Code DevRel | 0.1.0 | Apache-2.0 | Context-window weather line and per-turn chart reimplemented over the OMD mod API |
| `blast_radius` | [blast-radius](https://github.com/anthropics/claude-code-playground/tree/e9ab132d4575390ecbadfc54649712432b1a3351/claude-code/mods/blast-radius) | Claude Code DevRel | 0.1.0 | Apache-2.0 | Risky-command matching, read-only measurement and the Proceed/Cancel hold reimplemented over the OMD mod API |

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

## burn-meter

```text
MIT License

Copyright (c) 2026 Claude Code Mods contributors

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
