import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Detail, Repo, View } from '../types'
import { ageLong, buildRows, fit, parseLog, trimGraphs } from './graph'
import type { Row, Seg } from './graph'

const PANE = 'git-graph'
const LIMIT = 500
const FOOT = 5
// 저장 형태가 바뀌면 shape 값을 올린다. 이전 버전이 저장한 값은 버려진다.
const repo = atom({ plugin: 'git-graph', key: 'repo' } as const, { branch: '', changes: 0, name: '', commits: [], more: false } as Repo, { shape: 'repo-1' })
const view = atom({ plugin: 'git-graph', key: 'view' } as const, { open: [], sel: '', cur: '', start: 0 } as View, { shape: 'view-1' })
const detail = atom({ plugin: 'git-graph', key: 'detail' } as const, { h: '', author: '', t: 0, s: '', files: 0, add: 0, del: 0 } as Detail, { shape: 'detail-1' })

const LOG = [
  'git', 'log', '--topo-order', '--decorate=full', '--no-show-signature',
  '--branches', '--remotes', '--tags', 'HEAD', '-n', String(LIMIT),
  '--format=%x1e%H%x1f%P%x1f%D%x1f%s%x1f%ct',
]
// --no-optional-locks: 주기적으로 돌아도 index.lock을 잡지 않아 다른 git 작업과 충돌하지 않는다.
const STATUS = ['git', '--no-optional-locks', 'status', '--porcelain=v1', '--branch']
const TOP = ['git', 'rev-parse', '--show-toplevel']

// ponytail: 마지막으로 그린 그래프 영역의 높이. 모듈을 다시 불러오면 다음 그리기에서 다시 맞춰진다.
let lastRows = 20

async function load($: EngineInterface): Promise<Repo> {
  const empty: Repo = { branch: '', changes: 0, name: '', commits: [], more: false }
  try {
    const [status, log, top] = await Promise.all([$.process.run(STATUS), $.process.run(LOG), $.process.run(TOP)])
    if (status.exitCode !== 0) return { ...empty, error: 'git 저장소가 아닙니다' }
    const [head = '', ...changes] = status.stdout.split('\n').filter(Boolean)
    const m = /^## (?:No commits yet on )?([^.\s]+)(?:\.\.\.\S+)?(?: \[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?/.exec(head)
    const branch = [m?.[1] ?? head.slice(3), m?.[2] && `↑${m[2]}`, m?.[3] && `↓${m[3]}`].filter(Boolean).join(' ')
    const name = top.stdout.trim().split('/').pop() ?? ''
    if (log.exitCode !== 0) return { ...empty, branch, name, changes: changes.length, error: log.stderr.split('\n')[0] }
    const commits = parseLog(log.stdout)
    return { branch, changes: changes.length, name, commits, more: commits.length >= LIMIT }
  } catch (err) {
    return { ...empty, error: `git 실행 실패: ${String(err)}` }
  }
}

async function refresh($: EngineInterface) {
  const next = await load($)
  if (JSON.stringify(next) !== JSON.stringify(await read($, repo))) await update($, repo, () => next)
}

async function select($: EngineInterface, h: string) {
  await update($, view, v => ({ ...v, cur: `c:${h}`, sel: v.sel === h ? '' : h }))
  if ((await read($, view)).sel !== h) return
  const out = await $.process.run([
    'git', 'show', '--no-show-signature', '--diff-merges=first-parent', '--shortstat',
    '--format=%an%x1f%ct%x1f%s', h,
  ])
  const [author = '', t = '0', s = ''] = (out.stdout.split('\n')[0] ?? '').split('\x1f')
  const num = (re: RegExp) => Number(re.exec(out.stdout)?.[1] ?? 0)
  await update($, detail, () => ({
    h, author, t: Number(t), s,
    files: num(/(\d+) files? changed/), add: num(/(\d+) insertions?/), del: num(/(\d+) deletions?/),
  }))
}

