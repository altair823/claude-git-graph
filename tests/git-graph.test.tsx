import { expect, test } from 'claude-code/testing'

import { age, ageLong, buildRows, fit, liveMarks, parseLog, releases, statusBranch, trimGraphs, width } from '../hooks/graph'
import { promptList, scrolled, stepped, windowStart } from '../hooks/register'
import { installedId, latestTag, newer } from '../hooks/upgrade'

// 시험 환경에는 있지만 타입 정의(lib)에는 없는 전역 함수
declare const setTimeout: (fn: (value?: unknown) => void, ms: number) => unknown

const PANE = {
  plugin: 'git-graph',
  component: 'Pane',
  requestId: 'git-graph',
  props: {
    title: 'Git',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 24 },
    view: {},
  },
} as const

// 위가 최신. m은 feat를 병합했고, feat는 b에서 갈라졌다. top은 main의 맨 끝이다.
//   top(main, HEAD) - m(merge) - a - b(tag) - c
//                          \- f2(origin/feat) - f1 -/
const rec = (h: string, p: string, d: string, s: string) => `\x1e${h}\x1f${p}\x1f${d}\x1f${s}\x1f1700000000\n`
const LOG =
  rec('top', 'm', 'HEAD -> refs/heads/main', 'IRC 경로 수정') +
  rec('m', 'a f2', '', "Merge pull request 'x' (#1) from feat/e2e into main") +
  rec('f2', 'f1', 'refs/remotes/origin/feat/e2e', 'e2e 재시도') +
  rec('a', 'b', '', '문서 정리') +
  rec('f1', 'b', '', 'e2e 러너') +
  rec('b', 'c', 'tag: refs/tags/v1', '릴리스') +
  rec('c', '', '', '첫 커밋')

const text = (rows: ReturnType<typeof buildRows>) =>
  trimGraphs(rows).map(r => [...r.graph, { t: '  ' }, ...r.label].map(s => s.t).join('').trimEnd())

test('커밋은 모두 제목과 함께 보이고, 작업 중 변경은 HEAD 위에 한 줄로 보인다', () => {
  // origin/feat/e2e는 추적하는 로컬 브랜치가 없고 이미 병합됐으므로 이름을 숨긴다.
  // main은 upstream도 원격 브랜치도 없어 로컬 전용이고, 원격에 없는 커밋은 top, m, a 3개다.
  const rows = buildRows(parseLog(LOG), new Set(), 1700000000 * 1000, { track: {}, marks: new Set(), wip: 2 })
  expect(text(rows)).toEqual([
    '◌    작업 중 변경 2개',
    '◉     main 로컬 ↑3 IRC 경로 수정',
    '●─╮  merge #1 x',
    '│ ●  e2e 재시도',
    '● │  문서 정리',
    '│ ●  e2e 러너',
    '●─╯  ◇ v1 릴리스',
    '○    첫 커밋',
  ])
})

// HEAD 아래로 이름표 없는 직선 커밋 12개가 이어진다.
const LONG =
  rec('h0', 'h1', 'HEAD -> refs/heads/main, refs/remotes/origin/main', '맨 위') +
  Array.from({ length: 12 }, (_, i) => rec(`h${i + 1}`, `h${i + 2}`, '', `커밋 ${i + 1}`)).join('') +
  rec('h13', '', '', '첫 커밋')
const TRACK = { main: { up: 'origin/main', ahead: 0, behind: 0 } }

test('직선 구간이 10개 이상이면 처음 3개만 보이고 나머지는 더 보기로 접는다', () => {
  expect(text(buildRows(parseLog(LONG), new Set(), 1700000000 * 1000, { track: TRACK, marks: new Set() }))).toEqual([
    '◉   main  맨 위',
    '●  커밋 1',
    '●  커밋 2',
    '●  커밋 3',
    '┊  ▸ 커밋 9개 더 보기',
    '○  첫 커밋',
  ])
  // 펼치면 접기 줄 아래로 나머지가 나온다. b로 고른 브랜치와 x로 고른 커밋에는 ✓가 붙는다.
  const open = buildRows(parseLog(LONG), new Set(['r:h4']), 1700000000 * 1000, { track: TRACK, marks: new Set(['b:main', 'c:h2']) })
  expect(text(open).slice(0, 7)).toEqual(['◉   ✓ main  맨 위', '●  커밋 1', '●  ✓ 커밋 2', '●  커밋 3', '│  ▾ 커밋 9개 접기', '●  커밋 4', '●  커밋 5'])
  expect(open.length).toBe(15)
})

