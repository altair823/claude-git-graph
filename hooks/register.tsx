import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Detail, Repo, Track, View } from '../types'
import { ageLong, buildRows, fit, liveMarks, merge, parseLog, releases, statusBranch, tail, trimGraphs, width } from './graph'
import type { Row, Seg } from './graph'
import { applyUpgrade, checkUpgrade, readVersion, upgradeLabel } from './upgrade'

const PANE = 'git-graph'
const DETAIL_ROWS = 6
const LIMIT = 500
// 저장 형태가 바뀌면 shape 값을 올린다. 이전 버전이 저장한 값은 버려진다.
const EMPTY: Repo = { rev: 0, branch: '', changes: 0, files: [], name: '', commits: [], more: false, track: {}, fetched: 0 }
const repo = atom({ plugin: 'git-graph', key: 'repo' } as const, EMPTY, { shape: 'repo-4' })
const view = atom({ plugin: 'git-graph', key: 'view' } as const, { open: [], cur: '', off: 0, start: 0, marks: [] } as View, { shape: 'view-4' })
const NO_DETAIL: Detail = { h: '', author: '', t: 0, s: '', files: 0, add: 0, del: 0, paths: [] }
const detail = atom({ plugin: 'git-graph', key: 'detail' } as const, NO_DETAIL, { shape: 'detail-3' })

const LOG = [
  'git', 'log', '--topo-order', '--decorate=full', '--no-show-signature',
  '--branches', '--remotes', '--tags', 'HEAD', '-n', String(LIMIT),
  '--format=%x1e%H%x1f%P%x1f%D%x1f%s%x1f%ct',
]
// --no-optional-locks: 주기적으로 돌아도 index.lock을 잡지 않아 다른 git 작업과 충돌하지 않는다.
const STATUS = ['git', '--no-optional-locks', 'status', '--porcelain=v1', '--branch']
// 저장소 위치, FETCH_HEAD 파일 위치(마지막 fetch 시각을 읽는다), HEAD가 한 줄씩 나온다.
const TOP = ['git', 'rev-parse', '--show-toplevel', '--path-format=absolute', '--git-path', 'FETCH_HEAD', 'HEAD']
// 모든 브랜치와 태그가 가리키는 커밋. TOP과 함께 그대로면 이력도 그대로라 git log를 건너뛴다.
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

async function load($: EngineInterface, prev: Repo): Promise<Repo> {
  // 오류로 커밋 목록이 비면 내용이 바뀐 것이므로 rev를 올린다(화면 줄 기억값이 이전 이력을 쓰지 않게).
  const empty = { ...EMPTY, rev: prev.commits.length ? prev.rev + 1 : prev.rev }
  try {
    const [status, top, refs] = await Promise.all([$.process.run(STATUS), $.process.run(TOP), $.process.run(REFS)])
    if (status.exitCode !== 0) return { ...empty, error: 'git 저장소가 아닙니다' }
    const [head = '', ...changes] = status.stdout.split('\n').filter(Boolean)
    const branch = statusBranch(head)
    const [toplevel = '', fetchHead = ''] = top.stdout.split('\n')
    const name = toplevel.trim().split('/').pop() ?? ''
    const fetched = await $.fs.stat(fetchHead.trim()).then(st => st.mtimeMs, () => 0)
    const base = { branch, name, changes: changes.length, files: changes.slice(0, 50), fetched }
    // 두 명령이 모두 성공했을 때만 이전 이력을 재사용한다. 실패하면 ref 상태를 알 수 없으므로 다시 읽는다.
    const cacheable = top.exitCode === 0 && refs.exitCode === 0
    const key = top.stdout + refs.stdout
    if (cacheable && key === lastRefs && !prev.error) return { ...prev, ...base }
    const [log, track] = await Promise.all([$.process.run(LOG), $.process.run(TRACK)])
    if (log.exitCode !== 0) return { ...empty, ...base, error: log.stderr.split('\n')[0] }
    lastRefs = cacheable ? key : ''
    const commits = parseLog(log.stdout)
    // 커밋 목록과 동기화 상태가 함께 바뀌므로 rev를 올린다. 화면 줄 기억값은 이 번호로 판단해 항상 이력과 같이 바뀐다.
    return { ...base, rev: prev.rev + 1, commits, more: commits.length >= LIMIT, track: parseTrack(track.stdout) }
  } catch (err) {
    return { ...empty, error: `git 실행 실패: ${String(err)}` }
  }
}

