/** Whether the mods popover above the prompt is open. */
export type IsOpen = boolean

/** A switch the person pressed: the state asked for, and whether the CLI is still running. */
export type Switch = { isOn: boolean; isPending: boolean }

declare module 'claude-code' {
  interface PluginState {
    'mod-switch': {
      isOpen: IsOpen
      /** Pressed switches by plugin id (name@marketplace); they win over the settings snapshot, which only refreshes on a reload. */
      switches: Record<string, Switch>
      /** True once a switch landed but this session could not reload plugins. */
      needsNewSession: boolean
    }
  }
}
