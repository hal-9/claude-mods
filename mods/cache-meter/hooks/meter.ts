// The meter's half of the events it shares with keepwarm: a mod hooks each event once,
// so keepwarm.ts calls these from its own session.start, turn.step and session.compact.
import type { EngineInterface, ModelUsage, TurnStepInput, TurnStepResult } from 'claude-code'

import type { Reading } from '../types'

const READING = { plugin: 'cache-meter', key: 'reading' } as const
const TICK = { plugin: 'cache-meter', key: 'tick' } as const
const COLLAPSED = { plugin: 'cache-meter', key: 'collapsed' } as const

type $ = EngineInterface

const inputOf = (u: ModelUsage) => u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
const contextOf = (u: ModelUsage) => inputOf(u) + u.output_tokens

// The engine's window and auto-compact figures; a summary breakdown estimates and costs no API call.
async function windowOf($: $) {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    const window = context.window || 200_000
    const at = context.breakdown?.autoCompactThreshold
    return { window, autoCompactPercent: at ? Math.round((at / window) * 100) : null }
  } catch {
    return { window: 200_000, autoCompactPercent: null }
  }
}

export async function setReading($: $, value: Reading | null) {
  await $.state.set(READING, value)
}

// Bumped every half minute so the countdown redraws.
async function bumpTick($: $) {
  const { value = 0 } = await $.state.get(TICK)
  await $.state.set(TICK, value + 1)
}

export async function meterStart($: $, surface: string | null) {
  // A headless session draws no band, so nothing needs the countdown redrawn.
  if (surface) $.clock.every(30_000, () => void bumpTick($))
  await $.state.set(COLLAPSED, (await $.store.get('collapsed')) === true)
}

export async function meterStep($: $, e: TurnStepInput, r: TurnStepResult) {
  if (e.agentId || !r.usage) return
  const u = r.usage
  const input = inputOf(u)
  const { window, autoCompactPercent } = await windowOf($)
  const tokens = contextOf(u)
  await setReading($, {
    at: await $.clock.now(),
    hitPercent: input ? Math.round((u.cache_read_input_tokens / input) * 100) : 0,
    tokens,
    window,
    percent: Math.round((tokens / window) * 100),
    autoCompactPercent,
  })
}

// The window is empty until the next response; drop the stale figures.
export async function meterCompact($: $) {
  await setReading($, null)
}
