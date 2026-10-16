# cache-meter

A meter in the prompt footer, next to the mode labels:

```
● cache 52m ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▯ 95% hit · ○ context 8% (auto-compact 95%) [Compact]
```

- **cache** — how long the prompt cache stays warm, counting down from the last response (green while warm, `cold` once the TTL has passed and the next request re-caches the whole context).
- **bar + hit** — how much of the last request's input the cache served: `cache_read / (input + cache_read + cache_write)`.
- **context** — the tokens the next request re-sends against the model's window, with the auto-compact threshold beside it. Green under 50 %, yellow under 80 %, red above.
- **Compact** — runs `/compact`. Refused while a turn is running; a toast says so.

The figures come from the engine's own `turn.step` usage and `$.session.usage()`; nothing is estimated locally. The meter is empty until the first response of a window, and empties again after a compaction.

## Config

| Field | Values | Default |
| --- | --- | --- |
| `cacheTtl` | `5m`, `1h` | `1h` |

The engine does not expose which cache TTL a session uses, so pick the one your tier has.

## Install

```
/plugin install cache-meter --marketplace hal-9/claude-mods
```

Plays along with `mod-switch`: whichever of the two draws the footer embeds the other's.
