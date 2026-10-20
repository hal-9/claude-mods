/** The last main-thread response, as the meter draws it. */
export type Reading = {
  /** When the response landed ($.clock.now() ms); the cache TTL counts from here. */
  at: number
  /** Share of the request's input the prompt cache served, whole percent. */
  hitPercent: number
  /** Tokens the next request re-sends. */
  tokens: number
  /** The model's context window. */
  window: number
  /** tokens over window, whole percent. */
  percent: number
  /** Where auto-compaction runs, as a percent of the window; null when off. */
  autoCompactPercent: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'cache-meter': {
      reading: Reading | null
      /** A clock tick, bumped every half minute so the countdown redraws. */
      tick: number
      /** The band is folded to a one-line summary; mirrored to $.store across sessions. */
      collapsed: boolean
    }
  }
}
