import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { Reading } from '../types'

const READING = { plugin: 'cache-meter', key: 'reading' } as const
const TICK = { plugin: 'cache-meter', key: 'tick' } as const

const SEGMENTS = 16
const TTL_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000 } as const

type $ = EngineInterface

const inputOf = (u: ModelUsage) => u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
const contextOf = (u: ModelUsage) => inputOf(u) + u.output_tokens

const bar = (percent: number) => {
  const filled = Math.round((percent / 100) * SEGMENTS)
  return ['▮'.repeat(filled), '▯'.repeat(SEGMENTS - filled)] as const
}

const level = (percent: number) => (percent < 50 ? 'success' : percent < 80 ? 'warning' : 'error')
const glyph = (percent: number) => (percent < 25 ? '○' : percent < 50 ? '◔' : percent < 75 ? '◑' : percent < 100 ? '◕' : '●')
const minutes = (ms: number) => Math.ceil(ms / 60_000)

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

async function setReading($: $, value: Reading | null) {
  await $.state.set(READING, value)
}

// Bumped every half minute so the countdown redraws.
async function bumpTick($: $) {
  const { value = 0 } = await $.state.get(TICK)
  await $.state.set(TICK, value + 1)
}

async function compact($: $) {
  try {
    const { skip } = await $.session.compact()
    if (skip) return $.ui.toast('cache-meter: compaction was skipped')
    // Our own session.compact hook is skipped for our own call; clear here.
    await setReading($, null)
  } catch (err) {
    $.ui.toast(`cache-meter: cannot compact now (${err instanceof Error ? err.message : String(err)})`)
  }
}

export const register: Register = (on, options) => {
  const ttlMs = TTL_MS[(options.cacheTtl as keyof typeof TTL_MS) ?? '1h'] ?? TTL_MS['1h']

  on('session.start', async ($, e, next) => {
    $.clock.every(30_000, () => void bumpTick($))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (e.agentId || !r.usage) return r
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
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    // The window is empty until the next response; drop the stale figures.
    await setReading($, null)
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { value: m } = await $.state.get(READING)
    if (!m || e.props.hasSurvey) return next(e)
    await $.state.get(TICK)

    const { Box, Button, Text } = $.ui.resolve(e)
    const left = m.at + ttlMs - (await $.clock.now())
    const isWarm = left > 0
    const [hit, miss] = bar(m.hitPercent)
    const ctx = level(m.percent)
    // Another mod's band (relay's buttons) rides along beneath the meter; the engine's own band is empty.
    const below = await next(e)

    return (
      <Box flexDirection="column" gap="xs">
        <Box gap="sm" alignItems="center">
          <Text tabular>
            <Text color={isWarm ? 'success' : 'inactive'}>● </Text>
            <Text dimColor>cache </Text>
            <Text color={isWarm ? 'success' : 'inactive'} weight="medium">
              {isWarm ? `${minutes(left)}m` : 'cold'}
            </Text>
            <Text> </Text>
            <Text color="success">{hit}</Text>
            <Text color="inactive">{miss}</Text>
            <Text weight="semibold"> {m.hitPercent}%</Text>
            <Text dimColor> hit</Text>
          </Text>
          <Text dimColor>·</Text>
          <Text tabular>
            <Text color={ctx}>{glyph(m.percent)} </Text>
            <Text dimColor>context </Text>
            <Text color={ctx} weight="semibold">
              {m.percent}%
            </Text>
            {m.autoCompactPercent !== null && <Text dimColor> (auto-compact {m.autoCompactPercent}%)</Text>}
          </Text>
          <Button key="compact" label="Compact" onPress={() => void compact($)} />
        </Box>
        {below.type !== 'engine' && below}
      </Box>
    )
  })
}