async function rowsOf($: EngineInterface, now?: number): Promise<Row[]> {
  const [r, v, t] = await Promise.all([read($, repo), read($, view), now ?? $.clock.now()])
  const rows = buildRows(r.commits, new Set(v.open), t)
  if (r.more) rows.push({ key: 'more', graph: [], label: [{ t: `최근 커밋 ${LIMIT}개까지만 보여 줍니다`, dim: true }], age: '' })
  return rows
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const pressable = (r?: Row) => !!(r?.hash || r?.fold)

// 커서 위아래로 누를 수 있는 줄이 하나씩 보이도록 창을 옮긴다. 그래야 방향키가 창 밖으로 이어서 움직인다.
export function keepInView(rows: Row[], i: number, start: number, height: number): number {
  let lo = i - 1
  while (lo > 0 && !pressable(rows[lo])) lo--
  let hi = i + 1
  while (hi < rows.length - 1 && !pressable(rows[hi])) hi++
  lo = clamp(lo, 0, i)
  hi = clamp(hi, i, rows.length - 1)
  let s = start
  if (lo < s) s = lo
  if (hi > s + height - 1) s = hi - height + 1
  return clamp(s, 0, Math.max(0, rows.length - height))
}

const open = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Git' })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'git-graph', description: 'git 커밋 그래프 패널 열기' })
    await refresh($)
    if (!(await read($, repo)).error) void open($)
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

  // 방향키나 클릭으로 커서가 움직이면 기록하고, 창 밖으로 나가지 않게 한다.
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const done = await next(e)
    const key = e.element
    if (!key) return done
    const rows = await rowsOf($)
    const i = rows.findIndex(r => r.key === key)
    if (i >= 0) await update($, view, v => ({ ...v, cur: key, start: keepInView(rows, i, v.start, lastRows) }))
    return done
  })

  // 마우스 휠은 그래프 영역을 3줄씩 옮긴다.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const rows = await rowsOf($)
    await update($, view, v => ({ ...v, start: clamp(v.start + Math.sign(e.by) * 3, 0, Math.max(0, rows.length - lastRows)) }))
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [r, v, d, now] = await Promise.all([read($, repo), read($, view), read($, detail), $.clock.now()])
    // 마지막 칸에 글자를 쓰면 줄이 넘어갈 수 있어 한 칸 남긴다.
    const cols = Math.max(20, e.props.bodyColumns - 1)
    const total = Math.max(4, e.props.scroll.bodyRows)
    const hasFoot = total >= 14
    lastRows = total - 1 - (hasFoot ? FOOT : 0)

    const seg = (s: Seg, bg?: string) => (
      <Text color={s.color} dimColor={s.dim} weight={s.bold && 'bold'} inverse={s.inverse} underline={s.underline} backgroundColor={bg}>
        {s.t}
      </Text>
    )
    const header = fit(
      [{ t: r.branch, bold: true }, ...(r.changes ? [{ t: `  변경 ${r.changes}개`, dim: true as const }] : [])],
      [{ t: r.name, dim: true }],
      cols,
    )
    if (r.error) {
      return (
        <Box flexDirection="column">
          {r.branch && <Text>{header.map(s => seg(s))}</Text>}
          <Text dimColor wrap="truncate-end">{r.error}</Text>
        </Box>
      )
    }

    const rows = await rowsOf($, now)
    const start = clamp(v.start, 0, Math.max(0, rows.length - lastRows))
    const shown = trimGraphs(rows.slice(start, start + lastRows))
    const press = (row: Row) =>
      row.fold
        ? update($, view, x => ({
            ...x,
            cur: row.key,
            open: x.open.includes(row.fold!) ? x.open.filter(f => f !== row.fold) : [...x.open, row.fold!],
          }))
        : select($, row.hash!)

    const foot: Seg[][] = []
    if (hasFoot) {
      foot.push([{ t: '─'.repeat(cols), dim: true }])
      if (v.sel && d.h === v.sel) {
        foot.push(
          fit([{ t: d.h.slice(0, 7), color: 'yellow' }, { t: `  ${d.author}  ${ageLong(d.t, now)}`, dim: true }], [], cols),
          fit([{ t: d.s, bold: true }], [], cols),
          d.files
            ? [{ t: `파일 ${d.files}개  `, dim: true }, { t: `+${d.add}`, color: 'green' }, { t: '  ' }, { t: `-${d.del}`, color: 'red' }]
            : [{ t: '변경 없음', dim: true }],
        )
      } else if (v.sel) {
        foot.push([{ t: '불러오는 중', dim: true }], [], [])
      } else {
        foot.push([{ t: '↑↓로 옮기고 Enter로 펼치거나 고릅니다', dim: true }], [{ t: '마우스로 누르면 바로 고릅니다', dim: true }], [])
      }
      foot.push([{ t: '↑↓ 이동  Enter 고르기  Esc 프롬프트로', dim: true }])
    }

    return (
      <Box flexDirection="column">
        <Text>{header.map(s => seg(s))}</Text>
        {shown.map(row => {
          const bg = row.hash && row.hash === v.sel ? 'subtle' : undefined
          const kids = fit([...row.graph, { t: '  ' }, ...row.label], row.age ? [{ t: row.age, dim: true }] : [], cols).map(s => seg(s, bg))
          return pressable(row) ? (
            <Button key={row.key} plain onPress={() => void press(row)}>{kids}</Button>
          ) : (
            <Text>{kids}</Text>
          )
        })}
        {Array.from({ length: Math.max(0, lastRows - shown.length) }, () => <Text> </Text>)}
        {foot.map(line => <Text>{line.length ? line.map(s => seg(s)) : ' '}</Text>)}
      </Box>
    )
  })
}
