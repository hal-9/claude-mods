import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const cache = (id: string) => `/home/t/.claude/plugins/cache/${id}`
// baton, relay and mod-switch from claude-mods, filetree from another marketplace, and a skills-only plugin with no hooks module.
const INSTALLED = {
  plugins: Object.fromEntries(
    ['baton@claude-mods', 'relay@claude-mods', 'mod-switch@claude-mods', 'filetree@claude-code-filetree', 'skills@other'].map(id => [id, [{ scope: 'user', installPath: cache(id) }]]),
  ),
}
const FILES: Record<string, string> = {
  '/home/t/.claude/plugins/installed_plugins.json': JSON.stringify(INSTALLED),
  ...Object.fromEntries(['baton@claude-mods', 'relay@claude-mods', 'mod-switch@claude-mods', 'filetree@claude-code-filetree'].map(id => [`${cache(id)}/hooks/hooks.json`, '{"modules":["./register.tsx"]}'])),
}

// The engine beneath the plugin: four mods installed, relay and filetree enabled at user scope.
// Settings are a snapshot that does not change until a reload, as in a session.
function engineBelow(on: On, surface: 'desktop' | 'terminal') {
  mock.env(on, { HOME: '/home/t' })
  const clock = mock.clock(on, { now: 0 })
  const runs: string[][] = []
  const commands: string[] = []
  on('session.surface', () => ({ value: surface }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.read', ($, e) => {
    const text = FILES[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('settings.read', () => ({ value: { enabledPlugins: { 'relay@claude-mods': true, 'mod-switch@claude-mods': true, 'filetree@claude-code-filetree': true } } }))
  on('command.run', ($, e) => {
    commands.push(e.command)
    return { text: '' }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({}))
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    return out('')
  })
  return { clock, runs, commands }
}

async function mountBoth($: Engine) {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const footer = await $.ui.mount({ plugin: 'mod-switch', surface: 'terminal', component: 'SessionMode', props: { modes: [] } })
  const band = await $.ui.mount({
    plugin: 'mod-switch', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 19 }, view: {} },
  })
  return { footer, band }
}

test('a switch flips at once, then runs the CLI and says the change lands next session', async ($, on) => {
  const { clock, runs, commands } = engineBelow(on, 'desktop')
  const { footer, band } = await mountBoth($)
  expect(await band.find({ text: /baton/ })).toBeUndefined()

  await footer.press({ key: 'toggle-menu' })
  expect(await band.find({ text: /2 of 3 on/ })).toBeDefined()
  expect(await band.find({ key: 'toggle-filetree' })).toBeDefined()
  expect(await band.find({ text: /claude-code-filetree/ })).toBeDefined()
  expect(await band.find({ text: /mod-switch/ })).toBeUndefined()
  expect(await band.find({ key: 'toggle-skills' })).toBeUndefined()

  // The press settles before the CLI runs: the row shows the pending switch.
  await band.press({ key: 'toggle-baton' })
  expect(runs).toEqual([])
  expect((await band.find({ key: 'toggle-baton' }))?.text).toMatch(/\[…\]/)

  await clock.advance(1)
  expect(runs).toEqual([['/home/t/.local/bin/claude', 'plugin', 'enable', 'baton@claude-mods', '--scope', 'user']])
  expect((await band.find({ key: 'toggle-baton' }))?.text).toMatch(/\[■\]/)
  expect(await band.find({ text: /3 of 3 on/ })).toBeDefined()
  expect(await band.find({ text: /new session/ })).toBeDefined()
  expect(await band.find({ text: /↻$/ })).toBeDefined()
  expect(commands).toEqual([])

  await band.press({ key: 'toggle-relay' })
  await clock.advance(1)
  expect(runs[1]).toEqual(['/home/t/.local/bin/claude', 'plugin', 'disable', 'relay@claude-mods', '--scope', 'user'])
  expect((await band.find({ key: 'toggle-relay' }))?.text).toMatch(/\[ \]/)

  await band.press({ key: 'close' })
  expect(await band.find({ text: /baton/ })).toBeUndefined()
})

test('the terminal reloads plugins and shows no next-session note', async ($, on) => {
  const { clock, commands } = engineBelow(on, 'terminal')
  const { footer, band } = await mountBoth($)
  await footer.press({ key: 'toggle-menu' })
  await band.press({ key: 'toggle-baton' })
  await clock.advance(1)
  expect((await band.find({ key: 'toggle-baton' }))?.text).toMatch(/\[■\]/)
  expect(commands).toEqual(['reload-plugins'])
  expect(await band.find({ text: /new session/ })).toBeUndefined()
})
