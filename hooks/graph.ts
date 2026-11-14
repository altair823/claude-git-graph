// 커밋 목록을 레인 그래프로 배치하고, 접기와 펼치기를 반영한 화면 줄로 만든다.
// $를 쓰지 않는 순수 함수만 둔다.
import type { Commit, Track } from '../types'

export type Seg = {
  t: string
  color?: string
  dim?: true
  bold?: true
  inverse?: true
  underline?: true
}

export type Row = {
  key: string
  graph: Seg[]
  label: Seg[]
  age: string
  hash?: string
  fold?: string
  // 브랜치 끝을 접은 줄이면 그 브랜치 이름(x로 브랜치를 고를 때 쓴다)
  branch?: string
}

// 화면에 보일 이름표. 원격 이름은 로컬 브랜치와 합치거나 숨긴 뒤 남은 것만 있다.
// localOnly: upstream도 같은 이름의 원격 브랜치도 없는 로컬 브랜치. ahead는 그때 어느 원격에도 없는 커밋 수다.
type Ref = { kind: 'local' | 'remote' | 'tag'; name: string; ahead?: number; behind?: number; gone?: true; localOnly?: true }

export type Ctx = { track: Record<string, Track>; marks: ReadonlySet<string> }

// 터미널 테마를 따라가도록 ANSI 색 이름을 쓴다.
export const PALETTE = ['blue', 'magenta', 'green', 'cyan', 'yellow', 'red']

export function parseLog(out: string): Commit[] {
  return out
    .split('\x1e')
    .map(r => r.replace(/\n+$/, ''))
    .filter(Boolean)
    .map(r => {
      const [h = '', p = '', d = '', s = '', t = '0'] = r.split('\x1f')
      return { h, p: p ? p.split(' ') : [], refs: d ? d.split(', ') : [], s, t: Number(t) }
    })
}

const isHeadRef = (r: string) => r === 'HEAD' || r.startsWith('HEAD -> ')
const tagName = (r: string) => r.replace(/^tag: (refs\/tags\/)?/, '')

function ancestors(byHash: Map<string, Commit>, from: string | string[]): Set<string> {
  const seen = new Set<string>()
  const stack = typeof from === 'string' ? [from] : [...from]
  while (stack.length) {
    const h = stack.pop()!
    const c = byHash.get(h)
    if (!c || seen.has(h)) continue
    seen.add(h)
    stack.push(...c.p)
  }
  return seen
}

// git log --decorate=full의 %D를 화면용 이름표로 바꾼다.
// 원격 브랜치는 추적하는 로컬 브랜치와 같은 커밋이면 로컬 칩에 합치고, 추적하는 로컬이 없으면서 HEAD에 이미 병합됐으면 숨긴다.
function visibleRefs(commits: Commit[], track: Record<string, Track>): Map<string, Ref[]> {
  const byHash = new Map(commits.map(c => [c.h, c]))
  const head = commits.find(c => c.refs.some(isHeadRef))
  const merged = head ? ancestors(byHash, head.h) : new Set<string>()
  const localAt = new Map<string, string>()
  const remoteAt = new Map<string, string>()
  for (const c of commits) {
    for (const raw of c.refs) {
      const r = raw.replace(/^HEAD -> /, '')
      if (r.startsWith('refs/heads/')) localAt.set(r.slice(11), c.h)
      if (r.startsWith('refs/remotes/') && !r.endsWith('/HEAD')) remoteAt.set(r.slice(13), c.h)
    }
  }
  // 원격 하나를 여러 로컬 브랜치가 추적할 수 있다. upstream 설정 없이 같은 이름으로 push한 브랜치도 추적하는 것으로 본다.
  const trackers = new Map<string, string[]>()
  const addTracker = (up: string, local: string) => trackers.set(up, [...(trackers.get(up) ?? []), local])
  for (const [local, t] of Object.entries(track)) addTracker(t.up, local)
  const sameName = (local: string) => [...remoteAt.keys()].find(r => r.slice(r.indexOf('/') + 1) === local)
  for (const local of localAt.keys()) {
    const up = track[local] ? undefined : sameName(local)
    if (up) addTracker(up, local)
  }
  // 어느 원격에서든 닿는 커밋. 로컬 전용 브랜치의 push 안 된 커밋 수를 셀 때 쓴다(읽은 범위 안에서).
  let onRemote: Set<string> | undefined
  const unpushed = (h: string) => {
    onRemote ??= ancestors(byHash, [...remoteAt.values()])
    let n = 0
    for (const x of ancestors(byHash, h)) if (!onRemote.has(x)) n++
    return n
  }
  const out = new Map<string, Ref[]>()
  for (const c of commits) {
    const refs: Ref[] = []
    for (const raw of c.refs) {
      const r = raw.replace(/^HEAD -> /, '')
      if (r === 'HEAD' || r.endsWith('/HEAD')) continue
      if (r.startsWith('tag: ')) refs.push({ kind: 'tag', name: tagName(r) })
      else if (r.startsWith('refs/heads/')) {
        const name = r.slice(11)
        const t = track[name]
        if (!t && !sameName(name)) {
          const n = unpushed(c.h)
          refs.push({ kind: 'local', name, localOnly: true, ...(n ? { ahead: n } : {}) })
        } else {
          refs.push({ kind: 'local', name, ...(t?.ahead ? { ahead: t.ahead } : {}), ...(t?.behind ? { behind: t.behind } : {}), ...(t?.gone ? { gone: true as const } : {}) })
        }
      } else if (r.startsWith('refs/remotes/')) {
        const name = r.slice(13)
        const locals = trackers.get(name)
        if (locals ? locals.some(l => localAt.get(l) === c.h) : merged.has(c.h)) continue
        refs.push({ kind: 'remote', name })
      }
    }
    out.set(c.h, refs)
  }
  return out
}

