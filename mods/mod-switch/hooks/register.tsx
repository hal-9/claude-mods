import type { EngineInterface, Register } from 'claude-code'

import type { IsOpen, Switch } from '../types'

// Your mods are the user-scope plugins that ship a hooks module, from any marketplace; on/off is their enabledPlugins entry.
const SELF = 'mod-switch@claude-mods'
const IS_OPEN = { plugin: 'mod-switch', key: 'isOpen' } as const
const SWITCHES = { plugin: 'mod-switch', key: 'switches' } as const
const NEEDS_NEW_SESSION = { plugin: 'mod-switch', key: 'needsNewSession' } as const

type $ = EngineInterface
type Mod = { id: string; name: string; marketplace: string; isOn: boolean; isPending: boolean; isSwitched: boolean }
type Installed = { plugins: Record<string, { scope: string; installPath: string }[]> }

async function home($: $) {
  return (await $.env.get('HOME')) ?? ''
}

async function getSwitches($: $): Promise<Record<string, Switch>> {
  return (await $.state.get(SWITCHES)).value ?? {}
}

async function setSwitch($: $, id: string, value: Switch | undefined) {
  const { [id]: _, ...rest } = await getSwitches($)
  await $.state.set(SWITCHES, value ? { ...rest, [id]: value } : rest)
}

async function isMod($: $, installPath: string) {
  try {
    const hooks = JSON.parse(await $.fs.read(`${installPath}/hooks/hooks.json`)) as { modules?: unknown[] }
    return (hooks.modules?.length ?? 0) > 0
  } catch {
    return false
  }
}

async function listMods($: $): Promise<Mod[]> {
  const installed = JSON.parse(await $.fs.read(`${await home($)}/.claude/plugins/installed_plugins.json`)) as Installed
  const enabled = ((await $.settings.read({ source: 'user' })).enabledPlugins ?? {}) as Record<string, boolean>
  const switches = await getSwitches($)
  const mods: Mod[] = []
  for (const [id, installs] of Object.entries(installed.plugins)) {
    const install = installs.find(i => i.scope === 'user')
    if (id === SELF || !install || !(await isMod($, install.installPath))) continue
    const [name = id, marketplace = ''] = id.split('@')
    const pressed = switches[id]
    mods.push({
      id,
      name,
      marketplace,
      isOn: pressed?.isOn ?? enabled[id] === true,
      isPending: pressed?.isPending ?? false,
      isSwitched: pressed !== undefined && !pressed.isPending,
    })
  }
  return mods.sort((a, b) => a.name.localeCompare(b.name))
}

async function getOpen($: $): Promise<IsOpen> {
  return (await $.state.get(IS_OPEN)).value ?? false
}

async function setOpen($: $, value: IsOpen) {
  await $.state.set(IS_OPEN, value)
}

async function getNeedsNewSession($: $): Promise<boolean> {
  return (await $.state.get(NEEDS_NEW_SESSION)).value ?? false
}

// The press only flips the switch, so it settles and redraws at once; the CLI runs in a timer's own dispatch.
async function toggle($: $, mod: Mod) {
  if (mod.isPending) return
  const isOn = !mod.isOn
  await setSwitch($, mod.id, { isOn, isPending: true })
  $.clock.after(0, () => void apply($, mod, isOn))
}

async function apply($: $, mod: Mod, isOn: boolean) {
  // The desktop app's PATH may lack ~/.local/bin, so the CLI is named by its full path.
  const cli = `${await home($)}/.local/bin/claude`
  const { exitCode, stderr } = await $.process.run([cli, 'plugin', isOn ? 'enable' : 'disable', mod.id, '--scope', 'user'])
  if (exitCode !== 0) {
    await setSwitch($, mod.id, undefined)
    $.ui.toast(`${mod.name}: could not switch ${isOn ? 'on' : 'off'}: ${stderr.trim()}`)
    return
  }
  await setSwitch($, mod.id, { isOn, isPending: false })

  // Only the terminal can /reload-plugins; the desktop app refuses it over its remote connection, so the change lands next session.
  if ((await $.session.surface()) === 'terminal') {
    void $.command.run({ command: 'reload-plugins' }).catch(() => undefined)
    $.ui.toast(`${mod.name} ${isOn ? 'on' : 'off'}`)
  } else {
    await $.state.set(NEEDS_NEW_SESSION, true)
  }
}

export const register: Register = on => {
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const modes = e.props.modes.join(' & ')
    const open = await getOpen($)
    // Another mod's footer (cache-meter) rides along; the engine's own is redrawn as its mode labels.
    const below = await next(e)

    return (
      <Box gap="sm" alignItems="center">
        {below.type !== 'engine' ? below : modes && <Text dimColor>{modes}</Text>}
        <Button key="toggle-menu" plain dimColor={!open} onPress={() => setOpen($, !open)}>
          <Text color={open ? 'claude' : undefined}>⚙ mods {open ? '▾' : '▴'}</Text>
        </Button>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await getOpen($))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const mods = await listMods($)
    const needsNewSession = await getNeedsNewSession($)
    const onCount = mods.filter(mod => mod.isOn).length
    const nameWidth = Math.max(0, ...mods.map(mod => mod.name.length))

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold>Mods <Text dimColor>· {onCount} of {mods.length} on</Text></Text>
          <Button key="close" plain dimColor role="dismiss" onPress={() => setOpen($, false)}>✕</Button>
        </Box>
        {mods.length === 0 && <Text dimColor>No installed plugin ships a hooks module.</Text>}
        {mods.map(mod => (
          <Box key={mod.id}>
            <Button key={`toggle-${mod.name}`} plain onPress={() => toggle($, mod)}>
              <Text color={mod.isPending ? 'warning' : mod.isOn ? 'success' : undefined} dimColor={!mod.isOn && !mod.isPending}>
                {mod.isPending ? '[…]' : mod.isOn ? '[■]' : '[ ]'}{' '}
              </Text>
              <Text bold={mod.isOn} dimColor={!mod.isOn}>{mod.name.padEnd(nameWidth)}</Text>
            </Button>
            <Text dimColor>  {mod.marketplace}</Text>
            {needsNewSession && mod.isSwitched && <Text color="warning">  ↻</Text>}
          </Box>
        ))}
        {needsNewSession && (
          <Box marginTop={1}>
            <Text color="warning">↻ takes effect when you start a new session</Text>
          </Box>
        )}
      </Box>
    )
  })
}
