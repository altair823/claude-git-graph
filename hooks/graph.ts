// 커밋 목록을 레인 그래프로 배치하고, 접기와 펼치기를 반영한 화면 줄로 만든다.
// $를 쓰지 않는 순수 함수만 둔다.
import type { Commit } from '../types'

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
}

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

type Laid = {
  c: Commit
  col: number
  before: boolean[]
  after: boolean[]
  joins: number[]
  outs: { lane: number; isNew: boolean }[]
  colors: number[]
}

export function layout(commits: Commit[]): Laid[] {
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
    return { c, col, before, after, joins, outs, colors: [...colorOf] }
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

// git log --decorate=full의 %D를 읽는다: 로컬 브랜치, 원격 브랜치, 태그를 구분한다.
function cleanRefs(refs: string[]) {
  const isHead = refs.some(r => r === 'HEAD' || r.startsWith('HEAD -> '))
  const names = refs
    .map(r => r.replace(/^HEAD -> /, ''))
    .filter(r => r !== 'HEAD' && !r.endsWith('/HEAD'))
  return { isHead, names }
}

function chips(names: string[], color: string | undefined): Seg[] {
  return names.flatMap((n): Seg[] => {
    if (n.startsWith('tag: ')) return [{ t: n.replace(/^tag: (refs\/tags\/)?/, ''), color: 'yellow', bold: true }, { t: ' ' }]
    if (n.startsWith('refs/remotes/')) return [{ t: n.slice(13), color }, { t: ' ' }]
    return [{ t: ` ${n.replace(/^refs\/heads\//, '')} `, color, inverse: true, bold: true }, { t: ' ' }]
  })
}

export function age(t: number, now: number): string {
  const s = Math.max(0, now / 1000 - t)
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 604800) return `${Math.floor(s / 86400)}d`
  if (s < 2629800) return `${Math.floor(s / 604800)}w`
  if (s < 31557600) return `${Math.floor(s / 2629800)}mo`
  return `${Math.floor(s / 31557600)}y`
}

export function ageLong(t: number, now: number): string {
  const s = Math.max(0, now / 1000 - t)
  if (s < 60) return '방금'
  if (s < 3600) return `${Math.floor(s / 60)}분 전`
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`
  if (s < 604800) return `${Math.floor(s / 86400)}일 전`
  if (s < 2629800) return `${Math.floor(s / 604800)}주 전`
  if (s < 31557600) return `${Math.floor(s / 2629800)}개월 전`
  return `${Math.floor(s / 31557600)}년 전`
}

// 기본 화면(B)에 남는 커밋: HEAD, 이름이 붙은 커밋, 병합, 분기점, 첫 커밋.
const isKey = (r: Laid) => r.c.refs.length > 0 || r.c.p.length !== 1 || r.joins.length > 0

export function buildRows(commits: Commit[], open: ReadonlySet<string>, now: number): Row[] {
  const laid = layout(commits)
  const width = Math.max(1, ...laid.map(r => Math.max(r.before.length, r.after.length, r.col + 1)))
  const rows: Row[] = []
  const color = (r: Laid) => PALETTE[r.colors[r.col]!]
  // 펼친 구간과 그 안의 커밋(A 화면): 그래프와 제목을 모두 보여 준다.
  const full = (r: Laid): Row => {
    const { isHead, names } = cleanRefs(r.c.refs)
    return {
      key: `c:${r.c.h}`,
      hash: r.c.h,
      graph: cells(r, width, isHead ? '◉' : '●'),
      label: [...chips(names, color(r)), { t: r.c.s }],
      age: age(r.c.t, now),
    }
  }
  // 접힌 화면의 주요 커밋(B 화면): 이름표만, 없으면 병합 대상이나 짧은 해시.
  const brief = (r: Laid): Row => {
    const { isHead, names } = cleanRefs(r.c.refs)
    // git 기본 병합 제목과 Gitea, GitHub PR 병합 제목에서 들어온 브랜치 이름을 꺼낸다.
    const merged = /^Merge branch '([^']+)'/.exec(r.c.s)?.[1] ?? /^Merge pull request .* from (\S+)/.exec(r.c.s)?.[1]
    const label: Seg[] = chips(names, color(r))
    if (r.c.p.length > 1) label.push({ t: 'merge ', dim: true }, merged ? { t: merged, color: PALETTE[r.colors[r.outs[0]?.lane ?? r.col]!] } : { t: r.c.s, dim: true })
    else if (!names.length) label.push({ t: r.c.h.slice(0, 7), dim: true })
    return { key: `c:${r.c.h}`, hash: r.c.h, graph: cells(r, width, isHead ? '◉' : r.c.p.length === 0 ? '○' : '●'), label, age: age(r.c.t, now) }
  }
  for (let i = 0; i < laid.length; ) {
    const r = laid[i]!
    let j = i + 1
    while (j < laid.length && !isKey(laid[j]!)) j++
    const run = laid.slice(i + 1, j)
    // 브랜치 끝 뒤의 커밋이 모두 같은 레인에 있을 때만 그 브랜치의 개수로 묶는다.
    const tipOnly = r.c.refs.length > 0 && r.c.p.length === 1 && r.joins.length === 0 && run.every(x => x.col === r.col)
    if (!isKey(r)) {
      // 맨 위 커밋에 이름이 없는 경우(분리된 HEAD가 아닌데 목록이 잘린 경우 등)는 구간으로 다룬다.
      j = i
      while (j < laid.length && !isKey(laid[j]!)) j++
      pushRun(laid.slice(i, j), `r:${r.c.h}`)
    } else if (tipOnly && run.length) {
      const id = `t:${r.c.h}`
      const isOpen = open.has(id)
      const { isHead, names } = cleanRefs(r.c.refs)
      rows.push({
        key: `f:${id}`,
        fold: id,
        graph: cells(r, width, isHead ? '◉' : '◆'),
        label: [...chips(names, color(r)), { t: `${isOpen ? '▾' : '▸'} ${run.length + 1}`, underline: true }],
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

// 화면에 보이는 줄들의 그래프 폭을 그 줄들에서 가장 오른쪽 선까지로 줄인다.
export function trimGraphs(rows: Row[]): Row[] {
  const used = Math.max(0, ...rows.map(r => r.graph.reduce((n, s, i) => (s.t.trim() ? i + 1 : n), 0)))
  return rows.map(r => ({ ...r, graph: r.graph.slice(0, used) }))
}

// 터미널 칸 수. 한글과 전각 문자는 2칸이다.
const cw = (ch: string) => {
  const c = ch.codePointAt(0) ?? 0
  return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff)
    ? 2
    : 1
}
export const width = (s: string) => [...s].reduce((n, ch) => n + cw(ch), 0)

// 왼쪽 구간을 cols칸에 맞춰 자르고, 오른쪽 끝에 right를 붙인다.
export function fit(left: Seg[], right: Seg[], cols: number): Seg[] {
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