function chips(refs: Ref[], color: string | undefined): Seg[] {
  return refs.flatMap((r): Seg[] => {
    if (r.kind === 'tag') return [{ t: `◇ ${r.name}`, color: 'yellow', bold: true }, { t: ' ' }]
    if (r.kind === 'remote') return [{ t: r.name, color, dim: true }, { t: ' ' }]
    const sync = `${r.ahead ? `↑${r.ahead}` : ''}${r.behind ? `↓${r.behind}` : ''}`
    return [
      { t: ` ${r.name} `, color, inverse: true, bold: true },
      ...(r.localOnly ? [{ t: '로컬', dim: true as const }, ...(sync ? [{ t: ' ' }] : [])] : []),
      ...(sync ? [{ t: sync, color }] : []),
      ...(r.gone ? [{ t: '원격 삭제됨', dim: true as const }] : []),
      { t: ' ' },
    ]
  })
}

type Laid = {
  c: Commit
  refs: Ref[]
  isHead: boolean
  col: number
  before: boolean[]
  after: boolean[]
  joins: number[]
  outs: { lane: number; isNew: boolean }[]
  colors: number[]
}

export function layout(commits: Commit[], track: Record<string, Track> = {}): Laid[] {
  const shown = visibleRefs(commits, track)
  const lanes: (string | null)[] = []
  const colorOf: number[] = []
  let nextColor = 0
  const alloc = (avoid: Set<number>) => {
    let i = lanes.findIndex((x, k) => x === null && !avoid.has(k))
    if (i < 0) i = lanes.length
    lanes[i] = null
    colorOf[i] = nextColor++ % PALETTE.length
    return i
  }
  return commits.map(c => {
    const before = lanes.map(x => x !== null)
    let col = lanes.indexOf(c.h)
    if (col < 0) col = alloc(new Set())
    // 이 커밋을 부모로 기다리던 다른 레인은 여기서 합쳐진다(분기점).
    const joins: number[] = []
    const freed = new Set([col])
    lanes.forEach((x, i) => {
      if (x === c.h && i !== col) {
        joins.push(i)
        lanes[i] = null
        freed.add(i)
      }
    })
    lanes[col] = c.p[0] ?? null
    // 두 번째 부모부터는 병합으로 들어온 선이다. 방금 합쳐진 레인은 피해서 한 칸이 위아래로 겹치지 않게 한다.
    const outs = c.p.slice(1).map(p => {
      const i = lanes.indexOf(p)
      if (i >= 0) return { lane: i, isNew: false }
      const n = alloc(freed)
      lanes[n] = p
      return { lane: n, isNew: true }
    })
    const after = lanes.map(x => x !== null)
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    return { c, refs: shown.get(c.h) ?? [], isHead: c.refs.some(isHeadRef), col, before, after, joins, outs, colors: [...colorOf] }
  })
}

