/** Context fill of one model loop, measured from the API's own usage figures. */
export type LoopStats = {
  /** Tokens the next request re-sends: input + cache read + cache write + output of the last response. */
  tokens: number
  /** The model's context window, in tokens. */
  window: number
  /** tokens over window, whole percent. */
  percent: number
  /** Model requests counted so far. */
  steps: number
  /** Growth since the previous request. */
  lastDelta: number
  updatedAt: number
}

export type AgentStats = LoopStats & {
  id: string
  description: string
  type: string
  startedAt: number
  /** Set once baton told the agent to stop and hand off. */
  stoppedAt?: number
  stopReason?: string
  endedAt?: number
}

/** One context growth step, attributed to the tool calls that preceded it. */
export type Bump = {
  at: number
  agentId?: string
  delta: number
  tools: string[]
  percentAfter: number
}

export type Phase = 'ok' | 'wrap-up' | 'handoff-written'

/** What a session leaves for the next one, kept in $.store under "handoff". */
export type Handoff = {
  cwd: string
  sessionId: string
  writtenAt: number
  percent: number
  text: string
  /** The session that picked it up; a handoff is injected into exactly one session. */
  takenBy?: string
  /** When that session's first turn injected it; a reload never injects it again. */
  injectedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    baton: {
      main: LoopStats | null
      agents: Record<string, AgentStats>
      bumps: Bump[]
      phase: Phase
      /** The engine's own status-line percent, from session.measure, for cross-checking. */
      enginePercent: number | null
    }
  }
}
