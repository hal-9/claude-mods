import type { EngineInterface, ModelUsage, Register, RenderChildren } from 'claude-code'

import type { Reading } from '../types'

const READING = { plugin: 'cache-meter', key: 'reading' } as const
const TICK = { plugin: 'cache-meter', key: 'tick' } as const
const COLLAPSED = { plugin: 'cache-meter', key: 'collapsed' } as const

const SEGMENTS = 16
const TTL_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000 } as const

// The savvy-progress palette, so the bands read as one family.
const ACCENT = '#8f8cf4'
const WARM = '#5fbf8f'
const AMBER = '#e0a43a'
const RED = '#e5675a'
const COLD = '#9a9a9a'
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

type $ = EngineInterface

const inputOf = (u: ModelUsage) => u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
const contextOf = (u: ModelUsage) => inputOf(u) + u.output_tokens

const bar = (percent: number) => {
  const filled = Math.round((percent / 100) * SEGMENTS)
  return ['▮'.repeat(filled), '▯'.repeat(SEGMENTS - filled)] as const
}

const level = (percent: number) => (percent < 50 ? 'success' : percent < 80 ? 'warning' : 'error')
const levelHex = (percent: number) => (percent < 50 ? ACCENT : percent < 80 ? AMBER : RED)
const glyph = (percent: number) => (percent < 25 ? '○' : percent < 50 ? '◔' : percent < 75 ? '◑' : percent < 100 ? '◕' : '●')
const minutes = (ms: number) => Math.ceil(ms / 60_000)

// ---------------------------------------------------------------------------
// Desktop: the row is one SVG, as savvy-progress draws its own (the desktop
// wraps sibling elements onto new lines). Only the buttons sit beside it.

const H = 22
const BAR_H = 14
const CELL = 3

// Deterministic noise so the dither does not shimmer between redraws.
const noise = (x: number, y: number) => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

// ponytail: ASCII-only width estimate; every string drawn here is ours.
const textW = (s: string, size: number) => Math.round(s.length * 0.62 * size)

// A rounded track, dithered up to `percent`, sparse at the start and dense toward the head.
function ditherBar(x: number, w: number, percent: number, color: string, seed: number, marker?: number | null) {
  const y = (H - BAR_H) / 2
  const cols = Math.floor((w * Math.min(100, percent)) / 100 / CELL)
  const rows = Math.floor(BAR_H / CELL)
  const dots: string[] = []
  for (let c = 0; c < cols; c++) {
    const density = 0.35 + 0.6 * Math.pow(c / Math.max(1, cols), 1.2)
    for (let r = 0; r < rows; r++) {
      if (noise(c + seed, r) < density) dots.push(`<rect class="t${Math.floor(noise(r, c + seed) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="2" height="2"/>`)
    }
  }
  const tick = marker == null ? '' : `<rect class="mk" x="${Math.round((w * marker) / 100) - 1}" y="-2" width="2" height="${BAR_H + 4}" rx="1"/>`
  return `<g transform="translate(${x},${y})">
<clipPath id="c${seed}"><rect width="${w}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath>
<rect class="k" width="${w}" height="${BAR_H}" rx="${BAR_H / 2}"/>
<g clip-path="url(#c${seed})" fill="${color}">${dots.join('')}</g>${tick}
</g>`
}

type Row = { m: Reading; isWarm: boolean; countdown: string; barW: number }