const CROSS: Record<string, string> = {
  ' ': '─', '│': '┼', '╯': '┴', '╰': '┴', '╮': '┬', '╭': '┬', '┤': '┼', '├': '┼',
}

// 한 커밋 줄의 그래프 문자. 레인 하나가 2칸이다.
function cells(r: Laid, width: number, node: string): Seg[] {
  const out: { ch: string; lane: number }[] = Array.from({ length: width * 2 - 1 }, () => ({ ch: ' ', lane: -1 }))
  const set = (lane: number, ch: string) => (out[lane * 2] = { ch, lane })
  for (let i = 0; i < width; i++) if (r.before[i] && r.after[i] && i !== r.col) set(i, '│')
  for (const j of r.joins) set(j, j > r.col ? '╯' : '╰')
  for (const o of r.outs) set(o.lane, o.isNew ? (o.lane > r.col ? '╮' : '╭') : o.lane > r.col ? '┤' : '├')
  for (const j of [...r.joins, ...r.outs.map(o => o.lane)]) {
    const [a, b] = j > r.col ? [r.col * 2 + 1, j * 2 - 1] : [j * 2 + 1, r.col * 2 - 1]
    for (let k = a; k <= b; k++) out[k] = { ch: CROSS[out[k]!.ch] ?? out[k]!.ch, lane: j }
  }
  set(r.col, node)
  return out.map(({ ch, lane }) => (lane < 0 ? { t: ch } : { t: ch, color: PALETTE[r.colors[lane]!] }))
}

function passing(r: Laid, width: number, ch: string): Seg[] {
  const out: Seg[] = []
  for (let i = 0; i < width; i++) {
    out.push(r.after[i] ? { t: ch, color: PALETTE[r.colors[i]!] } : { t: ' ' })
    if (i < width - 1) out.push({ t: ' ' })
  }
  return out
}

// 지난 시간을 가장 큰 단위로 나타낸다. 1시간이 안 되면 분 단위다.
const UNITS = [[31557600, 'y', '년'], [2629800, 'mo', '개월'], [604800, 'w', '주'], [86400, 'd', '일'], [3600, 'h', '시간'], [60, 'm', '분']] as const
function since(t: number, now: number) {
  const s = Math.max(0, now / 1000 - t)
  const u = UNITS.find(([sec]) => s >= sec) ?? UNITS[5]
  return { s, n: Math.floor(s / u[0]), short: u[1], long: u[2] }
}
export const age = (t: number, now: number) => {
  const { n, short } = since(t, now)
  return `${n}${short}`
}
export const ageLong = (t: number, now: number) => {
  const { s, n, long } = since(t, now)
  return s < 60 ? '방금' : `${n}${long} 전`
}

const MARK: Seg = { t: '✓ ', color: 'green', bold: true }

// 기본 화면(B)에 남는 커밋: HEAD, 이름표가 남은 커밋, 병합, 분기점, 첫 커밋.
const isKey = (r: Laid) => r.isHead || r.refs.length > 0 || r.c.p.length !== 1 || r.joins.length > 0