// 세션 시작이 다시 일어나도(플러그인을 다시 켜거나 작업 프로세스가 다시 뜰 때) 주기 갱신 타이머가 겹치지 않게 한다.
let ticker: { cancel: () => void } | undefined
let upgradeTicker: { cancel: () => void } | undefined

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
      const prev = await read($, repo)
      const next = await load($, prev)
      if (JSON.stringify(next) !== JSON.stringify(prev)) await update($, repo, () => next)
      lastEnd = await $.clock.now()
      cost = lastEnd - t0
    } while (again)
  } finally {
    busy = false
  }
}

const isOpen = async ($: EngineInterface) => (await $.ui.panes()).some(p => p.id === PANE)

// 커서가 간 커밋의 상세. 키를 누르고 있을 때 git이 쌓이지 않도록 커서가 잠깐 멈춘 뒤에 읽고, 읽은 것은 기억한다.
// ponytail: 해시별 기억은 모듈을 다시 불러오면 비워진다.
const details = new Map<string, Detail>()
let pending: { cancel: () => void } | undefined
async function showDetail($: EngineInterface, h: string) {
  const hit = details.get(h)
  pending?.cancel()
  // 기억한 상세는 상태에 다시 적지 않는다(적으면 한 번 더 그린다). 그리기가 기억에서 바로 읽는다.
  if (hit) return
  pending = $.clock.after(150, () => void loadDetail($, h).catch(() => {}))
}

async function loadDetail($: EngineInterface, h: string) {
  if ((await read($, view)).cur !== `c:${h}`) return
  const out = await $.process
    .run(['git', 'show', '--no-show-signature', '--diff-merges=first-parent', '--numstat', '--format=%an%x1f%ct%x1f%s', h])
    .catch(() => undefined)
  // 실패(그사이 사라진 커밋 등)는 표시만 하고 기억하지 않는다. 다음에 다시 가면 다시 읽는다.
  if (!out || out.exitCode !== 0) return void (await update($, detail, () => ({ ...NO_DETAIL, h, error: true as const })))
  const [first = '', ...rest] = out.stdout.split('\n')
  const [author = '', t = '0', s = ''] = first.split('\x1f')
  // --numstat 줄은 '추가<탭>삭제<탭>경로'다. 바이너리 파일은 수 대신 '-'다.
  const paths = rest.flatMap(line => {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
    return m ? [{ p: m[3]!, a: Number(m[1]) || 0, d: Number(m[2]) || 0 }] : []
  })
  const d: Detail = {
    h, author, t: Number(t), s,
    files: paths.length,
    add: paths.reduce((n, x) => n + x.a, 0),
    del: paths.reduce((n, x) => n + x.d, 0),
    paths: [...paths].sort((x, y) => y.a + y.d - (x.a + x.d)).slice(0, 5),
  }
  // ponytail: 1,000개를 넘으면 통째로 비운다. 커밋 하나당 100바이트 남짓이라 그 전까지는 그대로 둔다.
  if (details.size >= 1000) details.clear()
  details.set(h, d)
  await update($, detail, () => d)
}

// 화면 줄은 이력(rev), 펼친 구간, 고른 것, 시각(분 단위)이 바뀔 때만 다시 계산한다. 스크롤할 때마다 계산하지 않는다.
let rowsMemo: { key: string; rows: Row[] } | undefined
let relMemo: { rev: number; rel: ReturnType<typeof releases> } | undefined
async function rowsOf($: EngineInterface, given?: { v?: View; r?: Repo; now?: number }): Promise<Row[]> {
  const [v, r, t] = await Promise.all([given?.v ?? read($, view), given?.r ?? read($, repo), given?.now ?? $.clock.now()])
  const key = `${r.rev}|${r.changes}|${v.open.join(',')}|${v.marks.join(',')}|${Math.floor(t / 60000)}`
  if (rowsMemo?.key === key) return rowsMemo.rows
  const rows = buildRows(r.commits, new Set(v.open), t, { track: r.track, marks: new Set(v.marks), wip: r.changes })
  if (r.more) rows.push({ key: 'more', graph: [], label: [{ t: `최근 커밋 ${LIMIT}개까지만 보여 줍니다`, dim: true }], age: '' })
  rowsMemo = { key, rows }
  return rows
}