function rowSvg({ m, isWarm, countdown, barW }: Row) {
  const warm = isWarm ? WARM : COLD
  const ctx = levelHex(m.percent)
  const parts: string[] = []
  let x = 0
  const text = (s: string, cls: string, size = 13, weight = 500) => {
    parts.push(`<text class="${cls}" x="${x}" y="${H / 2 + 4.5}" font-size="${size}" font-weight="${weight}">${s}</text>`)
    x += textW(s, size)
  }
  // A figure and its word in one text run, so the browser sets the space between them.
  const figure = (value: string, word: string) => {
    parts.push(`<text x="${x}" y="${H / 2 + 4.5}" font-size="12.5"><tspan class="t" font-weight="600">${value}</tspan><tspan class="m" dx="5">${word}</tspan></text>`)
    x += textW(value, 12.5) + 5 + textW(word, 12.5)
  }

  parts.push(`<circle cx="5" cy="${H / 2}" r="4" fill="${warm}"/>`)
  x = 16
  text('Cache', 't')
  x += 8
  const pillW = 16 + textW(countdown, 11)
  parts.push(`<rect x="${x}" y="${(H - 16) / 2}" width="${pillW}" height="16" rx="8" fill="${warm}"/>`)
  parts.push(`<text x="${x + pillW / 2}" y="${H / 2 + 4}" text-anchor="middle" font-size="11" font-weight="600" fill="#ffffff">${countdown}</text>`)
  x += pillW + 10
  parts.push(ditherBar(x, barW, m.hitPercent, warm, 1))
  x += barW + 8
  figure(`${m.hitPercent}%`, 'hit')
  x += 14
  parts.push(`<rect class="tk" x="${x}" y="${H / 2 - 6}" width="1" height="12"/>`)
  x += 15
  text('Context', 't')
  x += 10
  parts.push(ditherBar(x, barW, m.percent, ctx, 7, m.autoCompactPercent))
  x += barW + 8
  if (m.autoCompactPercent !== null) figure(`${m.percent}%`, `compacts at ${m.autoCompactPercent}%`)
  else text(`${m.percent}%`, 't', 12.5, 600)
  const W = x + 4

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" font-variant-numeric="tabular-nums">
<style>
.t{fill:#1f1f1f}.m{fill:#8a8a8a}.k{fill:#e4e4e2}.tk{fill:#c4c4c0}.mk{fill:#1f1f1f;opacity:.55}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{fill:#2c2c2c}.tk{fill:#4a4a4a}.mk{fill:#ececec}}
${isWarm ? `.t0,.t1,.t2,.t3{animation:tw 2.6s ease-in-out infinite}
.t1{animation-duration:3.1s;animation-delay:-.7s}.t2{animation-duration:2.2s;animation-delay:-1.3s}.t3{animation-duration:3.6s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:.45}}
@media (prefers-reduced-motion: reduce){.t0,.t1,.t2,.t3{animation:none}}` : ''}
</style>
${parts.join('\n')}
</svg>`
  return { svg, width: W }
}

// A hairline that sets this band apart from the mod bands drawn beneath it.
const dividerSvg = (w: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="1" viewBox="0 0 ${w} 1"><style>rect{fill:#0000001a}@media (prefers-color-scheme: dark){rect{fill:#ffffff1f}}</style><rect width="${w}" height="1"/></svg>`

// ---------------------------------------------------------------------------

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

// Collapsed or not, remembered across sessions.
async function setCollapsed($: $, isCollapsed: boolean) {
  await $.state.set(COLLAPSED, isCollapsed)
  await $.store.set('collapsed', isCollapsed)
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
    await $.state.set(COLLAPSED, (await $.store.get('collapsed')) === true)
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
    const { value: isCollapsed = false } = await $.state.get(COLLAPSED)

    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const left = m.at + ttlMs - (await $.clock.now())
    const isWarm = left > 0
    const countdown = isWarm ? `${minutes(left)}m` : 'cold'
    // Another mod's band (relay's buttons) rides along beneath the meter; the engine's own band is empty.
    const drawn = await next(e)
    const below = drawn.type !== 'engine' ? drawn : null
    const isDesktop = e.surface !== 'terminal' && 'Svg' in ui
    const cols = e.props.bodyColumns || 100

    const divider = isDesktop
      ? <ui.Svg source={dividerSvg(Math.min(1600, cols * 8))} alt="" width={Math.min(1600, cols * 8)} height={1} />
      : <Text dimColor>{'─'.repeat(Math.max(8, cols - 2))}</Text>
    const withBelow = (row: RenderChildren) => (
      <Box flexDirection="column" gap={isDesktop ? 'sm' : 0} paddingTop={isDesktop ? 'xs' : 0}>
        {row}
        {below && divider}
        {below}
      </Box>
    )

    if (isCollapsed) {
      return withBelow(
        <Button
          key="expand"
          plain
          dimColor
          label={`${isWarm ? '●' : '○'} cache ${countdown} · context ${m.percent}%`}
          onPress={() => void setCollapsed($, false)}
        />,
      )
    }

    const compactButton = <Button key="compact" label="Compact" plain onPress={() => void compact($)} />
    const collapseButton = <Button key="collapse" label="–" plain role="dismiss" onPress={() => void setCollapsed($, true)} />

    if (isDesktop) {
      // Each bar gets an even share of what the labels and buttons leave, within bounds.
      const barW = Math.max(48, Math.min(200, Math.floor((cols * 8 - 520) / 2)))
      const { svg, width } = rowSvg({ m, isWarm, countdown, barW })
      const alt = `cache ${countdown}, ${m.hitPercent}% hit, context ${m.percent}%${m.autoCompactPercent !== null ? ` (auto-compact ${m.autoCompactPercent}%)` : ''}`
      return withBelow(
        <Box flexDirection="row" alignItems="center" gap={1}>
          <ui.Svg source={svg} alt={alt} width={width} height={H} />
          {compactButton}
          {collapseButton}
        </Box>,
      )
    }

    const [hit, miss] = bar(m.hitPercent)
    const ctx = level(m.percent)
    return withBelow(
      <Box gap="sm" alignItems="center">
        <Text tabular>
          <Text color={isWarm ? 'success' : 'inactive'}>● </Text>
          <Text dimColor>cache </Text>
          <Text color={isWarm ? 'success' : 'inactive'} weight="medium">
            {countdown}
          </Text>
          <Text> </Text>
          <Text color="success">{hit}</Text>
          <Text color="inactive">{miss}</Text>
          <Text weight="semibold"> {m.hitPercent}%</Text>
          <Text dimColor> hit</Text>
        </Text>
        <Text dimColor>│</Text>
        <Text tabular>
          <Text color={ctx}>{glyph(m.percent)} </Text>
          <Text dimColor>context </Text>
          <Text color={ctx} weight="semibold">
            {m.percent}%
          </Text>
          {m.autoCompactPercent !== null && <Text dimColor> (auto-compact {m.autoCompactPercent}%)</Text>}
        </Text>
        {compactButton}
        {collapseButton}
      </Box>,
    )
  })
}