export function buildRows(commits: Commit[], open: ReadonlySet<string>, now: number, ctx: Ctx = { track: {}, marks: new Set() }): Row[] {
  const laid = layout(commits, ctx.track)
  const width = Math.max(1, ...laid.map(r => Math.max(r.before.length, r.after.length, r.col + 1)))
  const rows: Row[] = []
  const color = (r: Laid) => PALETTE[r.colors[r.col]!]
  const mark = (on: boolean): Seg[] => (on ? [MARK] : [])
  // 펼친 구간과 그 안의 커밋(A 화면): 그래프와 제목을 모두 보여 준다.
  const full = (r: Laid): Row => ({
    key: `c:${r.c.h}`,
    hash: r.c.h,
    graph: cells(r, width, r.isHead ? '◉' : '●'),
    label: [...mark(ctx.marks.has(`c:${r.c.h}`)), ...chips(r.refs, color(r)), { t: r.c.s }],
    age: age(r.c.t, now),
  })
  // 접힌 화면의 주요 커밋(B 화면): 이름표만, 없으면 병합 대상이나 짧은 해시.
  const brief = (r: Laid): Row => {
    // git 기본 병합 제목과 Gitea, GitHub PR 병합 제목에서 들어온 브랜치 이름을 꺼낸다.
    const merged = /^Merge branch '([^']+)'/.exec(r.c.s)?.[1] ?? /^Merge pull request .* from (\S+)/.exec(r.c.s)?.[1]
    const label: Seg[] = [...mark(ctx.marks.has(`c:${r.c.h}`)), ...chips(r.refs, color(r))]
    if (r.c.p.length > 1) label.push({ t: 'merge ', dim: true }, merged ? { t: merged, color: PALETTE[r.colors[r.outs[0]?.lane ?? r.col]!] } : { t: r.c.s, dim: true })
    else if (!r.refs.length) label.push({ t: r.c.h.slice(0, 7), dim: true })
    return { key: `c:${r.c.h}`, hash: r.c.h, graph: cells(r, width, r.isHead ? '◉' : r.c.p.length === 0 ? '○' : '●'), label, age: age(r.c.t, now) }
  }
  for (let i = 0; i < laid.length; ) {
    const r = laid[i]!
    let j = i + 1
    while (j < laid.length && !isKey(laid[j]!)) j++
    const run = laid.slice(i + 1, j)
    // 브랜치 끝 뒤의 커밋이 모두 같은 레인에 있을 때만 그 브랜치의 개수로 묶는다.
    const tipOnly = r.refs.some(x => x.kind !== 'tag') && r.c.p.length === 1 && r.joins.length === 0 && run.every(x => x.col === r.col)
    if (!isKey(r)) {
      // 맨 위 커밋에 이름이 없으면(목록이 잘린 경우 등) 구간으로 다룬다.
      j = i
      while (j < laid.length && !isKey(laid[j]!)) j++
      pushRun(laid.slice(i, j), `r:${r.c.h}`)
    } else if (tipOnly && run.length) {
      const id = `t:${r.c.h}`
      const isOpen = open.has(id)
      const branch = (r.refs.find(x => x.kind === 'local') ?? r.refs.find(x => x.kind === 'remote'))!.name
      rows.push({
        key: `f:${id}`,
        fold: id,
        branch,
        graph: cells(r, width, r.isHead ? '◉' : '◆'),
        // 펼치기 개수를 이름표 앞에 두어 긴 브랜치 이름에 잘리지 않게 한다.
        label: [...mark(ctx.marks.has(`b:${branch}`)), { t: `${isOpen ? '▾' : '▸'} ${run.length + 1}`, underline: true }, { t: ' ' }, ...chips(r.refs, color(r))],
        age: age(r.c.t, now),
      })
      if (isOpen) for (const x of [r, ...run]) rows.push(full(x))
    } else {
      rows.push(brief(r))
      if (run.length) pushRun(run, `r:${run[0]!.c.h}`)
    }
    i = j
  }
  return rows

  function pushRun(run: Laid[], id: string) {
    const isOpen = open.has(id)
    rows.push({
      key: `f:${id}`,
      fold: id,
      graph: passing(run[run.length - 1]!, width, isOpen ? '│' : '┊'),
      label: [{ t: `${isOpen ? '▾' : '▸'} 커밋 ${run.length}개`, underline: true }],
      age: '',
    })
    if (isOpen) for (const x of run) rows.push(full(x))
  }
}

// 태그 계열(v*, app-v* 등)마다 HEAD에서 가장 가까운 태그와, 그 뒤로 쌓인 커밋 수. 가까운 계열부터 둘까지.
export function releases(commits: Commit[]): { tag: string; ahead: number }[] {
  const byHash = new Map(commits.map(c => [c.h, c]))
  const head = commits.find(c => c.refs.some(isHeadRef))
  if (!head) return []
  const all = ancestors(byHash, head.h)
  const found = new Map<string, { tag: string; h: string }>()
  const seen = new Set<string>()
  const queue = [head.h]
  while (queue.length && found.size < 2) {
    const h = queue.shift()!
    const c = byHash.get(h)
    if (!c || seen.has(h)) continue
    seen.add(h)
    for (const r of c.refs.filter(x => x.startsWith('tag: '))) {
      const tag = tagName(r)
      const family = tag.replace(/\d.*$/, '')
      if (!found.has(family)) found.set(family, { tag, h })
    }
    queue.push(...c.p)
  }
  return [...found.values()].map(({ tag, h }) => {
    const base = ancestors(byHash, h)
    let ahead = 0
    for (const x of all) if (!base.has(x)) ahead++
    return { tag, ahead }
  })
}