// 커서가 있는 줄을 고를 대상으로 바꾼다. x는 커밋, b는 그 줄에 붙은 브랜치다.
const targetOf = (row: Row | undefined, kind: 'c' | 'b') =>
  kind === 'c' ? (row?.hash ? `c:${row.hash}` : '') : row?.branch ? `b:${row.branch}` : ''

async function toggleMark($: EngineInterface, kind: 'c' | 'b') {
  const [v, rows] = await Promise.all([read($, view), rowsOf($)])
  const id = targetOf(rows.find(r => r.key === v.cur), kind)
  if (!id) return $.ui.toast(kind === 'b' ? '이 줄에는 브랜치가 없습니다' : '커밋 줄에서 고를 수 있습니다')
  await update($, view, x => ({ ...x, marks: x.marks.includes(id) ? x.marks.filter(m => m !== id) : [...x.marks, id] }))
}

type Say = (list: string, branch: string) => string
// branches: 고른 것 중 브랜치만 넣는다(없으면 커서 줄의 브랜치)
const ACTIONS: { hotkey: string; label: string; say: Say; branches?: true }[] = [
  { hotkey: '1', label: '체리픽', say: (list, b) => `다음을 ${b} 브랜치에 체리픽해 줘: ${list}` },
  { hotkey: '2', label: '리베이스', say: (list, b) => `${b} 브랜치를 다음 위로 리베이스해 줘: ${list}` },
  { hotkey: '3', label: '병합', say: (list, b) => `다음을 ${b} 브랜치에 병합해 줘: ${list}` },
  { hotkey: '4', label: '되돌리기', say: list => `다음 커밋을 revert해 줘: ${list}` },
  { hotkey: '5', label: '리뷰', say: list => `다음 변경을 리뷰해 줘: ${list}` },
  { hotkey: '6', label: '브랜치 삭제', say: list => `다음 브랜치를 지워 줘: ${list}`, branches: true },
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

async function send($: EngineInterface, say?: Say, branches?: true) {
  const [r, v, rows] = await Promise.all([read($, repo), read($, view), rowsOf($)])
  const live = liveMarks(v.marks, r.commits).filter(m => !branches || m.startsWith('b:'))
  const row = rows.find(x => x.key === v.cur)
  const marks = live.length ? live : [targetOf(row, branches ? 'b' : 'c') || targetOf(row, 'b')].filter(Boolean)
  if (!marks.length) return $.ui.toast(branches ? '고른 브랜치가 없습니다. b로 고르거나 커서를 브랜치가 있는 줄에 두세요' : '고른 것이 없습니다. x로 고르거나 커서를 커밋 줄에 두세요')
  const list = promptList(marks, r.commits)
  const filled = await $.prompt.fill({ text: `${say ? say(list, r.branch.split(' ')[0] || 'HEAD') : list} `, mode: 'insert' })
  if (!filled.isFilled) return $.ui.toast('입력창에 넣지 못했습니다')
  await update($, view, x => ({ ...x, marks: [] }))
  $.ui.toast('입력창에 넣었습니다. Esc로 입력창에 돌아가 보내세요')
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const pressable = (r?: Row) => !!(r?.hash || r?.fold || r?.wip)

type Win = Pick<View, 'cur' | 'off' | 'start'>

// 터미널은 커서를 화면의 자리로 기억하고, 방향키는 그 자리에서 한 칸 움직인다. 그래서 커서가 창 안에서 움직이는
// 동안에는 창을 옮기지 않고, 커서 줄이 화면의 같은 자리(off)에 오도록 창의 첫 줄을 정한다. 새 커밋이 위에 생겨도
// 커서는 같은 자리, 같은 커밋에 남는다.
export function windowStart(rows: Row[], v: Win, height: number): number {
  const i = rows.findIndex(r => r.key === v.cur)
  return clamp(i >= 0 ? i - v.off : v.start, 0, Math.max(0, rows.length - height))
}

// 방향키로 창 끝에서 더 나가려 할 때: 다음(dir 1) 또는 이전(dir -1)의 누를 수 있는 줄이 창 끝에 보이도록
// 창을 옮기고 커서를 그 줄로 옮긴다. 더 갈 줄이 없으면 undefined.
export function stepped(rows: Row[], v: Win, height: number, dir: 1 | -1): Win | undefined {
  const i = rows.findIndex(r => r.key === v.cur)
  if (i < 0) return undefined
  let j = i + dir
  while (j >= 0 && j < rows.length && !pressable(rows[j])) j += dir
  if (j < 0 || j >= rows.length) return undefined
  const s = windowStart(rows, v, height)
  const start = clamp(dir > 0 ? Math.max(s, j - height + 1) : Math.min(s, j), 0, Math.max(0, rows.length - height))
  return { cur: rows[j]!.key, off: j - start, start }
}

// 창을 delta줄 옮기고, 커서는 화면의 같은 자리에서 가장 가까운 누를 수 있는 줄로 옮긴다(마우스 휠, 경계 줄 클릭).
export function scrolled(rows: Row[], v: Win, height: number, delta: number): Win {
  const start = clamp(windowStart(rows, v, height) + delta, 0, Math.max(0, rows.length - height))
  const want = start + clamp(v.off, 0, height - 1)
  for (let d = 0; d < height; d++) {
    for (const k of [want + d, want - d]) {
      if (k >= start && k < start + height && pressable(rows[k])) return { cur: rows[k]!.key, off: k - start, start }
    }
  }
  return { cur: v.cur, off: v.off, start }
}

// 커서가 창 안에서 그 방향의 마지막 누를 수 있는 줄에 있는지(그다음 방향키가 경계 줄로 가는 경우)
function atEdge(rows: Row[], v: Win, height: number, dir: 1 | -1): boolean {
  const s = windowStart(rows, v, height)
  const i = rows.findIndex(r => r.key === v.cur)
  if (i < 0) return true
  for (let k = i + dir; k >= s && k < Math.min(rows.length, s + height); k += dir) if (pressable(rows[k])) return false
  return true
}

async function moveTo($: EngineInterface, w: Win) {
  await update($, view, x => ({ ...x, ...w }))
  // 이 플러그인이 부른 $.ui.focus는 자기 ui.focus 훅을 거치지 않으므로, 커서 상태는 위에서 먼저 적는다.
  void $.ui.focus({ requestId: PANE, key: w.cur }).catch(() => {})
  if (w.cur.startsWith('c:')) await showDetail($, w.cur.slice(2))
}

// 클릭으로도 패널에 키보드가 들어오게 한다. 입력창이 비어 있을 때만 받아들여지는 요청이다.
async function focusPane($: EngineInterface, key?: string) {
  await open($, true)
  if (key) await $.ui.focus({ requestId: PANE, key }).catch(() => {})
}

// focus는 요청이다. 입력창이 비어 있을 때만 받아들여지므로 /git-graph를 보낸 직후에는 패널로 키보드가 옮겨진다.
const open = ($: EngineInterface, focus?: true) => $.ui.open({ id: PANE, title: 'Git', ...(focus && { focus }) })

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
    ticker?.cancel()
    ticker = $.clock.every(2000, () => void tick().catch(() => {}))
    // 새 버전은 세션을 시작할 때와 6시간마다 확인한다. 세션 시작을 기다리게 하지 않도록 끝을 기다리지 않는다.
    await readVersion($)
    void checkUpgrade($).catch(() => {})
    upgradeTicker?.cancel()
    upgradeTicker = $.clock.every(6 * 3600_000, () => void checkUpgrade($).catch(() => {}))
    return started
  })

  on('command.run', { command: 'git-graph' }, async $ => {
    await refresh($)
    await open($, true)
    return { text: 'git 그래프 패널을 열었습니다. Esc로 입력창에 돌아옵니다.' }
  })

  // 읽기 전용이 아닌 도구가 끝나면 바로 반영한다. 커밋, 브랜치 전환, 파일 수정이 여기에 해당하고 하위 에이전트의 도구도 포함된다.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (!ran.isReadOnly) {
      void isOpen($)
        .then(shown => (shown ? refresh($) : undefined))
        .catch(() => {})
    }
    return ran
  }).catch(($, e, next) => next(e)) // 실패해도 도구 결과를 그대로 넘긴다. next를 이미 불렀으면 그 결과를 다시 쓴다.

  // 방향키나 클릭으로 커서가 움직이면 기록한다. 창 끝에서 더 나가려 하면 그래프를 한 줄 옮긴다.
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const el = e.element
    const person = e.origin.kind === 'person'
    // 방향키와 Tab이 아래 단축키 버튼으로 넘어가지 않게 한다. 단축키는 글자 키나 클릭으로 누른다.
    if (el?.startsWith('act:') && person) return {}
    // 그래프 위아래 경계 줄로 가려는 이동은 막는다. 커서가 그 끝에 붙어 있었다면 방향키로 더 나가려 한 것이므로 한 줄 옮긴다.
    if (el?.startsWith('edge:')) {
      if (person) {
        const dir = el === 'edge:bottom' ? 1 : -1
        const [rows, v] = await Promise.all([rowsOf($), read($, view)])
        const w = atEdge(rows, v, lastRows, dir) ? stepped(rows, v, lastRows, dir) : undefined
        if (w) await moveTo($, w)
      }
      return {}
    }
    const done = await next(e)
    if (!el) return done
    const [rows, v] = await Promise.all([rowsOf($), read($, view)])
    const i = rows.findIndex(r => r.key === el)
    if (i < 0) return done
    const s = windowStart(rows, v, lastRows)
    // 창 안이면 창은 그대로 두고 자리만 적는다. 창 밖(드문 경우)이면 커서가 끝에 보이도록 창을 옮긴다.
    const off = i - s
    const w: Win =
      off >= 0 && off < lastRows ? { cur: el, off, start: s } : off < 0 ? { cur: el, off: 0, start: i } : { cur: el, off: lastRows - 1, start: i - lastRows + 1 }
    await update($, view, x => ({ ...x, ...w }))
    if (el.startsWith('c:')) await showDetail($, el.slice(2))
    return done
  })

  // 마우스 휠은 그래프 영역을 3줄씩 옮긴다.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [rows, v] = await Promise.all([rowsOf($), read($, view)])
    await moveTo($, scrolled(rows, v, lastRows, Math.sign(e.by) * 3))
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [r, v, dState, upLabel, now] = await Promise.all([read($, repo), read($, view), read($, detail), upgradeLabel($), $.clock.now()])
    // 마지막 칸에 글자를 쓰면 줄이 넘어갈 수 있어 한 칸 남긴다.
    const cols = Math.max(20, e.props.bodyColumns - 1)
    const total = Math.max(4, e.props.scroll.bodyRows)
    // 위 2줄(브랜치, 릴리스), 그래프 위아래 경계 줄 2줄, 아래 단축키 3줄과 안내 1줄, 상세 6줄. 패널이 낮으면 상세부터 뺀다.
    const hasActions = total >= 14
    const hasDetail = total >= 24
    lastRows = Math.max(1, total - 4 - (hasActions ? 4 : 0) - (hasDetail ? DETAIL_ROWS : 0))
    const focused = e.props.isFocused

    const seg = (s: Seg) => (
      <Text color={s.color} dimColor={s.dim} weight={s.bold && 'bold'} inverse={s.inverse} underline={s.underline}>
        {s.t}
      </Text>
    )
    // 색과 모양이 같은 이웃 글자는 Text 하나로 합쳐 터미널에 넘기는 요소 수를 절반 이하로 줄인다.
    const segs = (list: Seg[]) => merge(list).map(seg)
    const header = fit(
      [{ t: r.branch, bold: true }, ...(r.changes ? [{ t: `  변경 ${r.changes}개`, dim: true as const }] : [])],
      [{ t: r.name, dim: true }],
      cols,
    )
    if (relMemo?.rev !== r.rev) relMemo = { rev: r.rev, rel: releases(r.commits) }
    const rel = relMemo.rel
    // 새 버전이 있으면 둘째 줄 오른쪽에 fetch 시각 대신 u 버튼을 둔다.
    const header2 = fit(
      rel.flatMap((x, i): Seg[] => [...(i ? [{ t: '  ' }] : []), { t: `◇ ${x.tag}`, color: 'yellow' }, { t: ` +${x.ahead}`, dim: true }]),
      upLabel ? [] : [{ t: r.fetched ? `fetch ${ageLong(r.fetched / 1000, now)}` : 'fetch 기록 없음', dim: true }],
      upLabel ? Math.max(1, cols - width(`u: ${upLabel}`) - 1) : cols,
    )
    if (r.error) {
      return (
        <Box flexDirection="column">
          {r.branch && <Text>{segs(header)}</Text>}
          <Text dimColor wrap="truncate-end">{r.error}</Text>
        </Box>
      )
    }

    const rows = await rowsOf($, { v, r, now })
    const start = windowStart(rows, v, lastRows)
    const shown = trimGraphs(rows.slice(start, start + lastRows))
    // Enter와 클릭: 접힌 줄은 펼치거나 접는다. 커밋 줄은 커서를 옮기는 것과 같다(클릭으로 키보드가 넘어오지 않아도 상세는 바뀐다).
    const press = async (row: Row) => {
      void focusPane($, row.key)
      const off = clamp(rows.findIndex(r => r.key === row.key) - start, 0, lastRows - 1)
      await update($, view, x => ({
        ...x,
        cur: row.key,
        off,
        open: !row.fold ? x.open : x.open.includes(row.fold) ? x.open.filter(f => f !== row.fold) : [...x.open, row.fold],
      }))
      if (row.hash) await showDetail($, row.hash)
    }
    const curRow = rows.find(r => r.key === v.cur)
    const marked = liveMarks(v.marks, r.commits).length

    const foot: Seg[][] = []
    if (hasDetail) {
      const d = (curRow?.hash && details.get(curRow.hash)) || dState
      // 파일 한 줄: 커밋은 +추가 -삭제, 작업 중 변경은 상태 두 글자. 경로가 길면 앞을 줄인다.
      const fileLine = (lead: Seg[], path: string) => {
        const used = width(lead.map(x => x.t).join(''))
        return [...lead, { t: tail(path, Math.max(1, cols - used)) }]
      }
      const more = (n: number): Seg[] => [{ t: `외 ${n}개`, dim: true }]
      if (curRow?.wip) {
        const list = r.files
        const shown = list.length > DETAIL_ROWS - 1 ? list.slice(0, DETAIL_ROWS - 2) : list
        foot.push([{ t: `작업 중 변경 ${r.changes}개`, bold: true }])
        for (const line of shown) {
          const code = line.slice(0, 2)
          const color = code.includes('?') || code.includes('A') ? 'green' : code.includes('D') ? 'red' : code.includes('R') ? 'cyan' : 'yellow'
          foot.push(fileLine([{ t: code, color }, { t: ' ' }], line.slice(3)))
        }
        if (shown.length < list.length || r.changes > list.length) foot.push(more(r.changes - shown.length))
      } else if (curRow?.hash && d.h === curRow.hash && d.error) {
        foot.push([{ t: d.h.slice(0, 7), color: 'yellow' }], [{ t: '이 커밋의 상세를 읽지 못했습니다', dim: true }])
      } else if (curRow?.hash && d.h === curRow.hash) {
        foot.push(
          fit([{ t: d.h.slice(0, 7), color: 'yellow' }, { t: `  ${d.author}  ${ageLong(d.t, now)}`, dim: true }], [], cols),
          fit([{ t: d.s, bold: true }], [], cols),
          d.files
            ? [{ t: `파일 ${d.files}개  `, dim: true }, { t: `+${d.add}`, color: 'green' }, { t: '  ' }, { t: `-${d.del}`, color: 'red' }]
            : [{ t: '변경 없음', dim: true }],
        )
        const room = DETAIL_ROWS - 3
        const shown = d.files > room ? d.paths.slice(0, room - 1) : d.paths.slice(0, room)
        for (const x of shown) foot.push(fileLine([{ t: `+${x.a}`, color: 'green' }, { t: ' ' }, { t: `-${x.d}`, color: 'red' }, { t: '  ' }], x.p))
        if (d.files > shown.length) foot.push(more(d.files - shown.length))
      } else if (curRow?.hash) {
        foot.push([{ t: '불러오는 중', dim: true }])
      } else if (curRow?.fold) {
        const isOpen = v.open.includes(curRow.fold)
        foot.push(fit(curRow.label, [], cols), [{ t: isOpen ? 'Enter나 클릭으로 접기' : 'Enter나 클릭으로 펼치기', dim: true }])
      } else {
        foot.push([{ t: '커서가 있는 커밋의 내용이 여기에 나옵니다', dim: true }], [{ t: 'x로 커밋, b로 브랜치를 고른 뒤 p나 숫자로 입력창에 넣기', dim: true }])
      }
      while (foot.length < DETAIL_ROWS) foot.push([])
    }
    // 단축키는 패널이 키보드를 가지고 있을 때 동작한다. 고른 것이 없으면 커서가 있는 줄을 쓴다.
    const act = (hotkey: string, label: string, onPress: () => unknown) => (
      <Button key={`act:${hotkey}`} plain hotkey={hotkey} onPress={() => void focusPane($).catch(() => {}).then(() => onPress())}>{label}</Button>
    )
    const gap = <Text>  </Text>
    // 그래프 위아래 경계 줄. 방향키가 창 끝에서 더 나가려 하면 이 줄로 가려 하므로 그것으로 방향을 안다. 클릭하면 한 화면 넘긴다.
    const below = Math.max(0, rows.length - start - lastRows)
    const page = async (dir: 1 | -1) => {
      const [rs, vv] = await Promise.all([rowsOf($), read($, view)])
      void open($, true)
      await moveTo($, scrolled(rs, vv, lastRows, dir * Math.max(1, lastRows - 1)))
    }
    const edge = (key: string, text: string, dir: 1 | -1) => {
      const label = text ? `── ${text} ` : ''
      return (
        <Button key={key} plain onPress={() => void page(dir)}>
          <Text dimColor>{label + '─'.repeat(Math.max(0, cols - width(label)))}</Text>
        </Button>
      )
    }
    // 패널에 들어오면 커서는 마지막 위치에서, 처음이면 첫 줄에서 시작한다.
    const ring = shown.some(r => r.key === v.cur) ? v.cur : shown.find(pressable)?.key
    // 키보드가 어디 있는지에 따라 맨 아래 안내를 바꾼다.
    const hint: Seg[] = focused
      ? [{ t: '↑↓ 이동  Enter 펼치기  Esc 입력창으로  ctrl+x x 닫기', dim: true }]
      : [{ t: 'ctrl+x tab', color: 'cyan' }, { t: ' 또는 클릭으로 들어오기  ', dim: true }, { t: '/git-graph', color: 'cyan' }]

    return (
      <Box flexDirection="column">
        <Text>{segs(header)}</Text>
        {upLabel ? (
          <Box flexDirection="row">
            <Text>{segs(header2)}</Text>
            <Text> </Text>
            <Button key="act:u" plain hotkey="u" onPress={() => void applyUpgrade($).catch(() => {})}>
              <Text color="cyan">{upLabel}</Text>
            </Button>
          </Box>
        ) : (
          <Text>{segs(header2)}</Text>
        )}
        {edge('edge:top', start ? `▲ 위로 ${start}줄` : '', -1)}
        {shown.map(row => {
          const line = fit([...row.graph, { t: '  ' }, ...row.label], row.age ? [{ t: row.age, dim: true }] : [], cols)
          const kids = segs(line)
          return pressable(row) ? (
            <Button key={row.key} plain autoFocus={row.key === ring || undefined} onPress={() => void press(row)}>{kids}</Button>
          ) : (
            <Text>{kids}</Text>
          )
        })}
        {Array.from({ length: Math.max(0, lastRows - shown.length) }, () => <Text> </Text>)}
        {edge('edge:bottom', below ? `▼ 아래로 ${below}줄` : '', 1)}
        {foot.map(line => <Text>{line.length ? segs(line) : ' '}</Text>)}
        {hasActions && (
          <Box flexDirection="row">
            {act('x', '고르기', () => toggleMark($, 'c'))}{gap}{act('b', '브랜치', () => toggleMark($, 'b'))}{gap}{act('p', '넣기', () => send($))}{gap}
            <Text dimColor>{marked ? `고른 것 ${marked}개` : '고른 것 없음'}</Text>
          </Box>
        )}
        {hasActions && <Box flexDirection="row">{ACTIONS.slice(0, 3).flatMap(a => [act(a.hotkey, a.label, () => send($, a.say, a.branches)), gap])}</Box>}
        {hasActions && <Box flexDirection="row">{ACTIONS.slice(3).flatMap(a => [act(a.hotkey, a.label, () => send($, a.say, a.branches)), gap])}</Box>}
        {hasActions && <Text>{segs(fit(hint, [], cols))}</Text>}
      </Box>
    )
  })
}
