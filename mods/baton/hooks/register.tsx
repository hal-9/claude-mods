import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { AgentStats, Bump, Handoff, LoopStats, Phase, Window } from '../types'

const main = atom({ plugin: 'baton', key: 'main' } as const, null)
const agents = atom({ plugin: 'baton', key: 'agents' } as const, {})
const bumps = atom({ plugin: 'baton', key: 'bumps' } as const, [])
const phase = atom({ plugin: 'baton', key: 'phase' } as const, 'ok')
const enginePercent = atom({ plugin: 'baton', key: 'enginePercent' } as const, null)
const windowState = atom({ plugin: 'baton', key: 'window' } as const, null)

const HANDOFF_TOOL = 'mcp__baton__handoff'
const STORE_KEY = 'handoff'
// Wrap up this far into the engine's auto-compaction threshold, so the handoff lands before the summary does.
const COMPACT_HEADROOM = 0.85

type $ = EngineInterface

// What the next request re-sends (the status line's context_tokens formula).
const contextOf = (u: ModelUsage) =>
  u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

const k = (n: number) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(Math.abs(n) >= 10_000 ? 0 : 1)}k` : String(n))
const minutes = (ms: number) => Math.round(ms / 60_000)
const text = (t: string) => ({ type: 'text' as const, text: t })

const stopText = (reason: string) => `[baton] STOP. ${reason}.
Do not start new work and do not call more tools unless a single call is needed to finish a sentence of work already in flight.
Reply now with a HANDOFF for the REMAINING work only, in this shape:
1. Done: one line per finished item, with file paths.
2. Remaining: concrete, ordered items.
3. Next step: the exact first action a fresh agent should take.
4. Gotchas: anything that cost you time.
Your reply is forwarded to the main agent, which starts a fresh agent on the remaining work.`

const stoppedNote = (a: AgentStats) =>
  `[baton] Subagent "${a.description}" (${a.id}) was stopped early: ${a.stopReason}. Its result is a HANDOFF of the remaining work, not a finished task. Spawn a fresh subagent whose prompt is that handoff to continue; do not redo what it lists as done.`

const wrapUpNote = (reason: string) => `[baton] ${reason}. Wrap up now:
1. Start no new work. Let running subagents finish; spawn new ones only to continue a stopped one.
2. Update the files your work touched (task plan, docs, memory) so nothing lives only in this conversation.
3. Call the ${HANDOFF_TOOL} tool with a handoff for the REMAINING work only: done, remaining, exact next step, gotchas, files.
4. Then tell the user to start a fresh session in this directory; the handoff is injected there automatically.`

const handoffNote = (h: Handoff) => `[baton] Handoff from your previous session in this directory (written ${new Date(h.writtenAt).toISOString()} at ${h.percent}% context). Continue from it; do not redo what it lists as done. When baton tells you to wrap up, write the next handoff with the ${HANDOFF_TOOL} tool.