// git status --branch의 첫 줄에서 브랜치와 ahead/behind를 꺼낸다. git은 브랜치 이름에 '..'를 허용하지 않으므로
// '...' 앞까지가 브랜치 이름이다(이름에 점이 있어도 된다).
export function statusBranch(head: string): string {
  const m = /^## (?:No commits yet on )?(.+?)(?:\.\.\.\S+)?(?: \[([^\]]*)\])?$/.exec(head)
  const state = m?.[2] ?? ''
  const ahead = /ahead (\d+)/.exec(state)?.[1]
  const behind = /behind (\d+)/.exec(state)?.[1]
  return [m?.[1] ?? head.slice(3), ahead && `↑${ahead}`, behind && `↓${behind}`].filter(Boolean).join(' ')
}

// 고른 것 중 아직 이력에 있는 것만 남긴다(rebase나 amend로 사라진 커밋, 지워진 브랜치는 뺀다).
export function liveMarks(marks: readonly string[], commits: Commit[]): string[] {
  const hashes = new Set(commits.map(c => c.h))
  const branches = new Set(commits.flatMap(c => c.refs.map(r => r.replace(/^HEAD -> /, '').replace(/^refs\/(heads|remotes)\//, ''))))
  return marks.filter(m => (m.startsWith('c:') ? hashes.has(m.slice(2)) : branches.has(m.slice(2))))
}

// 화면에 보이는 줄들의 그래프 폭을 그 줄들에서 가장 오른쪽 선까지로 줄인다.
export function trimGraphs(rows: Row[]): Row[] {
  const used = Math.max(0, ...rows.map(r => r.graph.reduce((n, s, i) => (s.t.trim() ? i + 1 : n), 0)))
  return rows.map(r => ({ ...r, graph: r.graph.slice(0, used) }))
}

// 터미널 칸 수. 한글과 전각 문자는 2칸, 결합 문자와 폭 없는 문자는 0칸이다.
const cw = (ch: string) => {
  const c = ch.codePointAt(0) ?? 0
  if ((c >= 0x0300 && c <= 0x036f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x20d0 && c <= 0x20ff) || (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0xfe20 && c <= 0xfe2f)) return 0
  return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff)
    ? 2
    : 1
}
export const width = (s: string) => [...s].reduce((n, ch) => n + cw(ch), 0)

// 색과 모양이 같은 이웃 구간을 하나로 합친다.
export function merge(segs: Seg[]): Seg[] {
  const out: Seg[] = []
  for (const s of segs) {
    const p = out[out.length - 1]
    if (p && p.color === s.color && p.dim === s.dim && p.bold === s.bold && p.inverse === s.inverse && p.underline === s.underline) p.t += s.t
    else out.push({ ...s })
  }
  return out
}

// 왼쪽 구간을 cols칸에 맞춰 자르고, 오른쪽 끝에 right를 붙인다.
export function fit(left: Seg[], right: Seg[], cols: number): Seg[] {
  // 오른쪽만으로 폭을 넘으면 오른쪽도 잘라 cols칸을 넘지 않게 한다.
  if (right.reduce((n, s) => n + width(s.t), 0) > cols) right = fit(right, [], cols)
  const rw = right.reduce((n, s) => n + width(s.t), 0)
  const room = Math.max(0, cols - rw - (rw ? 1 : 0))
  const out: Seg[] = []
  let used = 0
  for (const s of left) {
    const w = width(s.t)
    if (used + w <= room) {
      out.push(s)
      used += w
      continue
    }
    // 말줄임표 한 칸도 남지 않으면 아무것도 넣지 않는다.
    if (room - used < 1) break
    let t = ''
    for (const ch of s.t) {
      if (used + width(t) + cw(ch) > room - 1) break
      t += ch
    }
    out.push({ ...s, t: t + '…' })
    used += width(t) + 1
    break
  }
  return [...out, { t: ' '.repeat(Math.max(0, cols - used - rw)) }, ...right]
}
