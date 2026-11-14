import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Detail, Repo, Track, View } from '../types'
import { ageLong, buildRows, fit, parseLog, releases, trimGraphs } from './graph'
import type { Row, Seg } from './graph'

const PANE = 'git-graph'
const LIMIT = 500
// 저장 형태가 바뀌면 shape 값을 올린다. 이전 버전이 저장한 값은 버려진다.
const EMPTY: Repo = { branch: '', changes: 0, name: '', commits: [], more: false, track: {}, fetched: 0 }
const repo = atom({ plugin: 'git-graph', key: 'repo' } as const, EMPTY, { shape: 'repo-2' })
const view = atom({ plugin: 'git-graph', key: 'view' } as const, { open: [], sel: '', cur: '', start: 0, marks: [] } as View, { shape: 'view-2' })
const detail = atom({ plugin: 'git-graph', key: 'detail' } as const, { h: '', author: '', t: 0, s: '', files: 0, add: 0, del: 0 } as Detail, { shape: 'detail-1' })

const LOG = [
  'git', 'log', '--topo-order', '--decorate=full', '--no-show-signature',
  '--branches', '--remotes', '--tags', 'HEAD', '-n', String(LIMIT),
  '--format=%x1e%H%x1f%P%x1f%D%x1f%s%x1f%ct',
]
// --no-optional-locks: 주기적으로 돌아도 index.lock을 잡지 않아 다른 git 작업과 충돌하지 않는다.
const STATUS = ['git', '--no-optional-locks', 'status', '--porcelain=v1', '--branch']
// 저장소 위치와 HEAD, 모든 브랜치와 태그가 가리키는 커밋. 둘 다 그대로면 이력도 그대로라 git log를 건너뛴다.
// 저장소 위치, FETCH_HEAD 파일 위치(마지막 fetch 시각을 읽는다), HEAD 순서로 한 줄씩 나온다.
const TOP = ['git', 'rev-parse', '--show-toplevel', '--path-format=absolute', '--git-path', 'FETCH_HEAD', 'HEAD']
const REFS = ['git', 'for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/remotes', 'refs/tags']
// 로컬 브랜치마다 upstream과 앞선 수, 뒤처진 수. ref가 바뀔 때만 읽는다.
const TRACK = ['git', 'for-each-ref', '--format=%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)', 'refs/heads']

function parseTrack(out: string): Record<string, Track> {
  const track: Record<string, Track> = {}
  for (const line of out.split('\n').filter(Boolean)) {
    const [name = '', up = '', state = ''] = line.split('\t')
    if (!up) continue
    const num = (re: RegExp) => Number(re.exec(state)?.[1] ?? 0)
    track[name] = { up, ahead: num(/ahead (\d+)/), behind: num(/behind (\d+)/), ...(state === 'gone' ? { gone: true as const } : {}) }
  }
  return track
}

// ponytail: 마지막으로 그린 그래프 영역의 높이. 모듈을 다시 불러오면 다음 그리기에서 다시 맞춰진다.
let lastRows = 20

// 마지막으로 git log를 읽었을 때의 저장소 위치, HEAD, ref 목록. 모듈을 다시 불러오면 한 번 전체를 읽는다.
let lastRefs = ''

async function load($: EngineInterface): Promise<Repo> {
  const empty = EMPTY
  try {
    const [status, top, refs] = await Promise.all([$.process.run(STATUS), $.process.run(TOP), $.process.run(REFS)])
    if (status.exitCode !== 0) return { ...empty, error: 'git 저장소가 아닙니다' }
    const [head = '', ...changes] = status.stdout.split('\n').filter(Boolean)
    const m = /^## (?:No commits yet on )?([^.\s]+)(?:\.\.\.\S+)?(?: \[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?/.exec(head)
    const branch = [m?.[1] ?? head.slice(3), m?.[2] && `↑${m[2]}`, m?.[3] && `↓${m[3]}`].filter(Boolean).join(' ')
    const [toplevel = '', fetchHead = ''] = top.stdout.split('\n')
    const name = toplevel.trim().split('/').pop() ?? ''
    const fetched = await $.fs.stat(fetchHead.trim()).then(st => st.mtimeMs, () => 0)
    const base = { branch, name, changes: changes.length, fetched }
    const key = top.stdout + refs.stdout
    const prev = await read($, repo)
    if (key === lastRefs && !prev.error) return { ...prev, ...base }
    const [log, track] = await Promise.all([$.process.run(LOG), $.process.run(TRACK)])
    if (log.exitCode !== 0) return { ...empty, ...base, error: log.stderr.split('\n')[0] }
    lastRefs = key
    const commits = parseLog(log.stdout)
    return { ...base, commits, more: commits.length >= LIMIT, track: parseTrack(track.stdout) }
  } catch (err) {
    return { ...empty, error: `git 실행 실패: ${String(err)}` }
  }
}