${h.text}`

// Filled by register(); top-level so the helpers below can read it.
const cfg = { mainMax: 70, agentMax: 30, agentMaxMs: 20 * 60_000, maxWorking: 250_000 }
// ponytail: one window for every loop; subagents on another model read slightly off.
const win: Window = { model: 200_000, compact: 200_000 }

// The engine's figures: model window, compaction window, auto-compact threshold.
async function refreshWindow($: $) {
  try {
    const u = await $.session.usage({ breakdown: 'summary' })
    win.model = u.context.window || win.model
    win.compact = u.context.breakdown?.rawMaxTokens || win.model
    win.autoCompactAt = u.context.breakdown?.autoCompactThreshold
  } catch {
    // not bound yet; keep what we have
  }
  await update($, windowState, () => ({ ...win }))
}

// Where main must wrap up: the tightest of its percent of the compaction window, the headroom
// before auto-compaction, and the absolute working budget above its baseline. `[limit, why]`.
function mainLimit(baseline: number): [number, string] {
  const candidates: [number, string][] = [
    [Math.round((cfg.mainMax / 100) * win.compact), `${cfg.mainMax}% of the ${k(win.compact)} compaction window`],
    [baseline + cfg.maxWorking, `${k(cfg.maxWorking)} working tokens above the ${k(baseline)} baseline`],
  ]
  if (win.autoCompactAt) {
    candidates.push([Math.round(COMPACT_HEADROOM * win.autoCompactAt), `${Math.round(COMPACT_HEADROOM * 100)}% of the ${k(win.autoCompactAt)} auto-compaction threshold`])
  }
  return candidates.reduce((a, b) => (b[0] < a[0] ? b : a))
}

// A subagent's working budget: its percent of the compaction window or the absolute cap, whichever is smaller.
function agentWorkingLimit(): [number, string] {
  const byPercent = Math.round((cfg.agentMax / 100) * win.compact)
  return byPercent < cfg.maxWorking ? [byPercent, `${cfg.agentMax}% of the compaction window`] : [cfg.maxWorking, 'the absolute working cap']
}

async function showStatus($: $) {
  const m = await read($, main)
  if (!m) return $.ui.status(undefined)
  const running = Object.values(await read($, agents)).filter(a => !a.endedAt)
  const ph = await read($, phase)
  let line = `baton ctx ${m.percent}% (${k(m.tokens)}/${k(m.window)}) Δ${m.lastDelta >= 0 ? '+' : ''}${k(m.lastDelta)} · work ${k(m.working)}, wrap-up at ${k(m.limit)}`
  if (running.length) line += ` · agents ${running.length} (max work ${k(Math.max(...running.map(a => a.working)))})`
  if (ph === 'wrap-up') line += ` · WRAP UP → call ${HANDOFF_TOOL}`
  if (ph === 'handoff-written') line += ' · handoff saved → start a fresh session'
  $.ui.status(line)
}

async function stopAgent($: $, a: AgentStats, reason: string) {
  const now = await $.clock.now()
  await update($, agents, all => ({ ...all, [a.id]: { ...all[a.id]!, stoppedAt: now, stopReason: reason } }))
  try {
    await $.session.append({ agentId: a.id, message: { type: 'user', content: [text(stopText(reason))] } })
    $.ui.toast(`baton: stopping subagent "${a.description}": ${reason}`)
  } catch {
    // the loop already ended; nothing to stop
  }
}

async function checkDurations($: $) {
  const now = await $.clock.now()
  for (const a of Object.values(await read($, agents))) {
    if (a.endedAt || a.stoppedAt || now - a.startedAt < cfg.agentMaxMs) continue
    await stopAgent($, a, `running ${minutes(now - a.startedAt)} min (limit ${minutes(cfg.agentMaxMs)} min)`)
  }
}

// ---------------------------------------------------------------------------
// The band above the prompt, in cache-meter's look so stacked bands read as one family.
// The desktop wraps sibling elements, so its row is one SVG.

// $.state refs are read as literals in the file that renders them.
const MAIN = { plugin: 'baton', key: 'main' } as const
const AGENTS = { plugin: 'baton', key: 'agents' } as const
const PHASE = { plugin: 'baton', key: 'phase' } as const
const COLLAPSED = { plugin: 'baton', key: 'collapsed' } as const

// Collapsed or not, remembered across sessions.
async function setCollapsed($: $, isCollapsed: boolean) {
  await $.state.set(COLLAPSED, isCollapsed)
  await $.store.set('collapsed', isCollapsed)
}

const ACCENT = '#8f8cf4'
const WARM = '#5fbf8f'
const AMBER = '#e0a43a'
const RED = '#e5675a'
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"
const H = 22
const BAR_H = 14
const CELL = 3
const SEGMENTS = 16

const PILL: Record<Phase, [label: string, hex: string, tone: 'success' | 'warning']> = {
  ok: ['on track', ACCENT, 'success'],
  'wrap-up': ['wrap up', AMBER, 'warning'],
  'handoff-written': ['handoff saved', WARM, 'success'],
}
const budgetHex = (p: number) => (p < 70 ? ACCENT : p < 100 ? AMBER : RED)
const budgetTone = (p: number) => (p < 70 ? 'success' : p < 100 ? 'warning' : 'error')

const noise = (x: number, y: number) => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}
// ponytail: per-class width estimate for the system font; every string here is ours.
const charW = (c: string) => (/[il.,:;'|· ()]/.test(c) ? 0.3 : /[mwMW]/.test(c) ? 0.86 : /[A-Z0-9$%]/.test(c) ? 0.64 : 0.54)
const textW = (s: string, size: number) => Math.round([...s].reduce((w, c) => w + charW(c), 0) * size)

// A rounded track, dithered up to `percent`, sparse at the start and dense toward the head.
function ditherBar(x: number, w: number, percent: number, color: string) {
  const y = (H - BAR_H) / 2
  const cols = Math.floor((w * Math.min(100, percent)) / 100 / CELL)
  const dots: string[] = []
  for (let c = 0; c < cols; c++) {
    const density = 0.35 + 0.6 * Math.pow(c / Math.max(1, cols), 1.2)
    for (let r = 0; r < Math.floor(BAR_H / CELL); r++) {
      if (noise(c + 3, r) < density) dots.push(`<rect x="${c * CELL + 1}" y="${r * CELL + 1}" width="2" height="2"/>`)
    }
  }
  return `<g transform="translate(${x},${y})"><clipPath id="bb"><rect width="${w}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath>
