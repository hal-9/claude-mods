# relay

Role buttons for Claude Code: let the model that writes the code hand parts of the job to other models, Pi-style, from a band above the prompt.

| Button | Hotkey | What runs |
|---|---|---|
| check | c | `codex-companion review` on the working tree, in the background |
| adversarial | a | `codex-companion adversarial-review` (challenges the design, not just defects) |
| hand over | h | fills the composer with `/relay hand ` so you type the task; runs `codex-companion task --write` |
| verify | v | a Claude subagent on the `verifyModel` (default `opus`) that reviews and runs tests, read-only |

A pane (`relay`) lists the last three runs: elapsed time and the Codex log tail while running; the verdict, summary and findings when done. Each finding has **fix** (submits a prompt to the main agent with the finding and Codex's recommendation) and **dismiss**; **fix all** sends every finding at once. A task's or verifier's output gets **pull into Claude**.

`/relay check | adversarial | hand <task> | verify` does the same from the prompt.

## Install

```
/plugin install relay --marketplace hal-9/claude-mods
```

## Requirements

- The [openai-codex](https://github.com/openai/codex-plugin-cc) plugin installed and `codex` set up (`/codex:setup`). relay drives its `scripts/codex-companion.mjs` and shares its job state, so `/codex:status` and `/codex:result` see relay's runs too.
- `node` on PATH.

## Settings

- `codexPluginRoot`: folder holding `scripts/codex-companion.mjs`; empty means `~/.claude/plugins/marketplaces/openai-codex/plugins/codex`.
- `codexModel`: passed as `--model`; empty means Codex's default.
- `verifyModel`: Claude alias or id for the verify subagent.

## Develop

Validate and test with the engine build the types came from (the desktop app's binary, not necessarily the `claude` on PATH):

```
claude plugin validate <folder>
claude plugin test <folder>
```

Hotkeys work while the band or pane holds the focus (ctrl+x tab, or a click).
