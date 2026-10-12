import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionUsage } from 'claude-code'

type Win = { model: number; compact?: number; autoCompactAt?: number }
const usage = (tokens: number) => ({
  input_tokens: tokens,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  model: 'test-model',
})

// The engine beneath the plugin: every op and event the mod raises is answered here.
function engineBelow(on: On, reports: { tokens: number }, win: Win = { model: 200_000 }) {
  mock.store(on)
  const session = mock.session(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  const status = { line: undefined as string | undefined }
  const sessionId = { value: 'session-1' }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', ($, e) => {
    const breakdown = e.breakdown ? { rawMaxTokens: win.compact ?? win.model, autoCompactThreshold: win.autoCompactAt } : undefined
    return { value: { startedAt: 0, context: { window: win.model, percent: 1, breakdown }, rateLimits: [] } as unknown as SessionUsage }
  })
  on('session.id', () => ({ value: sessionId.value }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('tool.register', () => ({ value: { tool: 'mcp__baton__handoff' } }))
  on('command.register', () => ({ value: { command: 'baton' } }))
  on('ui.status', ($, e) => {
    status.line = e.text
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('agent.spawn', () => ({ model: 'test-model', agentId: 'agent-1' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'Read', input: {} }], stopReason: 'end_turn' as const, usage: usage(reports.tokens) }
  })
  return { session, clock, status, sessionId }
}

const spawnOf = (description: string) => ({
  tool_use_id: 'tu-1', prompt: 'explore', description, subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' as const }, parentModel: 'test-model', background: false, fork: false,
})

async function step($: Engine, index: number, agentId?: string) {
  const stream = $.turn.step({ turnId: 'turn-1', index, model: 'test-model', messageCount: 1, agentId })
  for await (const _chunk of stream) {
    // drain
  }
}

const notesTo = (rows: readonly { agentId?: string; message: { content: unknown } }[], agentId?: string) =>
  rows.filter(r => r.agentId === agentId).map(r => JSON.stringify(r.message.content))

test('measures main context per request and asks for a wrap-up past the limit', async ($, on) => {
  const reports = { tokens: 20_000 }
  const { session, status } = engineBelow(on, reports)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await step($, 0)
  expect(status.line).toContain('ctx 10% (20k/200k) Δ+20k · work 0, wrap-up at 140k')

  reports.tokens = 150_000
  await step($, 1)
  expect(status.line).toContain('ctx 75% (150k/200k) Δ+130k · work 130k')
  expect(status.line).toContain('WRAP UP')

  const notes = notesTo(session.appended(), undefined)
  expect(notes.length).toBe(1)
  expect(notes[0]).toContain('Wrap up now')
  expect(notes[0]).toContain('70% of the 200k compaction window')

  // no second nag until it grew another 5 points
  reports.tokens = 156_000
  await step($, 2)
  expect(notesTo(session.appended(), undefined).length).toBe(1)
  reports.tokens = 162_000
  await step($, 3)
  expect(notesTo(session.appended(), undefined).length).toBe(2)
})

test('wraps up at the absolute working cap on a large window', { options: { mainWrapUpPercent: 90 } }, async ($, on) => {
  const reports = { tokens: 240_000 }
  const { session, status } = engineBelow(on, reports, { model: 1_000_000 })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await step($, 0)
  expect(status.line).toContain('ctx 24% (240k/1000k) Δ+240k · work 0, wrap-up at 490k')

  reports.tokens = 480_000
  await step($, 1)
  expect(notesTo(session.appended(), undefined).length).toBe(0)

  reports.tokens = 495_000
  await step($, 2)
  const notes = notesTo(session.appended(), undefined)
  expect(notes.length).toBe(1)
  expect(notes[0]).toContain('250k working tokens above the 240k baseline')
})

test('wraps up before the engine auto-compacts', { options: { mainWrapUpPercent: 80, maxWorkingTokens: 600_000 } }, async ($, on) => {
  const reports = { tokens: 100_000 }
  const { session, status } = engineBelow(on, reports, { model: 1_000_000, compact: 700_000, autoCompactAt: 600_000 })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  await step($, 0)
  expect(status.line).toContain('wrap-up at 510k')

  reports.tokens = 500_000
  await step($, 1)
  expect(notesTo(session.appended(), undefined).length).toBe(0)

  reports.tokens = 520_000
  await step($, 2)
  const notes = notesTo(session.appended(), undefined)
  expect(notes.length).toBe(1)
  expect(notes[0]).toContain('85% of the 600k auto-compaction threshold')
})

test('stops a subagent past its working limit and notes the handoff for main', async ($, on) => {
  const reports = { tokens: 10_000 }
  const { session } = engineBelow(on, reports)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawnOf('Explore auth'))

  await step($, 0, 'agent-1')
  expect(notesTo(session.appended(), 'agent-1').length).toBe(0)

  reports.tokens = 69_000
  await step($, 1, 'agent-1')
  expect(notesTo(session.appended(), 'agent-1').length).toBe(0)

  reports.tokens = 70_000
  await step($, 2, 'agent-1')
  const stops = notesTo(session.appended(), 'agent-1')
  expect(stops.length).toBe(1)
  expect(stops[0]).toContain('STOP')
  expect(stops[0]).toContain('working context grew to 60k tokens (limit 60k, 30% of the compaction window)')

  reports.tokens = 72_000
  await step($, 3, 'agent-1')
  expect(notesTo(session.appended(), 'agent-1').length).toBe(1)

  await $.turn.complete({ answer: 'handoff...', durationMs: 1, isAborted: false, turnId: 'turn-1', agentId: 'agent-1', reason: 'answer' })
  const mainNotes = notesTo(session.appended(), undefined)
  expect(mainNotes.length).toBe(1)
  expect(mainNotes[0]).toContain('stopped early')
})