<rect class="k" width="${w}" height="${BAR_H}" rx="${BAR_H / 2}"/><g clip-path="url(#bb)" fill="${color}">${dots.join('')}</g></g>`
}

type Figure = { value: string; word: string }
type BandRow = { phase: Phase; budget: number; used: Figure; agents: Figure | null }

function bandSvg(r: BandRow, barW: number) {
  const [pill, pillHex] = PILL[r.phase]
  const parts: string[] = []
  const figure = (x: number, f: Figure) => {
    parts.push(`<text x="${x}" y="${H / 2 + 4.5}" font-size="12.5"><tspan class="t" font-weight="600">${f.value}</tspan><tspan class="m" dx="5">${f.word}</tspan></text>`)
    return x + textW(f.value, 12.5) + 5 + textW(f.word, 12.5)
  }
  parts.push(`<circle cx="5" cy="${H / 2}" r="4" fill="${pillHex}"/>`)
  parts.push(`<text class="t" x="16" y="${H / 2 + 4.5}" font-size="13" font-weight="500">Baton</text>`)
  // The pill starts where cache-meter's do, so the bands line up.
  const pillX = 16 + textW('Keepwarm', 13) + 8
  const pillW = 16 + textW(pill, 11)
  parts.push(`<rect x="${pillX}" y="${(H - 16) / 2}" width="${pillW}" height="16" rx="8" fill="${pillHex}"/>`)
  parts.push(`<text x="${pillX + pillW / 2}" y="${H / 2 + 4}" text-anchor="middle" font-size="11" font-weight="600" fill="#ffffff">${pill}</text>`)
  let x = pillX + pillW + 10
  parts.push(ditherBar(x, barW, r.budget, budgetHex(r.budget)))
  x = figure(x + barW + 8, r.used)
  if (r.agents) {
    x += 14
    parts.push(`<rect class="tk" x="${x}" y="${H / 2 - 6}" width="1" height="12"/>`)
    x = figure(x + 15, r.agents)
  }
  const W = x + 4
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" font-variant-numeric="tabular-nums">
<style>.t{fill:#1f1f1f}.m{fill:#8a8a8a}.k{fill:#e4e4e2}.tk{fill:#c4c4c0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{fill:#2c2c2c}.tk{fill:#4a4a4a}}</style>
${parts.join('\n')}</svg>`
  return { W, source }
}

