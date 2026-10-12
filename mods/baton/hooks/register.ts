import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { AgentStats, Bump, Handoff, LoopStats, Phase } from '../types'

const main = atom({ plugin: 'baton', key: 'main' } as const, null)
const agents = atom({ plugin: 'baton', key: 'agents' } as const, {})
const bumps = atom({ plugin: 'baton', key: 'bumps' } as const, [])
const phase = atom({ plugin: 'baton', key: 'phase' } as const, 'ok')
const enginePercent = atom({ plugin: 'baton', key: 'enginePercent' } as const, null)

const HANDOFF_TOOL = 'mcp__baton__handoff'
const STORE_KEY = 'handoff'

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

const wrapUpNote = (percent: number, limit: number) => `[baton] Your context is at ${percent}% (wrap-up limit ${limit}%). Wrap up now:
1. Start no new work. Let running subagents finish; spawn new ones only to continue a stopped one.
2. Update the files your work touched (task plan, docs, memory) so nothing lives only in this conversation.
3. Call the ${HANDOFF_TOOL} tool with a handoff for the REMAINING work only: done, remaining, exact next step, gotchas, files.
4. Then tell the user to start a fresh session in this directory; the handoff is injected there automatically.`

const handoffNote = (h: Handoff) => `[baton] Handoff from your previous session in this directory (written ${new Date(h.writtenAt).toISOString()} at ${h.percent}% context). Continue from it; do not redo what it lists as done. When baton tells you to wrap up, write the next handoff with the ${HANDOFF_TOOL} tool.

${h.text}`

// Filled by register(); top-level so the helpers below can read it.
const cfg = { mainMax: 70, agentMax: 30, agentMaxMs: 20 * 60_000 }
// ponytail: one window for every loop; subagents on another model read slightly off.
let window = 200_000

async function showStatus($: $) {
  const m = await read($, main)
  if (!m) return $.ui.status(undefined)
  const running = Object.values(await read($, agents)).filter(a => !a.endedAt)
  const ph = await read($, phase)
  let line = `baton ctx ${m.percent}% (${k(m.tokens)}/${k(m.window)}) Δ${m.lastDelta >= 0 ? '+' : ''}${k(m.lastDelta)}`
  if (running.length) line += ` · agents ${running.length} (max ${Math.max(...running.map(a => a.percent))}%)`
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


export const register: Register = (on, options) => {
  cfg.mainMax = Number(options.mainWrapUpPercent ?? 70)
  cfg.agentMax = Number(options.agentMaxPercent ?? 30)
  cfg.agentMaxMs = Number(options.agentMaxMinutes ?? 20) * 60_000
  const lastTools: Record<string, string[]> = {}
  let nagAt = 0
  let handoff: Handoff | null = null

  on('session.start', async ($, e, next) => {
    try {
      window = (await $.session.usage()).context.window || window
    } catch {
      // not bound yet; keep the default
    }
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
      await update($, agents, all => ({
        ...all,
        [id]: { id, description: e.description, type: e.subagentType, startedAt: now, tokens: 0, window, percent: 0, steps: 0, lastDelta: 0, updatedAt: now },
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
    const percent = Math.round((tokens / window) * 100)
    const grow = (prev: LoopStats | null | undefined): LoopStats => ({
      tokens, window, percent, steps: (prev?.steps ?? 0) + 1, lastDelta: tokens - (prev?.tokens ?? 0), updatedAt: now,
    })
    let delta = 0

    if (e.agentId) {
      const id = e.agentId
      const all = await read($, agents)
      const prev = all[id] ?? { id, description: '(unlisted)', type: 'unknown', startedAt: now, ...grow(null), tokens: 0 }
      const next_ = { ...prev, ...grow(prev) }
      delta = next_.lastDelta
      await update($, agents, cur => ({ ...cur, [id]: { ...(cur[id] ?? prev), ...grow(cur[id] ?? prev) } }))
      if (!next_.stoppedAt && percent >= cfg.agentMax) {
        await stopAgent($, next_, `your context is at ${percent}% (limit ${cfg.agentMax}%)`)
      }
    } else {
      const prev = await read($, main)
      delta = tokens - (prev?.tokens ?? 0)
      await update($, main, cur => grow(cur))
      const ph = await read($, phase)
      if (ph !== 'handoff-written' && percent >= cfg.mainMax && percent >= nagAt + 5) {
        nagAt = percent
        await update($, phase, () => 'wrap-up')
        await $.session.append({ message: { type: 'user', content: [text(wrapUpNote(percent, cfg.mainMax))] } })
        $.ui.toast(`baton: context at ${percent}%, wrapping up`)
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
    if (e.context.window) window = e.context.window
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
    const lines = [
      `baton · context budget`,
      m
        ? `main: ${m.percent}% (${k(m.tokens)} / ${k(m.window)}), ${m.steps} requests${eng === null ? '' : `, engine says ${eng}%`}`
        : 'main: no model request measured yet',
      `phase: ${ph} (wrap-up at ${cfg.mainMax}%)`,
      `agents (limit ${cfg.agentMax}% / ${minutes(cfg.agentMaxMs)} min):`,
      ...(list.length
        ? list.map(a => {
            const state = a.endedAt ? 'ended  ' : a.stoppedAt ? 'stopped' : 'running'
            const reason = a.stopReason ? ` · ${a.stopReason}` : ''
            return `  ${state} ${String(a.percent).padStart(3)}% ${String(minutes((a.endedAt ?? now) - a.startedAt)).padStart(3)} min  "${a.description}"${reason}`
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
}
