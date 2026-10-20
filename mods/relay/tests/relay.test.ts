import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// Op hooks beneath the plugin answer { value }.
const ok = (payload: unknown) => ({ value: { exitCode: 0, stdout: JSON.stringify(payload), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const FINDING = { severity: 'high', title: 'stale read', body: 'reads the collection before load resolves', file: 'store.ts', line_start: 4, recommendation: 'await load first' }

// The engine beneath the plugin: the Codex companion answered from memory, by subcommand.
function engineBelow(on: On, store: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, store)
  mock.env(on, { HOME: '/home/t' })
  const runs: string[][] = []
  const submitted: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'relay' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({}))
  on('ui.render', { component: 'Pane' }, ($, e) => $.ui.resolve(e).Box({}))
  on('fs.read', () => ({ value: 'reading store.ts\nchecking load()' }))
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('process.run', ($, e) => {
    if (e.argv[1] === '--version') return ok('v24')
    runs.push([...e.argv])
    switch (e.argv[2]) {
      case 'review':
        // The companion answers a review only once it is done; the plugin adopts the job from the listing meanwhile.
        return ok({ review: 'Review', codex: { status: 0, stdout: 'one race' } })
      case 'status':
        return e.argv[3] === '--json' ? ok({ running: [{ id: 'review-1', logFile: '/log' }] }) : ok({ job: { status: 'completed', logFile: '/log' } })
      case 'result':
        return ok({ storedJob: { result: { result: { verdict: 'needs_changes', summary: 'one race', findings: [FINDING], next_steps: [] } } } })
      default:
        return { value: { exitCode: 1, stdout: '', stderr: `unexpected ${e.argv[2]}`, isStdoutTruncated: false, isStderrTruncated: false } }
    }
  })
  return { clock, runs, submitted }
}

test('check runs a background Codex review, shows its finding and turns it into a fix prompt', async ($, on) => {
  const { clock, runs, submitted } = engineBelow(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const band = await $.ui.mount({
    plugin: 'relay', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100 },
  })
  await band.press({ key: 'check' })
  await clock.advance(0)

  expect(runs[0]?.[1]).toBe('/home/t/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts/codex-companion.mjs')
  expect(runs[0]?.slice(2)).toEqual(['review', '--json'])
  expect(await band.find({ text: /codex review 0:00/ })).toBeUndefined()

  await clock.advance(1500)
  expect(await band.find({ text: /codex review/ })).toBeDefined()

  await clock.advance(1000)
  expect(runs.map(r => r[2])).toEqual(['review', 'status', 'status', 'result'])

  const pane = await $.ui.mount({
    plugin: 'relay', surface: 'terminal', component: 'Pane', requestId: 'relay',
    props: { title: 'relay', isFocused: true, bodyColumns: 100, placement: 'dock' },
  })
  expect(await pane.find({ text: /needs_changes/ })).toBeDefined()
  expect(await pane.find({ text: /stale read/ })).toBeDefined()

  await pane.press({ key: 'fix-review-1-0' })
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatch(/stale read/)
  expect(submitted[0]).toMatch(/store\.ts:4/)
  expect(submitted[0]).toMatch(/await load first/)
})

const BAND = { plugin: 'relay', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100 } } as const

test('the header folds the buttons away and back', async ($, on) => {
  engineBelow(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount(BAND)
  expect((await band.find({ key: 'toggle' }))?.text).toMatch(/^▾ relay/)
  await band.press({ key: 'toggle' })
  expect((await band.find({ key: 'toggle' }))?.text).toMatch(/^▸ relay/)
  expect(await band.find({ key: 'check' })).toBeUndefined()
  await band.press({ key: 'toggle' })
  expect(await band.find({ key: 'check' })).toBeDefined()
})

test('remembers the folded band across sessions', async ($, on) => {
  engineBelow(on, { collapsed: true })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount(BAND)
  expect((await band.find({ key: 'toggle' }))?.text).toMatch(/^▸ relay/)
  expect(await band.find({ key: 'check' })).toBeUndefined()
})
