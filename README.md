# claude-mods

Marketplace of Claude Code mods, MIT licensed. One folder per mod under `mods/`.

| Mod | What it does |
| --- | --- |
| [baton](mods/baton) | Measures real context use per model request, stops subagents that run too long or too big, hands remaining work to a fresh session. |

## Install a mod

```
/plugin install baton --marketplace hal-9/claude-mods
```

Answer `y` to add the marketplace, pick the user scope. Repeat with another mod's name for the next one.

## Add a mod

1. Put it in `mods/<name>/` with `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.ts` and a README.
2. Add it to `.claude-plugin/marketplace.json`.
3. `claude plugin validate mods/<name>` and `claude plugin test mods/<name>`.