test('원격은 로컬 칩에 앞선 수로 합치고, 병합 안 된 원격 브랜치만 흐리게 남긴다', () => {
  const log =
    rec('top', 'm', 'HEAD -> refs/heads/main', 'IRC 경로 수정') +
    rec('s1', 'm', 'refs/remotes/origin/spike', '실험') +
    rec('m', 'c', 'refs/remotes/origin/main, refs/remotes/origin/HEAD', '문서 정리') +
    rec('c', '', '', '첫 커밋')
  // 같은 원격을 추적하는 다른 로컬 브랜치(old)가 있어도 main 기준으로 판단해야 한다.
  const track = { main: { up: 'origin/main', ahead: 1, behind: 0 }, old: { up: 'origin/main', ahead: 0, behind: 3 } }
  const rows = buildRows(parseLog(log), new Set(), 1700000000 * 1000, { track, marks: new Set(['c:s1']) })
  expect(text(rows)).toEqual(['◉     main ↑1 IRC 경로 수정', '│ ●  ✓ origin/spike 실험', '●─╯  origin/main 문서 정리', '○    첫 커밋'])
})

test('같은 원격을 여러 로컬 브랜치가 추적해도, 같은 커밋을 가리키는 로컬이 있으면 원격 이름을 합친다', () => {
  const log =
    rec('top', 'c', 'HEAD -> refs/heads/main, refs/remotes/origin/main', 'IRC 경로 수정') +
    rec('c', '', 'refs/heads/old', '첫 커밋')
  const track = { main: { up: 'origin/main', ahead: 0, behind: 0 }, old: { up: 'origin/main', ahead: 0, behind: 1 } }
  const rows = buildRows(parseLog(log), new Set(), 1700000000 * 1000, { track, marks: new Set() })
  expect(text(rows)).toEqual(['◉   main  IRC 경로 수정', '○   old ↓1 첫 커밋'])
})

test('push한 적 없는 로컬 브랜치는 로컬로 표시하고 어느 원격에도 없는 커밋 수를 붙인다', () => {
  const log =
    rec('w2', 'w1', 'refs/heads/wip', 'WIP 2') +
    rec('top', 'c', 'HEAD -> refs/heads/main, refs/remotes/origin/main', '맨 위') +
    rec('w1', 'c', '', 'WIP 1') +
    rec('p1', 'c', 'refs/heads/pushed, refs/remotes/origin/pushed', 'upstream 없이 push함') +
    rec('c', '', 'refs/heads/gone-one', '첫 커밋')
  const track = { main: { up: 'origin/main', ahead: 0, behind: 0 }, 'gone-one': { up: 'origin/gone-one', ahead: 0, behind: 0, gone: true as const } }
  const rows = buildRows(parseLog(log), new Set(), 1700000000 * 1000, { track, marks: new Set() })
  const label = (h: string) => rows.find(r => r.key.endsWith(`:${h}`))!.label.map(s => s.t).join('')
  expect(label('w2')).toBe(' wip 로컬 ↑2 WIP 2')
  expect(label('p1')).toBe(' pushed  upstream 없이 push함')
  expect(label('top')).toBe(' main  맨 위')
  expect(label('c')).toBe(' gone-one 원격 삭제됨 첫 커밋')
})

test('태그 계열마다 마지막 릴리스 뒤로 쌓인 커밋 수를 센다', () => {
  expect(releases(parseLog(LOG))).toEqual([{ tag: 'v1', ahead: 5 }])
})

test('입력창에는 브랜치를 먼저, 커밋은 오래된 것부터 해시와 제목으로 넣는다', () => {
  expect(promptList(['c:top', 'b:feat/x', 'c:a'], parseLog(LOG))).toBe('`feat/x` 브랜치, `a` 문서 정리, `top` IRC 경로 수정')
})

test('한글은 2칸으로 세어 자르고 오른쪽 끝에 시각을 붙인다', () => {
  const line = fit([{ t: '가나다라마바' }], [{ t: '2d' }], 10)
  expect(line.map(s => s.t).join('')).toBe('가나다… 2d')
})