// 갱신이 겹치면 하나로 합친다. 도는 중에 다시 요청되면 끝난 뒤 한 번 더 읽어 마지막 상태를 남긴다.
let busy = false
let again = false
// 마지막 갱신에 걸린 시간과 끝난 시각. 주기 갱신은 걸린 시간의 30배(최소 2초)마다 해서 CPU를 3% 넘게 쓰지 않는다.
let cost = 0
let lastEnd = 0
async function refresh($: EngineInterface) {
  if (busy) {
    again = true
    return
  }
  busy = true
  try {
    do {
      again = false
      const t0 = await $.clock.now()
      const next = await load($)
      if (JSON.stringify(next) !== JSON.stringify(await read($, repo))) await update($, repo, () => next)
      lastEnd = await $.clock.now()
      cost = lastEnd - t0
    } while (again)
  } finally {
    busy = false
  }
}

const isOpen = async ($: EngineInterface) => (await $.ui.panes()).some(p => p.id === PANE)

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
  const rows = buildRows(r.commits, new Set(v.open), t, { track: r.track, marks: new Set(v.marks) })
  if (r.more) rows.push({ key: 'more', graph: [], label: [{ t: `최근 커밋 ${LIMIT}개까지만 보여 줍니다`, dim: true }], age: '' })
  return rows
}

// 커서가 있는 줄을 고를 대상으로 바꾼다: 커밋 줄은 커밋, 브랜치 끝을 접은 줄은 브랜치.
const targetOf = (row?: Row) => (row?.hash ? `c:${row.hash}` : row?.branch ? `b:${row.branch}` : '')

async function toggleMark($: EngineInterface) {
  const [v, rows] = await Promise.all([read($, view), rowsOf($)])
  const id = targetOf(rows.find(r => r.key === v.cur))
  if (!id) return
  await update($, view, x => ({ ...x, marks: x.marks.includes(id) ? x.marks.filter(m => m !== id) : [...x.marks, id] }))
}

type Say = (list: string, branch: string) => string
const ACTIONS: { hotkey: string; label: string; say: Say }[] = [
  { hotkey: '1', label: '체리픽', say: (list, b) => `다음을 ${b} 브랜치에 체리픽해 줘: ${list}` },
  { hotkey: '2', label: '리베이스', say: (list, b) => `${b} 브랜치를 다음 위로 리베이스해 줘: ${list}` },
  { hotkey: '3', label: '병합', say: (list, b) => `다음을 ${b} 브랜치에 병합해 줘: ${list}` },
  { hotkey: '4', label: '되돌리기', say: list => `다음 커밋을 revert해 줘: ${list}` },
  { hotkey: '5', label: '리뷰', say: list => `다음 변경을 리뷰해 줘: ${list}` },
]

// 고른 것(없으면 커서가 있는 줄)을 입력창에 넣는다. 보내기는 사람이 한다.
export function promptList(marks: readonly string[], commits: Repo['commits']): string {
  const order = new Map(commits.map((c, i) => [c.h, i]))
  const branches = marks.filter(m => m.startsWith('b:')).map(m => `\`${m.slice(2)}\` 브랜치`)
  // 체리픽 순서가 맞도록 오래된 커밋부터 적는다.
  const picked = marks
    .filter(m => m.startsWith('c:'))
    .map(m => m.slice(2))
    .sort((a, b) => (order.get(b) ?? 0) - (order.get(a) ?? 0))
    .map(h => `\`${h.slice(0, 7)}\` ${commits[order.get(h) ?? -1]?.s ?? ''}`.trim())
  return [...branches, ...picked].join(', ')
}