// A hairline that sets this band apart from the mod bands drawn beneath it.
const dividerSvg = (w: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="9" viewBox="0 0 ${w} 9" preserveAspectRatio="none"><style>rect{fill:#00000026}@media (prefers-color-scheme: dark){rect{fill:#ffffff38}}</style><rect y="4" width="${w}" height="1"/></svg>`

// ---------------------------------------------------------------------------

export const register: Register = (on, options) => {
  cfg.mainMax = Number(options.mainWrapUpPercent ?? 70)
  cfg.agentMax = Number(options.agentMaxPercent ?? 30)
  cfg.agentMaxMs = Number(options.agentMaxMinutes ?? 20) * 60_000
  cfg.maxWorking = Number(options.maxWorkingTokens ?? 250_000)
  const lastTools: Record<string, string[]> = {}
  let nagAt = 0
  let handoff: Handoff | null = null

  on('session.start', async ($, e, next) => {
    await refreshWindow($)
    await $.tool.register({
      name: 'handoff',
      description:
        'Save a handoff for the next session: what is done, what remains, the exact next step, gotchas and files. Call it when baton tells you to wrap up. The next session started in this directory reads it automatically.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The handoff, markdown, remaining work only.' } },
        required: ['text'],
      },
      isDeferred: false,
    })
    await $.command.register({
      name: 'baton',
      description: 'Context budget, subagent guard and handoff status',
      argumentHint: '[clear]',
    })

    const stored = (await $.store.get(STORE_KEY)) as Handoff | undefined
    const sessionId = await $.session.id()
    const isOurs = stored?.cwd === e.cwd && stored.sessionId !== sessionId && (!stored.takenBy || stored.takenBy === sessionId)
    if (stored && isOurs) {
      handoff = { ...stored, takenBy: sessionId }
      if (!stored.takenBy) {
        await $.store.set(STORE_KEY, handoff)
        $.ui.toast(`baton: picked up the handoff written ${new Date(stored.writtenAt).toLocaleString()}`)
      }
    }
    await $.state.set(COLLAPSED, (await $.store.get('collapsed')) === true)
    $.clock.every(30_000, () => void checkDurations($))
    await showStatus($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (handoff && !handoff.injectedAt) {
      handoff = { ...handoff, injectedAt: await $.clock.now() }
      await $.store.set(STORE_KEY, handoff)
      await $.session.append({ message: { type: 'user', content: [text(handoffNote(handoff))] } })
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if ('agentId' in r && r.agentId) {
      const id = r.agentId
      const now = await $.clock.now()
      const [limit] = agentWorkingLimit()
      await update($, agents, all => ({
        ...all,
        [id]: {
          id, description: e.description, type: e.subagentType, startedAt: now,
          tokens: 0, window: win.model, percent: 0, steps: 0, lastDelta: 0, baseline: 0, working: 0, limit, updatedAt: now,
        },
      }))
    }
    return r
  })

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (!r.usage) return r
    const now = await $.clock.now()
    const key = e.agentId ?? 'main'
    const tools = lastTools[key] ?? []
    lastTools[key] = r.toolUses.map(t => t.name)
    const tokens = contextOf(r.usage)
    const percent = Math.round((tokens / win.model) * 100)
    // The first request's size is the loop's baseline (system prompt, tools, memory); work is what grew after it.
    const baselineOf = (prev: LoopStats | null | undefined) => (prev?.steps ? prev.baseline : tokens)
    const grow = (prev: LoopStats | null | undefined, limit: number): LoopStats => {
      const baseline = baselineOf(prev)
      return { tokens, window: win.model, percent, steps: (prev?.steps ?? 0) + 1, lastDelta: tokens - (prev?.tokens ?? 0), baseline, working: tokens - baseline, limit, updatedAt: now }
    }
    let delta = 0

    if (e.agentId) {
      const id = e.agentId
      const [workLimit, why] = agentWorkingLimit()
      const prev = (await read($, agents))[id]
      const stats: AgentStats = {
        ...(prev ?? { id, description: '(unlisted)', type: 'unknown', startedAt: now }),
        ...grow(prev, baselineOf(prev) + workLimit),
      }
      delta = stats.lastDelta
      await update($, agents, cur => ({ ...cur, [id]: stats }))
      if (!stats.stoppedAt && stats.working >= workLimit) {
        await stopAgent($, stats, `your working context grew to ${k(stats.working)} tokens (limit ${k(workLimit)}, ${why})`)
      }
    } else {
      const prev = await read($, main)
      const [limit, why] = mainLimit(baselineOf(prev))
      const stats = grow(prev, limit)
      delta = stats.lastDelta
      await update($, main, () => stats)
      const ph = await read($, phase)
      if (ph !== 'handoff-written' && tokens >= limit && percent >= nagAt + 5) {
        nagAt = percent
        await update($, phase, () => 'wrap-up')
        await $.session.append({ message: { type: 'user', content: [text(wrapUpNote(`Your context is at ${k(tokens)} tokens (${percent}%), past the wrap-up limit of ${k(limit)}: ${why}`))] } })
        $.ui.toast(`baton: context at ${k(tokens)} (${percent}%), wrapping up`)
      }
    }

    const bump: Bump = { at: now, agentId: e.agentId, delta, tools: tools.length ? tools : ['(start)'], percentAfter: percent }
    await update($, bumps, list => [...list, bump].slice(-60))
    await showStatus($)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const id = e.agentId
      const now = await $.clock.now()
      const a = (await read($, agents))[id]
      await update($, agents, all => (all[id] ? { ...all, [id]: { ...all[id]!, endedAt: now } } : all))
      if (a?.stoppedAt) {
        await $.session.append({ message: { type: 'user', content: [text(stoppedNote(a))] } })
      }
      await showStatus($)
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await refreshWindow($)
    await update($, enginePercent, () => e.context.percent ?? null)
    return next(e)
  })

  on('tool.call', { tool: HANDOFF_TOOL }, async ($, e) => {
    if (e.agentId) return { deny: 'Subagents do not save handoffs; reply with the handoff as your final message instead.' }
    const body = String(e.text ?? '').trim()
    if (!body) return { deny: 'A handoff needs text.' }
    // the tool may run before this step's usage landed in `main`; the engine's figure is current
    const percent = (await $.session.usage()).context.percent ?? (await read($, main))?.percent ?? 0
    const h: Handoff = { cwd: await $.session.cwd(), sessionId: await $.session.id(), writtenAt: await $.clock.now(), percent, text: body }
    await $.store.set(STORE_KEY, h)
    await update($, phase, () => 'handoff-written')
    $.ui.toast('baton: handoff saved, start a fresh session to continue')
    await showStatus($)
    return { result: 'Handoff saved. Tell the user to start a fresh session in this directory; baton injects the handoff there.' }
  })

  on('command.run', { command: 'baton' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await $.store.delete(STORE_KEY)
      handoff = null
      return { text: 'baton: stored handoff cleared.' }
    }
    const m = await read($, main)
    const ph = await read($, phase)
    const eng = await read($, enginePercent)
    const list = Object.values(await read($, agents))
    const stored = (await $.store.get(STORE_KEY)) as Handoff | undefined
    const now = await $.clock.now()
    const [, mainWhy] = mainLimit(m?.baseline ?? 0)
    const [agentLimit, agentWhy] = agentWorkingLimit()
    const lines = [
      `baton · context budget`,
      `window: ${k(win.model)} model, ${k(win.compact)} compaction${win.autoCompactAt ? `, auto-compacts at ${k(win.autoCompactAt)}` : ', auto-compaction off'}`,
      m
        ? `main: ${m.percent}% (${k(m.tokens)} / ${k(m.window)}), baseline ${k(m.baseline)}, working ${k(m.working)}, ${m.steps} requests${eng === null ? '' : `, engine says ${eng}%`}`
        : 'main: no model request measured yet',
      `phase: ${ph}${m ? ` (wrap-up at ${k(m.limit)}: ${mainWhy})` : ''}`,
      `agents (working limit ${k(agentLimit)}: ${agentWhy}; ${minutes(cfg.agentMaxMs)} min):`,
      ...(list.length
        ? list.map(a => {
            const state = a.endedAt ? 'ended  ' : a.stoppedAt ? 'stopped' : 'running'
            const reason = a.stopReason ? ` · ${a.stopReason}` : ''
            return `  ${state} work ${k(a.working).padStart(5)} ${String(minutes((a.endedAt ?? now) - a.startedAt)).padStart(3)} min  "${a.description}"${reason}`
          })
        : ['  none']),
      'biggest context bumps:',
      ...[...(await read($, bumps))]
        .sort((x, y) => y.delta - x.delta)
        .slice(0, 5)
        .map(b => `  +${k(b.delta).padStart(6)} → ${b.percentAfter}%  ${b.tools.join(', ')}${b.agentId ? '  (agent)' : ''}`),
      stored
        ? `handoff: saved ${new Date(stored.writtenAt).toLocaleString()} at ${stored.percent}% · ${stored.takenBy ? `taken by ${stored.takenBy === (await $.session.id()) ? 'this session' : 'an earlier session'}` : 'not yet taken'} · /baton clear removes it`
        : 'handoff: none stored',
    ]
    return { text: lines.join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { value: m } = await $.state.get(MAIN)
    if (!m || e.props.hasSurvey) return next(e)
    const { value: all = {} } = await $.state.get(AGENTS)
    const { value: ph = 'ok' } = await $.state.get(PHASE)
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    // Another mod's band rides along beneath this one; the engine's own band is empty.
    const drawn = await next(e)
    const below = drawn.type !== 'engine' ? drawn : null
    const isDesktop = e.surface !== 'terminal' && 'Svg' in ui
    const cols = e.props.bodyColumns || 100

    // How far main is toward its wrap-up limit, and the biggest running subagent.
    const budget = Math.round((m.tokens / Math.max(1, m.limit)) * 100)
    const used = { value: k(m.tokens), word: `of ${k(m.limit)} wrap-up` }
    const running = Object.values(all).filter(a => !a.endedAt)
    const agents = running.length
      ? { value: String(running.length), word: `${running.length === 1 ? 'agent' : 'agents'}, max work ${k(Math.max(...running.map(a => a.working)))} of ${k(agentWorkingLimit()[0])}` }
      : null
    const [pill, , tone] = PILL[ph]
    const alt = `baton ${pill}, ${used.value} ${used.word}${agents ? `, ${agents.value} ${agents.word}` : ''}`

    let row
    if (isDesktop) {
      const { W, source } = bandSvg({ phase: ph, budget, used, agents }, Math.max(48, Math.min(200, Math.floor((cols * 8 - 520) / 2))))
      row = <ui.Svg key="baton" source={source} alt={alt} width={W} height={H} />
    } else {
      const filled = Math.round((Math.min(100, budget) / 100) * SEGMENTS)
      row = (
        <Box key="baton" gap="sm" alignItems="center">
          <Text tabular>
            <Text color={tone}>● </Text>
            <Text dimColor>baton </Text>
            <Text color={tone} weight="medium">{pill}</Text>
            <Text> </Text>
            <Text color={budgetTone(budget)}>{'▮'.repeat(filled)}</Text>
            <Text color="inactive">{'▯'.repeat(SEGMENTS - filled)}</Text>
            <Text weight="semibold"> {used.value}</Text>
            <Text dimColor> {used.word}</Text>
          </Text>
          {agents && <Text dimColor>│</Text>}
          {agents && (
            <Text tabular>
              <Text weight="semibold">{agents.value}</Text>
              <Text dimColor> {agents.word}</Text>
            </Text>
          )}
        </Box>
      )
    }
    // An accordion like cache-meter's and relay's: the header line folds and unfolds the row.
    const { value: isCollapsed = false } = await $.state.get(COLLAPSED)
    const band = (
      <Box key="band" flexDirection="column" gap={isDesktop ? 'xs' : 0} paddingX={isDesktop ? 'xs' : 0} hover={{ backgroundColor: '#8080801a' }}>
        <Button
          key="toggle"
          plain
          dimColor
          hover={{ dimColor: false, bold: true }}
          label={`${isCollapsed ? '▸' : '▾'} baton · ${pill} · ${used.value} of ${k(m.limit)}${agents ? ` · ${agents.value} ${running.length === 1 ? 'agent' : 'agents'}` : ''}`}
          onPress={() => void setCollapsed($, !isCollapsed)}
        />
        {!isCollapsed && row}
      </Box>
    )
    if (!below) return band
    const dividerW = Math.max(180, Math.min(1600, cols * 8 - 96))
    return (
      <Box flexDirection="column" gap={isDesktop ? 'sm' : 0} paddingTop={isDesktop ? 'xs' : 0}>
        {band}
        {isDesktop
          ? <ui.Svg source={dividerSvg(dividerW)} alt="" width={dividerW} height={9} />
          : <Text dimColor>{'─'.repeat(Math.max(8, cols - 2))}</Text>}
        {below}
      </Box>
    )
  })
}