test('stops a subagent that runs past the time limit', { options: { agentMaxMinutes: 2 } }, async ($, on) => {
  const reports = { tokens: 1_000 }
  const { session, clock } = engineBelow(on, reports)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawnOf('Slow one'))

  await clock.advance(90_000)
  expect(notesTo(session.appended(), 'agent-1').length).toBe(0)
  await clock.advance(60_000)
  const stops = notesTo(session.appended(), 'agent-1')
  expect(stops.length).toBe(1)
  expect(stops[0]).toContain('limit 2 min')
})

test('saves a handoff and injects it into the next session in the same directory', async ($, on) => {
  const reports = { tokens: 1_000 }
  const { session, status, sessionId } = engineBelow(on, reports)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await step($, 0)

  const saved = await $.tool.call({ tool: 'mcp__baton__handoff', text: '## Remaining\n- finish the spec' })
  expect('deny' in saved && saved.deny).toBeFalsy()
  expect(status.line).toContain('handoff saved')

  // a reload of the same session never takes its own handoff
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go on', turnId: 'turn-2' })
  expect(notesTo(session.appended(), undefined).length).toBe(0)

  // a fresh session in the same directory picks it up once
  sessionId.value = 'session-2'
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'continue', turnId: 'turn-3' })
  const notes = notesTo(session.appended(), undefined)
  expect(notes.length).toBe(1)
  expect(notes[0]).toContain('Handoff from your previous session')
  expect(notes[0]).toContain('finish the spec')
  expect(notes[0]).toContain('at 1% context')

  // a reload of that session, or its later turns, do not inject it again
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'more', turnId: 'turn-4' })
  expect(notesTo(session.appended(), undefined).length).toBe(1)

  // a third session gets nothing: the handoff was taken
  sessionId.value = 'session-3'
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'new work', turnId: 'turn-5' })
  expect(notesTo(session.appended(), undefined).length).toBe(1)
})