async function send($: EngineInterface, say?: Say) {
  const [r, v, rows] = await Promise.all([read($, repo), read($, view), rowsOf($)])
  const marks = v.marks.length ? v.marks : [targetOf(rows.find(x => x.key === v.cur))].filter(Boolean)
  if (!marks.length) return $.ui.toast('고른 것이 없습니다. x로 고르거나 커서를 커밋 줄에 두세요')
  const list = promptList(marks, r.commits)
  const filled = await $.prompt.fill({ text: `${say ? say(list, r.branch.split(' ')[0] || 'HEAD') : list} `, mode: 'insert' })
  if (!filled.isFilled) return $.ui.toast('입력창에 넣지 못했습니다')
  await update($, view, x => ({ ...x, marks: [] }))
  $.ui.toast('입력창에 넣었습니다. Esc로 입력창에 돌아가 보내세요')
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
    // ponytail: 2초마다 확인하고, 느린 저장소는 걸린 시간에 맞춰 건너뛴다. 그래도 무거우면 .git 변경 감시로 바꾼다.
    const tick = async () => {
      if ((await $.clock.now()) - lastEnd < Math.max(2000, cost * 30) - 100) return
      if (await isOpen($)) await refresh($)
    }
    $.clock.every(2000, () => void tick().catch(() => {}))
    return started
  })

  on('command.run', { command: 'git-graph' }, async $ => {
    await refresh($)
    await open($)
    return { text: 'git 그래프 패널을 열었습니다.' }
  })

  // 읽기 전용이 아닌 도구가 끝나면 바로 반영한다. 커밋, 브랜치 전환, 파일 수정이 여기에 해당하고 하위 에이전트의 도구도 포함된다.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (!ran.isReadOnly) {
      void isOpen($)
        .then(open => (open ? refresh($) : undefined))
        .catch(() => {})
    }
    return ran
  }).catch(($, e, next) => next(e)) // 실패해도 도구 결과를 그대로 넘긴다. next를 이미 불렀으면 그 결과를 다시 쓴다.

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
    // 위 2줄(브랜치, 릴리스), 아래 단축키 2줄, 그 위 상세 4줄. 패널이 낮으면 상세부터 뺀다.
    const hasActions = total >= 10
    const hasDetail = total >= 20
    lastRows = total - 2 - (hasActions ? 2 : 0) - (hasDetail ? 4 : 0)

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
    const rel = releases(r.commits)
    const header2 = fit(
      rel.flatMap((x, i): Seg[] => [...(i ? [{ t: '  ' }] : []), { t: `◇ ${x.tag}`, color: 'yellow' }, { t: ` +${x.ahead}`, dim: true }]),
      [{ t: r.fetched ? `fetch ${ageLong(r.fetched / 1000, now)}` : 'fetch 기록 없음', dim: true }],
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
    if (hasDetail) {
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
        foot.push([{ t: '↑↓ 이동  Enter 펼치기, 상세  Esc 입력창으로', dim: true }], [{ t: 'x로 여러 개 고른 뒤 p나 숫자로 입력창에 넣기', dim: true }], [])
      }
    }
    // 단축키는 패널이 키보드를 가지고 있을 때 동작한다. 고른 것이 없으면 커서가 있는 줄을 쓴다.
    const act = (hotkey: string, label: string, onPress: () => unknown) => (
      <Button key={`act:${hotkey}`} plain hotkey={hotkey} onPress={() => void onPress()}>{label}</Button>
    )
    const gap = <Text>  </Text>

    return (
      <Box flexDirection="column">
        <Text>{header.map(s => seg(s))}</Text>
        <Text>{header2.map(s => seg(s))}</Text>
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
        {hasActions && (
          <Box flexDirection="row">
            {act('x', '고르기', () => toggleMark($))}{gap}{act('p', '넣기', () => send($))}{gap}
            {act('1', ACTIONS[0]!.label, () => send($, ACTIONS[0]!.say))}{gap}{act('2', ACTIONS[1]!.label, () => send($, ACTIONS[1]!.say))}
          </Box>
        )}
        {hasActions && (
          <Box flexDirection="row">
            {act('3', ACTIONS[2]!.label, () => send($, ACTIONS[2]!.say))}{gap}{act('4', ACTIONS[3]!.label, () => send($, ACTIONS[3]!.say))}{gap}
            {act('5', ACTIONS[4]!.label, () => send($, ACTIONS[4]!.say))}{gap}
            <Text dimColor>{v.marks.length ? `고른 것 ${v.marks.length}개` : '고른 것 없음'}</Text>
          </Box>
        )}
      </Box>
    )
  })
}