test('브랜치 이름에 점이 있어도 그대로 읽고 ahead/behind를 붙인다', () => {
  expect(statusBranch('## release/1.2...origin/release/1.2 [ahead 1]')).toBe('release/1.2 ↑1')
  expect(statusBranch('## v1.0')).toBe('v1.0')
  expect(statusBranch('## main...origin/main [ahead 1, behind 2]')).toBe('main ↑1 ↓2')
  expect(statusBranch('## main...origin/main [gone]')).toBe('main')
  expect(statusBranch('## HEAD (no branch)')).toBe('HEAD (no branch)')
  expect(statusBranch('## No commits yet on main')).toBe('main')
})

test('오른쪽 글자가 길거나 남은 칸이 없어도 줄이 폭을 넘지 않는다', () => {
  const total = (segs: ReturnType<typeof fit>) => width(segs.map(s => s.t).join(''))
  expect(total(fit([{ t: '왼쪽' }], [{ t: 'x'.repeat(30) }], 20))).toBe(20)
  expect(total(fit([{ t: '왼쪽 글자' }], [{ t: 'x'.repeat(19) }], 20))).toBe(20)
  // 결합 문자는 폭이 없다(e + 결합 악센트)
  expect(width('e\u0301')).toBe(1)
})

test('고른 것 중 이력에서 사라진 커밋과 브랜치는 뺀다', () => {
  expect(liveMarks(['c:top', 'c:gone', 'b:main', 'b:origin/feat/e2e', 'b:deleted'], parseLog(LOG))).toEqual(['c:top', 'b:main', 'b:origin/feat/e2e'])
})

test('지난 시간은 가장 큰 단위로 짧게, 상세에서는 한국어로 보여 준다', () => {
  const now = 1700000000 * 1000
  expect([age(1700000000 - 30, now), age(1700000000 - 7200, now), age(1700000000 - 86400 * 9, now)]).toEqual(['0m', '2h', '1w'])
  expect([ageLong(1700000000 - 30, now), ageLong(1700000000 - 300, now), ageLong(1700000000 - 86400 * 400, now)]).toEqual(['방금', '5분 전', '1년 전'])
})

test('설치 캐시 경로와 원격 태그로 새 버전이 있는지 판단한다', () => {
  expect(installedId('/home/me/.claude/plugins/cache/altair-skills/git-graph/0.1.1')).toBe('git-graph@altair-skills')
  // 저장소 작업 사본을 연결한 개발용 실행은 확인하지 않는다.
  expect(installedId('/home/me/projects/claude-git-graph')).toBeUndefined()
  expect([newer('0.1.10', '0.1.9'), newer('0.2.0', '0.1.9'), newer('0.1.1', '0.1.1'), newer('0.1.0', '0.1.1')]).toEqual([true, true, false, false])
  const out = 'aaa\trefs/tags/v0.1.0\nbbb\trefs/tags/v0.1.10\nccc\trefs/tags/v0.1.9\nddd\trefs/tags/app-v9.0.0\n'
  expect(latestTag(out)).toBe('0.1.10')
  expect(latestTag('')).toBeUndefined()
})

test('커서가 창 안에서 움직이면 창은 그대로고, 끝에서 더 나가면 한 줄씩 옮긴다', () => {
  const row = (k: string) => ({ key: `c:${k}`, hash: k, graph: [], label: [], age: '' })
  const rows = Array.from({ length: 30 }, (_, i) => row(String(i)))
  // 커서 c:9가 창의 9번째 자리면 창은 0부터
  expect(windowStart(rows, { cur: 'c:9', off: 9, start: 0 }, 10)).toBe(0)
  // 새 커밋 2개가 위에 생겨도 커서는 같은 자리, 같은 커밋에 남는다
  expect(windowStart([row('n1'), row('n2'), ...rows], { cur: 'c:9', off: 9, start: 0 }, 10)).toBe(2)
  // 아래 끝에서 한 줄 더 내리면 c:10이 마지막 자리에 오도록 창을 1줄 옮긴다
  expect(stepped(rows, { cur: 'c:9', off: 9, start: 0 }, 10, 1)).toEqual({ cur: 'c:10', off: 9, start: 1 })
  // 위 끝에서 한 줄 더 올리면 반대로
  expect(stepped(rows, { cur: 'c:5', off: 0, start: 5 }, 10, -1)).toEqual({ cur: 'c:4', off: 0, start: 4 })
  // 더 갈 줄이 없으면 그대로
  expect(stepped(rows, { cur: 'c:29', off: 9, start: 20 }, 10, 1)).toBeUndefined()
  // 연결선처럼 누를 수 없는 줄은 건너뛴다
  const gaps = rows.map((r, i) => (i % 2 ? { key: `x:${i}`, graph: [], label: [], age: '' } : r))
  expect(stepped(gaps, { cur: 'c:8', off: 8, start: 0 }, 10, 1)).toEqual({ cur: 'c:10', off: 9, start: 1 })
  // 한 화면 넘기기는 창을 옮기고 커서를 화면의 같은 자리에 둔다
  expect(scrolled(rows, { cur: 'c:3', off: 3, start: 0 }, 10, 9)).toEqual({ cur: 'c:12', off: 3, start: 9 })
})

