import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionUsage } from 'claude-code'

const usage = (cacheRead: number, cacheWrite: number, input: number, output = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  model: 'test-model',
})

function engineBelow(on: On, reports: { usage: ReturnType<typeof usage> }) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const compacts = { count: 0 }
  const toasts: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, percent: 1, breakdown: { rawMaxTokens: 200_000, autoCompactThreshold: 190_000 } }, rateLimits: [] } as unknown as SessionUsage,
  }))
  on('session.compact', () => {
    compacts.count += 1
    return { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }], tokensBefore: 100_000, tokensAfter: 10_000 }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: reports.usage }
  })
  // A mod beneath (relay) draws its own band; the meter keeps it under the meter.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ dimColor: true, children: 'relay [check]' }))
  return { clock, compacts, toasts }
}

async function step($: Engine, index: number) {
  for await (const _chunk of $.turn.step({ turnId: 'turn-1', index, model: 'test-model', messageCount: 1 })) {
    // drain
  }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: draws the cache countdown, hit rate and context fill, and compacts on press`, async ($, on) => {
    const reports = { usage: usage(19_000, 1_000, 0, 500) }
    const { clock, compacts } = engineBelow(on, reports)
    await $.session.start({ cwd: '/repo', surface, isInteractive: true })
    const footer = await $.ui.mount({
      plugin: 'cache-meter', surface, component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 2 }, view: {} },
    })

    // Before the first response the engine's own footer stands.
    expect(await footer.find({ text: /cache/ })).toBeUndefined()

    await step($, 1)
    expect(await footer.find({ text: /relay \[check\]/ })).toBeDefined()
    expect(await footer.find({ text: /60m/ })).toBeDefined()
    expect(await footer.find({ text: /95%/ })).toBeDefined()
    // 19_000 + 1_000 + 500 = 20_500 of 200_000 → 10%; auto-compact at 190_000 → 95%.
    expect(await footer.find({ text: /context.*10%/ })).toBeDefined()
    expect(await footer.find({ text: /auto-compact 95%/ })).toBeDefined()

    // The countdown moves with the clock and goes cold past the TTL.
    await clock.advance(25 * 60_000)
    expect(await footer.find({ text: /35m/ })).toBeDefined()
    await clock.advance(40 * 60_000)
    expect(await footer.find({ text: /cold/ })).toBeDefined()

    await footer.press({ key: 'compact' })
    expect(compacts.count).toBe(1)
    // Compaction empties the window; the meter waits for the next response.
    expect(await footer.find({ text: /cache/ })).toBeUndefined()
  })
}

test('a 5m TTL counts down from five minutes', { options: { cacheTtl: '5m' } }, async ($, on) => {
  engineBelow(on, { usage: usage(0, 10_000, 0) })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const footer = await $.ui.mount({
    plugin: 'cache-meter', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 2 }, view: {} },
  })
  await step($, 1)
  expect(await footer.find({ text: /5m/ })).toBeDefined()
  expect(await footer.find({ text: /0% hit/ })).toBeDefined()
})
