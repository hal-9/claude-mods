# cache-meter

A two-row band above the prompt (relay's buttons sit under it):

```
▾ cache-meter · cache 52m · context 8% · keepwarm 5h09m left
● cache 52m ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▯ 95% hit │ ○ context 8% (auto-compact 95%) [Compact]
● keepwarm 5h09m left $4.00 cold rewrite of 200k │ ping in 49m · last ping 200k read, $0.05 [Stop]
```

- **cache** — how long the prompt cache stays warm, counting down from the last response (green while warm, `cold` once the TTL has passed and the next request re-caches the whole context).
- **bar + hit** — how much of the last request's input the cache served: `cache_read / (input + cache_read + cache_write)`.
- **context** — the tokens the next request re-sends against the model's window, with the auto-compact threshold beside it. Green under 50 %, yellow under 80 %, red above.
- **header** — click it to fold the band to that one line and back, remembered across sessions; the band lights up under the pointer. Hovering a button shows what it does.
- **Compact** — runs `/compact`. Refused while a turn is running; a toast says so.

- **keepwarm** — the window `/keepwarm` armed (`off`, `stopped` and why, or the time left), what letting the cache go cold would cost (red once it has: the next send pays it), and the next ping. **Keep warm** arms six hours, **Stop** does `/keepwarm off`.

The figures come from the engine's own `turn.step` usage and `$.session.usage()`; nothing is estimated locally. The meter is empty until the first response of a window, and empties again after a compaction.

## Keepwarm and the cold-send guard

From [karanb192/cache-tax](https://github.com/karanb192/cache-tax) 2.3.0 (MIT, `LICENSE.cache-tax`), in `hooks/keepwarm.ts`; its own band and cube icon are dropped for the row above.

    /keepwarm               keep warm for six hours
    /keepwarm 90m           a window of your own (also 2h30m, 6h)
    /keepwarm always        every session, until six hours after its last turn
    /keepwarm 6h every 2m   a testing period, 1m to 59m
    /keepwarm status | off
    /cache-tax              the card: model, cold cost, break-even, cold writes paid
    /cache-tax guard warn | refuse

A ping is one tool-less `$.model.fork` over the session after 50 idle minutes; it bills a cache read and stops once a ping finds the cache gone. With the cache cold and 50k+ tokens of context, the guard drops your next typed message once with the rewrite price; sending it again pays it, and a paid cold write keeps the cache warm for three hours. Keepwarm assumes the one-hour cache whatever `cacheTtl` says.

## Config

| Field | Values | Default |
| --- | --- | --- |
| `cacheTtl` | `5m`, `1h` | `1h` |

The engine does not expose which cache TTL a session uses, so pick the one your tier has.

## Install

```
/plugin install cache-meter --marketplace hal-9/claude-mods
```

Plays along with `relay`: whichever of the two draws the band embeds the other's.
