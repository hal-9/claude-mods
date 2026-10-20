/** The role a run plays, in Pi's words. */
export type Role = 'check' | 'adversarial' | 'hand' | 'verify'

export type Finding = {
  severity: string
  title: string
  body: string
  file: string
  line_start: number | null
  recommendation: string
}

/** One run of a role: a Codex companion job or a Claude verifier subagent. */
export type Job = {
  /** Companion job id, or the subagent's agentId. */
  id: string
  role: Role
  status: 'running' | 'done' | 'failed'
  startedAt: number
  /** Last lines of the Codex log while running. */
  log: string
  /** Review results, once done. */
  verdict?: string
  summary?: string
  findings?: Finding[]
  /** A task's or verifier's final text, once done. */
  output?: string
  /** Path of the companion's log file, polled while running. */
  logFile?: string
}

declare module 'claude-code' {
  interface PluginState {
    relay: { jobs: Job[]; collapsed: boolean }
  }
}
