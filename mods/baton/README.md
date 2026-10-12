# baton

**Pass the work on before the context runs out.**

baton is a Claude Code mod that keeps long sessions and subagent orchestration from drowning in context. It measures the real context fill after every model request, stops subagents that run too long or grow too big, and makes the main agent hand its remaining work over to a fresh session instead of degrading in a full one.

## What it does

1. **Measures context for real.** After every model request, main's and every subagent's, baton reads the API's own token figures and computes what the next request will re-send. The status line shows it live:

   ```
   baton ctx 42% (84k/200k) Δ+3.1k · agents 2 (max 28%)
   ```

2. **Guards subagents.** A subagent whose context passes 30 %, or that runs longer than 20 minutes, gets a stop order injected into its conversation: finish nothing new, reply with a handoff of the remaining work (done, remaining, exact next step, gotchas). Its reply reaches the main agent as the Agent tool result, together with a note from baton: this is a handoff, spawn a fresh subagent with it, do not redo what is done.

3. **Wraps up the main agent.** When main's context passes 70 %, baton tells it to wrap up: start nothing new, let subagents finish, update the files the work touched, then call the `handoff` tool with the remaining work. The status line switches to `WRAP UP`. If the agent keeps going, baton reminds it every 5 points.

4. **Hands over to the next session.** The handoff is stored by baton, not in a file in your repo. The next session you start in the same directory gets it injected before its first model request, as a hidden user message: continue from here, do not redo what is done. Exactly one session picks a handoff up.

5. **Explains context growth.** Every growth step is attributed to the tool calls that caused it. `/baton` shows the five biggest bumps, main's fill, the engine's own percent for cross-checking, every subagent's state, and the stored handoff.

All measurements live in the session's plugin state under `baton` (`main`, `agents`, `bumps`, `phase`, `enginePercent`), so other mods can read them.

## Install

```
/plugin install baton --marketplace hal-9/claude-mods
```

Answer `y` to add the marketplace, pick the user scope, accept or change the three limits.

## Use

- Work as usual. Watch the status line.
- When it says `WRAP UP`, let the agent finish; it calls `handoff` by itself. Then start a fresh session in the same directory. That is all.
- `/baton` prints the report. `/baton clear` drops a stored handoff you do not want picked up.

## Settings

| Option | Default | Meaning |
| --- | --- | --- |
| Main agent wrap-up at % | 70 | Main is told to wrap up and write a handoff past this fill. |
| Subagent context limit % | 30 | A subagent past this fill is stopped and asked for a handoff. |
| Subagent time limit (minutes) | 20 | A subagent running longer is stopped and asked for a handoff. |

Change them in `/config` under baton.

## How the numbers are made

Context fill = `input + cache_read + cache_creation + output` tokens of the last response, over the model's window. That is the sum the next request re-sends, read per request from the API's usage block, not estimated. The engine's own status-line percent is kept beside it (`engine says N%` in `/baton`) so you can see when the two drift apart.

## Limits

- One context window for every loop. A subagent on a different model with a different window reads slightly off.
- A subagent's stop is a message, not a kill: it lands at the subagent's next model request. A subagent stuck in one long tool call stops after that call returns.
- Teammates with several turns are marked ended after their first turn's completion in the report; their context is still measured.

## Development

```
claude plugin validate <folder>
claude plugin test <folder>
```
