import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Graph, Run } from '../types'

const PANE = 'git-graph'
const EMPTY: Graph = { header: '', lines: [] }
// 저장 형태가 바뀌면 shape 값을 올린다. 이전 버전이 저장한 값은 버려진다.
const graph = atom({ plugin: 'git-graph', key: 'graph' } as const, EMPTY, {
  shape: 'graph-1',
})

// 그래프 모양과 선 색은 git이 직접 그린 것을 그대로 쓴다.
const LOG = [
  'git', 'log', '--graph', '--color=always', '--no-show-signature',
  '--branches', '--remotes', '--tags', 'HEAD', '-n', '300',
  '--format=%C(auto)%h%d%C(reset) %s %C(dim)%ar%C(reset)',
]
// --no-optional-locks: 주기적으로 돌아도 index.lock을 잡지 않아 다른 git 작업과 충돌하지 않는다.
const STATUS = ['git', '--no-optional-locks', 'status', '--porcelain=v1', '--branch']

const COLORS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']

// git이 쓰는 SGR 코드(초기화, 굵게, 흐리게, 글자색)만 읽어 색 구간으로 나눈다.
export function parseAnsi(line: string): Run[] {
  const runs: Run[] = []
  let style: Omit<Run, 'text'> = {}
  line.split(/\x1b\[([\d;]*)m/).forEach((part, i) => {
    if (i % 2 === 0) {
      if (part) runs.push({ text: part, ...style })
      return
    }
    for (const code of (part || '0').split(';').map(Number)) {
      const { color, bold, dim } = style
      if (code === 0) style = {}
      else if (code === 1) style = { ...style, bold: true }
      else if (code === 2) style = { ...style, dim: true }
      else if (code === 22) style = color ? { color } : {}
      else if (code >= 30 && code <= 37) style = { ...style, color: COLORS[code - 30] }
      else if (code >= 90 && code <= 97) style = { ...style, color: `${COLORS[code - 90]}Bright` }
      else if (code === 39) style = { ...(bold && { bold }), ...(dim && { dim }) }
    }
  })
  return runs
}

async function load($: EngineInterface): Promise<Graph> {
  try {
    const [status, log] = await Promise.all([$.process.run(STATUS), $.process.run(LOG)])
    if (status.exitCode !== 0) return { ...EMPTY, error: 'git 저장소가 아닙니다' }
    const [branch = '', ...changes] = status.stdout.split('\n').filter(Boolean)
    const header = branch.replace(/^## /, '') + (changes.length ? `  변경 ${changes.length}개` : '')
    if (log.exitCode !== 0) return { header, lines: [], error: log.stderr.split('\n')[0] }
    return { header, lines: log.stdout.split('\n').filter(Boolean).map(parseAnsi) }
  } catch (err) {
    return { ...EMPTY, error: `git 실행 실패: ${String(err)}` }
  }
}

async function refresh($: EngineInterface) {
  const next = await load($)
  if (JSON.stringify(next) !== JSON.stringify(await read($, graph))) {
    await update($, graph, () => next)
  }
}

const open = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Git' })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'git-graph', description: 'git 커밋 그래프 패널 열기' })
    await refresh($)
    if (!(await read($, graph)).error) void open($)
    // ponytail: 5초마다 git을 다시 읽는다. 큰 저장소에서 느려지면 .git 변경 감시로 바꾼다.
    const tick = async () => {
      if ((await $.ui.panes()).some(p => p.id === PANE)) await refresh($)
    }
    $.clock.every(5000, () => void tick().catch(() => {}))
    return started
  })

  on('command.run', { command: 'git-graph' }, async $ => {
    await refresh($)
    await open($)
    return { text: 'git 그래프 패널을 열었습니다.' }
  })

  // Claude가 Bash로 커밋하거나 브랜치를 바꾸면 바로 반영한다.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    void refresh($).catch(() => {})
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const g = await read($, graph)
    return (
      <Box flexDirection="column">
        {g.header && <Text weight="bold" wrap="truncate-end">{g.header}</Text>}
        {g.error && <Text dimColor wrap="truncate-end">{g.error}</Text>}
        {g.lines.map(runs => (
          <Text mono wrap="truncate-end">
            {runs.map(r => (
              <Text color={r.color} weight={r.bold && 'bold'} dimColor={r.dim}>{r.text}</Text>
            ))}
          </Text>
        ))}
      </Box>
    )
  })
}