test('패널에 브랜치와 그래프를 그리고, 작업 중 변경 줄에서는 바뀐 파일을 보여 준다', async ($, on) => {
  on('command.register', () => ({ value: { command: 'git-graph' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.focus', () => ({}))
  on('ui.panes', () => ({ value: [] }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1700000000 * 1000 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.includes('status')
        ? '## main...origin/main [ahead 1]\n M a.ts\n?? b.ts\n'
        : e.argv.includes('rev-parse')
          ? '/home/me/kkachi\n'
          : LOG,
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /변경/ }))?.text).toMatch(/^main ↑1  변경 2개 +kkachi$/)
    expect((await ui.find({ key: 'c:a' }))?.text).toContain('● │  문서 정리')
    expect((await ui.find({ key: 'w:wip' }))?.text).toContain('◌    작업 중 변경 2개')
    await ui.unmount()
  }
  await $.ui.focus({ component: 'Pane', requestId: 'git-graph', element: 'w:wip', origin: { kind: 'person' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /a\.ts/ }))?.text.trim()).toBe('M a.ts')
  expect((await ui.find({ type: 'Text', text: /b\.ts/ }))?.text.trim()).toBe('?? b.ts')
  await ui.unmount()
})

test('더 보기 줄을 누르면 접힌 커밋을 펼치고 다시 누르면 접는다', async ($, on) => {
  on('command.register', () => ({ value: { command: 'git-graph' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.focus', () => ({}))
  on('clock.every', () => ({ deny: '시험에서는 타이머를 쓰지 않는다' }))
  on('clock.now', () => ({ value: 1700000000 * 1000 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => ({
    value: { exitCode: 0, stdout: e.argv.includes('log') ? LONG : '## main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'c:h4' })).toBeUndefined()
  await ui.press({ key: 'f:r:h4' })
  expect(await ui.find({ key: 'c:h4' })).toBeDefined()
  await ui.press({ key: 'f:r:h4' })
  expect(await ui.find({ key: 'c:h4' })).toBeUndefined()
  await ui.unmount()
})

test('git 저장소가 아니면 안내만 그린다', async ($, on) => {
  on('command.register', () => ({ value: { command: 'git-graph' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1700000000 * 1000 }))
  on('process.run', () => ({
    value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false },
  }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('git 저장소가 아닙니다')
  await ui.unmount()
})

test('쓰기 도구가 끝나면 바로 다시 읽고, 브랜치와 태그가 그대로면 git log는 건너뛴다', async ($, on) => {
  const runs = { status: 0, log: 0 }
  let refs = 'aaa refs/heads/main\n'
  on('command.register', () => ({ value: { command: 'git-graph' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'git-graph', title: 'Git', isShown: true, isFocused: false, isPlaced: true }] }))
  // 즉시 응답하면 타이머가 쉬지 않고 돌므로 시험에서는 거절해 멈춘다.
  on('clock.every', () => ({ deny: '시험에서는 타이머를 쓰지 않는다' }))
  on('clock.now', () => ({ value: 1700000000 * 1000 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    const cmd = e.argv[1] === '--no-optional-locks' ? 'status' : e.argv[1]
    if (cmd === 'status') runs.status++
    if (cmd === 'log') runs.log++
    const stdout = cmd === 'status' ? '## main\n' : cmd === 'for-each-ref' ? refs : cmd === 'rev-parse' ? '/r/kkachi\nbbb\n' : LOG
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', (_, e) => (e.tool === 'Read' ? { result: {}, isReadOnly: true } : { result: {} }))
  const settle = () => new Promise(r => setTimeout(r, 20))
  const edit = () => $.tool.call({ tool: 'Edit', file_path: '/a', old_string: 'x', new_string: 'y' })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(runs).toEqual({ status: 1, log: 1 })
  await $.tool.call({ tool: 'Read', file_path: '/a' })
  await settle()
  expect(runs).toEqual({ status: 1, log: 1 })
  await edit()
  await settle()
  expect(runs).toEqual({ status: 2, log: 1 })
  refs = 'ccc refs/heads/main\n'
  await edit()
  await settle()
  expect(runs).toEqual({ status: 3, log: 2 })
})

test('맨 아래 안내는 포커스 상태를 따르고, /git-graph는 패널로 포커스를 요청한다', async ($, on) => {
  const opened: unknown[] = []
  on('command.register', () => ({ value: { command: 'git-graph' } }))
  on('ui.open', (_, e) => (opened.push(e), { value: { isPlaced: true } }))
  on('clock.every', () => ({ deny: '시험에서는 타이머를 쓰지 않는다' }))
  on('clock.now', () => ({ value: 1700000000 * 1000 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => ({
    value: { exitCode: 0, stdout: e.argv.includes('log') ? LOG : '## main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('command.run', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'git-graph', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  expect(opened.at(-1)).toMatchObject({ id: 'git-graph', focus: true })

  const away = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await away.find({ type: 'Text', text: /또는 클릭으로 들어오기/ })).toBeDefined()
  await away.unmount()
  const inside = await $.ui.mount({ ...PANE, props: { ...PANE.props, isFocused: true }, surface: 'terminal' })
  expect(await inside.find({ type: 'Text', text: /Esc 입력창으로/ })).toBeDefined()
  await inside.unmount()
})

test('방향키로 창 끝에서 더 나가면 그래프가 한 줄씩 스크롤되고, 단축키 버튼으로는 넘어가지 않는다', async ($, on) => {
  // 태그가 붙은 커밋 40개: 접히지 않고 모두 한 줄씩 보인다.
  const many = Array.from({ length: 40 }, (_, i) => rec(`h${i}`, i < 39 ? `h${i + 1}` : '', `tag: refs/tags/t${i}${i ? '' : ', HEAD -> refs/heads/main'}`, `커밋 ${i}`)).join('')
  on('command.register', () => ({ value: { command: 'git-graph' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.focus', () => ({}))
  on('clock.every', () => ({ deny: '시험에서는 타이머를 쓰지 않는다' }))
  on('clock.after', () => ({ deny: '시험에서는 타이머를 쓰지 않는다' }))
  on('clock.now', () => ({ value: 1700000000 * 1000 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => ({
    value: { exitCode: 0, stdout: e.argv.includes('log') ? many : '## main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  const move = (element: string) => $.ui.focus({ component: 'Pane', requestId: 'git-graph', element, origin: { kind: 'person' } })
  const drawn = async (keys: string[]) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const out = await Promise.all(keys.map(async k => !!(await ui.find({ key: k }))))
    await ui.unmount()
    return out
  }

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // 그래프 영역은 10줄(24 - 위 2 - 경계 줄 2 - 단축키 3과 안내 1 - 상세 6)이라 h0~h9가 보인다.
  expect(await drawn(['c:h0', 'c:h9', 'c:h10'])).toEqual([true, true, false])
  // 창 안에서 움직이면 창은 그대로다.
  await move('c:h9')
  expect(await drawn(['c:h0', 'c:h9'])).toEqual([true, true])
  // 단축키 버튼으로 가려는 이동은 막는다.
  expect(await move('act:x')).toEqual({})
  // 아래 끝에서 더 내리면(경계 줄로 가려 하면) 한 줄 스크롤된다.
  expect(await move('edge:bottom')).toEqual({})
  expect(await drawn(['c:h0', 'c:h1', 'c:h10'])).toEqual([false, true, true])
  // 위 끝에서 더 올리면 반대로 스크롤된다.
  await move('c:h1')
  await move('edge:top')
  expect(await drawn(['c:h0', 'c:h10'])).toEqual([true, false])
})

test('커서가 커밋 줄에 가면 아래에 그 커밋의 상세가 나오고, 한 번 읽은 커밋은 다시 읽지 않는다', async ($, on) => {
  let shows = 0
  on('command.register', () => ({ value: { command: 'git-graph' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.focus', () => ({}))
  on('clock.every', () => ({ deny: '시험에서는 타이머를 쓰지 않는다' }))
  on('clock.after', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1700003600 * 1000 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    if (e.argv.includes('show')) shows++
    const stdout = e.argv.includes('show')
      ? `나\x1f1700000000\x1f${e.argv.at(-1) === 'top' ? 'IRC 경로 수정' : '첫 커밋'}\n\n3\t1\thooks/graph.ts\n10\t0\tREADME.md\n-\t-\tlogo.png\n`
      : e.argv.includes('log') ? LOG : '## main\n'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const move = (element: string) => $.ui.focus({ component: 'Pane', requestId: 'git-graph', element, origin: { kind: 'person' } })
  const settle = () => new Promise(r => setTimeout(r, 20))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await move('c:top')
  await settle()
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /IRC 경로 수정/ }))?.text.trim()).toBe('IRC 경로 수정')
  expect((await ui.find({ type: 'Text', text: /1시간 전/ }))?.text).toContain('나  1시간 전')
  // 바뀐 파일은 많이 바뀐 것부터, 바이너리 파일은 0으로 센다.
  expect((await ui.find({ type: 'Text', text: /파일 3개/ }))?.text.trim()).toBe('파일 3개  +13  -1')
  expect((await ui.find({ type: 'Text', text: /README/ }))?.text.trim()).toBe('+10 -0  README.md')
  expect((await ui.find({ type: 'Text', text: /graph\.ts/ }))?.text.trim()).toBe('+3 -1  hooks/graph.ts')
  await ui.unmount()

  await move('c:c')
  await settle()
  await move('c:top')
  await settle()
  expect(shows).toBe(2)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /IRC 경로 수정/ })).toBeDefined()
  await ui.unmount()
})

test('상세를 읽지 못하면 그렇게 알리고, 다시 가면 다시 읽는다', async ($, on) => {
  let fail = true
  on('command.register', () => ({ value: { command: 'git-graph' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.focus', () => ({}))
  on('clock.every', () => ({ deny: '시험에서는 타이머를 쓰지 않는다' }))
  on('clock.after', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1700003600 * 1000 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    const show = e.argv.includes('show')
    const stdout = show ? '나\x1f1700000000\x1fIRC 경로 수정\n\n 1 file changed, 2 insertions(+)\n' : e.argv.includes('log') ? LOG : '## main\n'
    return { value: { exitCode: show && fail ? 128 : 0, stdout: show && fail ? '' : stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const move = (element: string) => $.ui.focus({ component: 'Pane', requestId: 'git-graph', element, origin: { kind: 'person' } })
  const settle = () => new Promise(r => setTimeout(r, 20))
  const footer = async (text: RegExp) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const found = await ui.find({ type: 'Text', text })
    await ui.unmount()
    return !!found
  }

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await move('c:top')
  await settle()
  expect(await footer(/상세를 읽지 못했습니다/)).toBe(true)
  fail = false
  await move('c:c')
  await move('c:top')
  await settle()
  expect(await footer(/IRC 경로 수정/)).toBe(true)
})

test('b로 커서 줄의 브랜치를 고르고 6을 누르면 브랜치 삭제 문장을 입력창에 넣는다', async ($, on) => {
  const filled: string[] = []
  on('command.register', () => ({ value: { command: 'git-graph' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.focus', () => ({}))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.fill', (_, e) => (filled.push(e.text), { isFilled: true }))
  on('clock.every', () => ({ deny: '시험에서는 타이머를 쓰지 않는다' }))
  on('clock.after', () => ({ deny: '시험에서는 타이머를 쓰지 않는다' }))
  on('clock.now', () => ({ value: 1700000000 * 1000 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => ({
    value: { exitCode: 0, stdout: e.argv.includes('log') ? LOG : '## main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.ui.focus({ component: 'Pane', requestId: 'git-graph', element: 'c:top', origin: { kind: 'person' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'act:b' })
  expect((await ui.find({ key: 'c:top' }))?.text).toContain('✓ main')
  await ui.press({ key: 'act:6' })
  expect(filled).toEqual(['다음 브랜치를 지워 줘: `main` 브랜치 '])
  // 넣은 뒤에는 고르기가 풀린다.
  expect((await ui.find({ key: 'c:top' }))?.text).not.toContain('✓')
  await ui.unmount()
})
