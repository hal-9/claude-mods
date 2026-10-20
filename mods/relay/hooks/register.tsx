import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Finding, Job, Role } from '../types'

const JOBS = { plugin: 'relay', key: 'jobs' } as const

const PANE = 'relay'
const POLL_MS = 2500
const LOG_TAIL = 1200
const PROMPT_CAP = 8000

type $ = EngineInterface

const LABEL: Record<Role, string> = {
  check: 'codex review',
  adversarial: 'codex adversarial',
  hand: 'codex task',
  verify: 'claude verify',
}

const VERIFY_PROMPT = `You are the verifier of another agent's work. Review the uncommitted changes in this working tree (git status, git diff, untracked files) against what they appear to be meant to do. Run the tests that cover the touched code when they exist.
Do not edit any file.
Reply with: VERDICT: pass or fail, one line why; then one line per problem as "severity | file:line | title | why | suggested fix".`

const minutes = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`

const fixPrompt = (job: Job, list: Finding[]) =>
  `[relay] ${LABEL[job.role]} found ${list.length} issue${list.length === 1 ? '' : 's'} in the working tree. Fix ${list.length === 1 ? 'it' : 'them'}, then say what you changed.\n\n` +
  list
    .map(f => `- (${f.severity}) ${f.file}${f.line_start ? `:${f.line_start}` : ''}: ${f.title}\n  ${f.body}${f.recommendation ? `\n  Suggested: ${f.recommendation}` : ''}`)
    .join('\n')

const pullPrompt = (job: Job) =>
  `[relay] Result of ${LABEL[job.role]}. Read it, then continue the work in this working tree accordingly.\n\n${(job.output ?? '').slice(0, PROMPT_CAP)}`

let companion: string[] = []
let env: Record<string, string> = {}
let opts: PluginOptions = {}

// Helpers take $ and may only spell $.noun.method on it, so they use $.state directly; the hooks use read/update.
async function getJobs($: $): Promise<Job[]> {
  return (await $.state.get(JOBS)).value ?? []
}

async function setJob($: $, id: string, patch: Partial<Job>) {
  const list = await getJobs($)
  await $.state.set(JOBS, list.map(j => (j.id === id ? { ...j, ...patch } : j)))
}

async function removeJob($: $, id: string) {
  await $.state.set(JOBS, (await getJobs($)).filter(j => j.id !== id))
}

async function addJob($: $, job: Job) {
  const list = await getJobs($)
  await $.state.set(JOBS, [job, ...list].slice(0, 20))
  void $.ui.open({ id: PANE, title: 'relay' })
}

async function run($: $, args: string[], timeoutMs = 60_000) {
  const { exitCode, stdout, stderr } = await $.process.run([...companion, ...args, '--json'], { env, timeoutMs })
  if (exitCode !== 0) throw new Error(stderr.trim() || `codex-companion exited ${exitCode}`)
  return JSON.parse(stdout) as Record<string, any>
}

const toastError = ($: $, error: unknown) => $.ui.toast(`relay: ${error instanceof Error ? error.message : String(error)}`)

// A review runs inside the companion's own process until it is done (`--background` only queues tasks), so the
// call is left running for up to ten minutes and the job is adopted from the companion's listing once it is on disk.
async function adopt($: $, role: 'check' | 'adversarial', known: Set<string>) {
  try {
    const { running } = (await run($, ['status'])) as { running?: { id: string; logFile?: string }[] }
    const fresh = (running ?? []).find(j => !known.has(j.id))
    if (!fresh) return $.ui.toast(`relay: ${LABEL[role]} did not start`)
    await addJob($, { id: fresh.id, role, status: 'running', startedAt: await $.clock.now(), log: '', logFile: fresh.logFile })
  } catch (error) {
    toastError($, error)
  }
}

async function startCodex($: $, role: 'check' | 'adversarial' | 'hand', extra: string[]) {
  const model = String(opts.codexModel ?? '')
  const modelArgs = model ? ['--model', model] : []
  if (role === 'hand') {
    try {
      const payload = await run($, ['task', '--background', ...modelArgs, ...extra])
      await addJob($, { id: String(payload.jobId), role, status: 'running', startedAt: await $.clock.now(), log: '' })
    } catch (error) {
      toastError($, error)
    }
    return
  }
  const known = new Set((await getJobs($)).map(j => j.id))
  void run($, [role === 'check' ? 'review' : 'adversarial-review', ...modelArgs, ...extra], 600_000).catch(error => toastError($, error))
  $.clock.after(1500, () => void adopt($, role, known))
}

async function startVerify($: $) {
  const { agentId, deny } = await $.agent.spawn({
    prompt: VERIFY_PROMPT,
    description: 'relay verify',
    subagentType: 'general-purpose',
    model: String(opts.verifyModel || 'opus'),
  })
  if (deny !== undefined || agentId === undefined) {
    $.ui.toast(`relay: verify refused: ${deny ?? 'no agent'}`)
    return
  }
  await addJob($, { id: agentId, role: 'verify', status: 'running', startedAt: await $.clock.now(), log: '' })
}

async function finish($: $, job: Job) {
  const { storedJob } = await run($, ['result', job.id])
  const parsed = storedJob?.result?.result
  const output: string = storedJob?.result?.rawOutput || storedJob?.result?.codex?.stdout || storedJob?.rendered || ''
  await setJob($, job.id, {
    status: 'done',
    verdict: parsed?.verdict,
    summary: parsed?.summary ?? storedJob?.result?.parseError,
    findings: parsed?.findings,
    output,
  })
  const n = parsed?.findings?.length
  $.ui.toast(`relay: ${LABEL[job.role]} done${n === undefined ? '' : `, ${n} finding${n === 1 ? '' : 's'}`}`)
}

// The engine's own PATH may lack a version-managed node (nvm, asdf): ask the login shell once.
async function nodePath($: $): Promise<string> {
  try {
    await $.process.run(['node', '--version'])
    return 'node'
  } catch {}
  const shell = (await $.env.get('SHELL')) || '/bin/zsh'
  try {
    const { exitCode, stdout } = await $.process.run([shell, '-lic', 'command -v node'])
    if (exitCode === 0 && stdout.trim()) return stdout.trim().split('\n').pop() ?? 'node'
  } catch {}
  return 'node'
}

// ponytail: one poll loop over the companion's status; a log-file watch if polling ever feels slow.
let isPolling = false
async function poll($: $) {
  if (isPolling) return
  isPolling = true
  try {
    const running = (await getJobs($)).filter(j => j.status === 'running' && j.role !== 'verify')
    for (const job of running) {
      try {
        const { job: snap } = await run($, ['status', job.id])
        const logFile: string | undefined = snap?.logFile ?? job.logFile
        let log = job.log
        if (logFile) {
          try {
            log = (await $.fs.read(logFile)).slice(-LOG_TAIL)
          } catch {}
        }
        if (snap?.status === 'completed') await finish($, { ...job, logFile })
        else if (snap?.status === 'failed' || snap?.status === 'cancelled') {
          await setJob($, job.id, { status: 'failed', log, summary: snap.errorMessage ?? snap.status })
          $.ui.toast(`relay: ${LABEL[job.role]} ${snap.status}`)
        } else await setJob($, job.id, { log, logFile })
      } catch (error) {
        await setJob($, job.id, { status: 'failed', summary: error instanceof Error ? error.message : String(error) })
      }
    }
  } finally {
    isPolling = false
  }
}

export const register: Register = (on, options) => {
  opts = options

  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('HOME')) ?? ''
    const root = String(options.codexPluginRoot || '') || `${home}/.claude/plugins/marketplaces/openai-codex/plugins/codex`
    companion = [await nodePath($), `${root}/scripts/codex-companion.mjs`]
    env = { CLAUDE_PLUGIN_DATA: `${home}/.claude/plugins/data/codex-openai-codex` }
    await $.command.register({ name: 'relay', description: 'relay check | adversarial | hand <task> | verify | pane' })
    $.clock.every(POLL_MS, () => void poll($))
    return next(e)
  })

  on('command.run', { command: 'relay' }, async ($, e) => {
    const [verb, ...rest] = (e.args ?? '').trim().split(/\s+/)
    const task = rest.join(' ')
    if (verb === 'check' || verb === 'adversarial') void startCodex($, verb, [])
    else if (verb === 'hand' && task) void startCodex($, 'hand', ['--write', task])
    else if (verb === 'verify') void startVerify($)
    else {
      await $.ui.open({ id: PANE, title: 'relay' })
      return { text: 'relay: check | adversarial | hand <task> | verify' }
    }
    return { text: `relay: ${verb} started.` }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const job = (await getJobs($)).find(j => j.id === e.agentId && j.status === 'running')
      if (job) {
        await setJob($, job.id, { status: 'done', output: e.answer, verdict: /VERDICT:\s*pass/i.test(e.answer) ? 'pass' : 'fail' })
        $.ui.toast(`relay: claude verify done`)
      }
    }
    return next(e)
  })

  // The desktop drops a press whose handler runs past ~10 s, and a Codex start can take that long: presses only schedule the work.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const now = await $.clock.now()
    const running = (await getJobs($)).filter(j => j.status === 'running')
    // Another mod's band (cache-meter) rides along above the buttons; the engine's own band is empty.
    const below = await next(e)
    const isDesktop = e.surface !== 'terminal' && 'Svg' in ui
    const w = Math.min(1600, (e.props.bodyColumns || 100) * 8)
    // A hairline between that band and the buttons.
    const divider = isDesktop ? (
      <ui.Svg
        source={`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="1"><style>rect{fill:#0000001a}@media (prefers-color-scheme: dark){rect{fill:#ffffff1f}}</style><rect width="${w}" height="1"/></svg>`}
        alt=""
        width={w}
        height={1}
      />
    ) : (
      <Text dimColor>{'─'.repeat(Math.max(8, (e.props.bodyColumns || 100) - 2))}</Text>
    )

    return (
      <Box flexDirection="column" gap={isDesktop ? 'sm' : 'xs'}>
        {below.type !== 'engine' && below}
        {below.type !== 'engine' && divider}
      <Box>
        <Text dimColor>relay </Text>
        {running.map(j => (
          <Text key={j.id}>
            {LABEL[j.role]} <Text dimColor>{minutes(now - j.startedAt)}</Text>{' '}
          </Text>
        ))}
        <Button key="check" hotkey="c" label="check" dimColor onPress={() => $.clock.after(0, () => void startCodex($, 'check', []))} />
        <Text> </Text>
        <Button key="adversarial" hotkey="a" label="adversarial" dimColor onPress={() => $.clock.after(0, () => void startCodex($, 'adversarial', []))} />
        <Text> </Text>
        <Button key="hand" hotkey="h" label="hand over" dimColor onPress={() => $.prompt.fill({ text: '/relay hand ', mode: 'insert' })} />
        <Text> </Text>
        <Button key="verify" hotkey="v" label="verify" dimColor onPress={() => $.clock.after(0, () => void startVerify($))} />
      </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await getJobs($)
    const now = await $.clock.now()
    const rows = Math.max(6, (e.viewport?.rows ?? 24) - 6)

    const dismiss = (job: Job, f: Finding) =>
      setJob($, job.id, { findings: (job.findings ?? []).filter(x => x !== f) })

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>No runs yet. Press c, a, h or v in the band, or /relay.</Text>}
        {list.slice(0, 3).map(job => (
          <Box key={job.id} flexDirection="column" marginBottom={1}>
            <Box>
              <Text bold>{LABEL[job.role]}</Text>
              <Text dimColor>
                {' '}{job.status === 'running' ? minutes(now - job.startedAt) : job.status}
                {job.verdict ? ` · ${job.verdict}` : ''}
              </Text>
              <Text> </Text>
              {job.status === 'running' && job.role !== 'verify' && (
                <Button key={`cancel-${job.id}`} label="cancel" dimColor onPress={() => $.clock.after(0, () => void run($, ['cancel', job.id]).catch(() => undefined))} />
              )}
              {job.status !== 'running' && (
                <Button key={`clear-${job.id}`} label="clear" dimColor onPress={() => removeJob($, job.id)} />
              )}
            </Box>
            {job.status === 'running' && job.log && (
              <Text dimColor>{job.log.split('\n').slice(-rows).join('\n')}</Text>
            )}
            {job.summary && <Text>{job.summary}</Text>}
            {(job.findings ?? []).map((f, i) => (
              <Box key={`${job.id}-${i}`}>
                <Text color={/critical|high/.test(f.severity) ? 'red' : /medium/.test(f.severity) ? 'yellow' : undefined}>{f.severity}</Text>
                <Text> {f.file}{f.line_start ? `:${f.line_start}` : ''} {f.title} </Text>
                <Button key={`fix-${job.id}-${i}`} label="fix" onPress={() => $.prompt.submit({ text: fixPrompt(job, [f]) })} />
                <Text> </Text>
                <Button key={`drop-${job.id}-${i}`} label="dismiss" dimColor onPress={() => dismiss(job, f)} />
              </Box>
            ))}
            {job.status === 'done' && (job.findings?.length ?? 0) > 1 && (
              <Button key={`fixall-${job.id}`} variant="primary" label="fix all" onPress={() => $.prompt.submit({ text: fixPrompt(job, job.findings ?? []) })} />
            )}
            {job.status === 'done' && !job.findings && job.output && (
              <Box flexDirection="column">
                <Text dimColor>{job.output.slice(-LOG_TAIL)}</Text>
                <Button key={`pull-${job.id}`} variant="primary" label="pull into Claude" onPress={() => $.prompt.submit({ text: pullPrompt(job) })} />
              </Box>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}
