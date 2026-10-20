import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Reading } from '../types'
import type { State } from './keepwarm'
import { setReading } from './meter'

// $.state refs are read as literals in the file that uses them, so meter.ts keeps its own copies.
const READING = { plugin: 'cache-meter', key: 'reading' } as const
const TICK = { plugin: 'cache-meter', key: 'tick' } as const
const COLLAPSED = { plugin: 'cache-meter', key: 'collapsed' } as const
import { coldUsd, DEFAULT_WINDOW_MS, fmtDuration, fmtTok, fmtUsd, freshState, isCold, keepwarm, nextPing, PING_AFTER_MS, startWindow, stop } from './keepwarm'


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

// ponytail: per-class width estimate for the system font; keepwarm's stop reasons are the only text not ours.
const charW = (c: string) => (/[il.,:;'|· ()]/.test(c) ? 0.3 : /[mwMW]/.test(c) ? 0.86 : /[A-Z0-9$%]/.test(c) ? 0.64 : 0.54)
const textW = (s: string, size: number) => Math.round([...s].reduce((w, c) => w + charW(c), 0) * size)

// Both rows' labels take the width of the longer one, so their pills line up.
const LABEL_W = textW('Keepwarm', 13)
const PILL_X = 16 + LABEL_W + 8

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

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

  x = head(parts, 'Cache', countdown, warm)
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
  return { parts, width: x + 4, isWarm }
}

// The dot, the label in its column and the pill: how both rows start. Returns where the row goes on.
function head(parts: string[], label: string, pill: string, color: string) {
  parts.push(`<circle cx="5" cy="${H / 2}" r="4" fill="${color}"/>`)
  parts.push(`<text class="t" x="16" y="${H / 2 + 4.5}" font-size="13" font-weight="500">${label}</text>`)
  const pillW = 16 + textW(pill, 11)
  parts.push(`<rect x="${PILL_X}" y="${(H - 16) / 2}" width="${pillW}" height="16" rx="8" fill="${color}"/>`)
  parts.push(`<text x="${PILL_X + pillW / 2}" y="${H / 2 + 4}" text-anchor="middle" font-size="11" font-weight="600" fill="#ffffff">${esc(pill)}</text>`)
  return PILL_X + pillW + 10
}

type Kw = { mode: 'on' | 'off' | 'stopped'; pill: string; detail: string; rewrite: { value: string; word: string } | null; isCold: boolean }

// The keepwarm row: the window, what it waits for, and what letting the cache go cold costs.
function kwOf(s: State, now: number): Kw {
  const cold = isCold(s, now)
  const usd = s.ctx && !s.compacted ? coldUsd(s) : null
  const rewrite = usd == null ? null : { value: fmtUsd(usd), word: cold ? `next send rewrites ${fmtTok(s.ctx)}` : `cold rewrite of ${fmtTok(s.ctx)}` }
  if (s.deadline && now < s.deadline) {
    const last = s.last ? ` · last ping ${fmtTok(s.last.read)} read, ${fmtUsd(s.last.usd)}` : ''
    return { mode: 'on', pill: `${fmtDuration(s.deadline - now)} left`, detail: nextPing(s, now) + last, rewrite, isCold: cold }
  }
  if (s.stopped) return { mode: 'stopped', pill: 'stopped', detail: s.stopped, rewrite, isCold: cold }
  return { mode: 'off', pill: 'off', detail: '', rewrite, isCold: cold }
}

const kwColor = (k: Kw) => (k.mode === 'stopped' ? AMBER : k.mode === 'on' && !k.isCold ? WARM : COLD)

function kwSvg(k: Kw) {
  const parts: string[] = []
  let x = head(parts, 'Keepwarm', k.pill, kwColor(k))
  // The price first: the free text after it is the one whose width is only estimated.
  if (k.rewrite) {
    parts.push(`<text x="${x}" y="${H / 2 + 4.5}" font-size="12.5"><tspan class="${k.isCold ? 'hot' : 't'}" font-weight="600">${k.rewrite.value}</tspan><tspan class="m" dx="5">${esc(k.rewrite.word)}</tspan></text>`)
    x += textW(k.rewrite.value, 12.5) + 5 + textW(k.rewrite.word, 12.5) + 14
    if (k.detail) {
      parts.push(`<rect class="tk" x="${x}" y="${H / 2 - 6}" width="1" height="12"/>`)
      x += 15
    }
  }
  if (k.detail) {
    const detail = clip(k.detail, 72)
    parts.push(`<text class="m" x="${x}" y="${H / 2 + 4.5}" font-size="12.5">${esc(detail)}</text>`)
    x += textW(detail, 12.5)
  }
  return { parts, width: x + 4, isWarm: false }
}

// Wraps a row's parts at a width shared by both rows, so the buttons beside them line up.
const svgOf = ({ parts, isWarm }: { parts: string[]; isWarm: boolean }, W: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" font-variant-numeric="tabular-nums">
<style>
.t{fill:#1f1f1f}.m{fill:#8a8a8a}.k{fill:#e4e4e2}.tk{fill:#c4c4c0}.mk{fill:#1f1f1f;opacity:.55}.hot{fill:${RED}}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{fill:#2c2c2c}.tk{fill:#4a4a4a}.mk{fill:#ececec}}
${isWarm ? `.t0,.t1,.t2,.t3{animation:tw 2.6s ease-in-out infinite}
.t1{animation-duration:3.1s;animation-delay:-.7s}.t2{animation-duration:2.2s;animation-delay:-1.3s}.t3{animation-duration:3.6s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:.45}}
@media (prefers-reduced-motion: reduce){.t0,.t1,.t2,.t3{animation:none}}` : ''}
</style>
${parts.join('\n')}
</svg>`

// A hairline that sets this band apart from the mod bands drawn beneath it.
// 9px tall with the line centred: a 1px image scaled to the slot rounds away.
const dividerSvg = (w: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="9" viewBox="0 0 ${w} 9" preserveAspectRatio="none"><style>rect{fill:#00000026}@media (prefers-color-scheme: dark){rect{fill:#ffffff38}}</style><rect y="4" width="${w}" height="1"/></svg>`

// ---------------------------------------------------------------------------

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
  // Keepwarm and the cold-send guard work on this state; the band below reads it.
  const s = freshState()
  keepwarm(on, s)

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { value: m } = await $.state.get(READING)
    const now = await $.clock.now()
    const kw = kwOf(s, now)
    // The keepwarm row comes with the meter, or alone while a window is armed or stopped before the first reading.
    if ((!m && kw.mode === 'off') || e.props.hasSurvey) return next(e)
    await $.state.get(TICK)
    const { value: isCollapsed = false } = await $.state.get(COLLAPSED)

    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const left = m ? m.at + ttlMs - now : 0
    const isWarm = left > 0
    const countdown = isWarm ? `${minutes(left)}m` : 'cold'
    // Another mod's band (relay's buttons) rides along beneath the meter; the engine's own band is empty.
    const drawn = await next(e)
    const below = drawn.type !== 'engine' ? drawn : null
    const isDesktop = e.surface !== 'terminal' && 'Svg' in ui
    const cols = e.props.bodyColumns || 100
    // savvy-progress's row width: about 8 CSS px per column, less the slot's padding.
    const dividerW = Math.max(180, Math.min(1600, cols * 8 - 96))

    const divider = isDesktop
      ? <ui.Svg source={dividerSvg(dividerW)} alt="separator" width={dividerW} height={9} />
      : <Text dimColor>{'─'.repeat(Math.max(8, cols - 2))}</Text>
    // An accordion: the header line folds and unfolds the rows, and the whole band lights while the pointer is on it.
    const summary = [m && `cache ${countdown}`, m && `context ${m.percent}%`, `keepwarm ${kw.mode === 'on' ? kw.pill : kw.mode}`]
    const header = (
      <Button
        key="toggle"
        plain
        dimColor
        hover={{ dimColor: false, bold: true }}
        label={`${isCollapsed ? '▸' : '▾'} cache-meter · ${summary.filter(Boolean).join(' · ')}`}
        onPress={() => void setCollapsed($, !isCollapsed)}
      />
    )
    const withBelow = (rows?: RenderChildren) => (
      <Box flexDirection="column" gap={isDesktop ? 'sm' : 0} paddingTop={isDesktop ? 'xs' : 0}>
        <Box key="band" flexDirection="column" gap={isDesktop ? 'xs' : 0} paddingX={isDesktop ? 'xs' : 0} hover={{ backgroundColor: '#8080801a' }}>
          {header}
          {rows}
        </Box>
        {below && divider}
        {below}
      </Box>
    )

    if (isCollapsed) return withBelow()

    // A button with a hint card, hidden at rest and shown while the pointer is over the button's keyed Box.
    // The card opens onto the other row, so the band's edge never clips it.
    const tipped = (key: string, tip: string, isAbove: boolean, button: RenderChildren) => (
      <Box key={`${key}-tip`} position="relative">
        {button}
        <Box
          position="absolute"
          right={0}
          {...(isAbove ? { bottom: 1 } : { top: 1 })}
          display="none"
          hover={{ display: 'flex' }}
          backgroundColor="#3a3a38"
          borderStyle="round"
          borderColor="#5c5c58"
          paddingX={1}
        >
          <Text color="#ffffff">{tip}</Text>
        </Box>
      </Box>
    )
    const compactButton = tipped(
      'compact',
      'Summarise the chat now to free context; the next send re-caches it',
      false,
      <Button key="compact" label="Compact" variant="secondary" onPress={() => void compact($)} />,
    )
    // Under the meter the card opens upward; alone, the keepwarm row has nothing above it.
    const kwButton = kw.mode === 'on'
      ? tipped('kw', 'Stop the pings; the cache then expires an hour after your last turn', Boolean(m),
        <Button key="kw" label="Stop" variant="secondary" onPress={() => void stop($, s, null, true)} />)
      : tipped('kw', 'Ping the cache after 50 idle minutes, for 6 hours, so it never goes cold', Boolean(m),
        <Button key="kw" label="Keep warm" variant="primary" onPress={() => void startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)} />)
    const kwAlt = `keepwarm ${kw.pill}${kw.rewrite ? `, ${kw.rewrite.value} ${kw.rewrite.word}` : ''}${kw.detail ? `, ${kw.detail}` : ''}`

    if (isDesktop) {
      // Each bar gets an even share of what the labels and buttons leave, within bounds.
      const barW = Math.max(48, Math.min(200, Math.floor((cols * 8 - 520) / 2)))
      const meter = m && rowSvg({ m, isWarm, countdown, barW })
      const warmRow = kwSvg(kw)
      const W = Math.max(meter?.width ?? 0, warmRow.width)
      const alt = m && `cache ${countdown}, ${m.hitPercent}% hit, context ${m.percent}%${m.autoCompactPercent !== null ? ` (auto-compact ${m.autoCompactPercent}%)` : ''}`
      return withBelow([
        meter && alt && (
          <Box key="meter" flexDirection="row" alignItems="center" gap={1}>
            <ui.Svg source={svgOf(meter, W)} alt={alt} width={W} height={H} />
            {compactButton}
          </Box>
        ),
        <Box key="keepwarm" flexDirection="row" alignItems="center" gap={1}>
          <ui.Svg source={svgOf(warmRow, W)} alt={kwAlt} width={W} height={H} />
          {kwButton}
        </Box>,
      ])
    }

    const kwTone = kw.mode === 'stopped' ? 'warning' : kw.mode === 'on' && !kw.isCold ? 'success' : 'inactive'
    const warmRow = (
      <Box key="keepwarm" gap="sm" alignItems="center">
        <Text tabular>
          <Text color={kwTone}>● </Text>
          <Text dimColor>keepwarm </Text>
          <Text color={kwTone} weight="medium">{kw.pill}</Text>
        </Text>
        {kw.rewrite && (
          <Text tabular>
            <Text color={kw.isCold ? 'error' : undefined} weight="semibold">{kw.rewrite.value}</Text>
            <Text dimColor> {kw.rewrite.word}</Text>
          </Text>
        )}
        {kw.rewrite && kw.detail && <Text dimColor>│</Text>}
        {kw.detail && <Text dimColor>{clip(kw.detail, 72)}</Text>}
        {kwButton}
      </Box>
    )
    if (!m) return withBelow(warmRow)

    const [hit, miss] = bar(m.hitPercent)
    const ctx = level(m.percent)
    return withBelow([
      <Box key="meter" gap="sm" alignItems="center">
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
      </Box>,
      warmRow,
    ])
  })
}
