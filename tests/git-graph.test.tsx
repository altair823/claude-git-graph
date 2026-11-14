import { expect, test } from 'claude-code/testing'

import { buildRows, fit, parseLog, releases, trimGraphs } from '../hooks/graph'
import { keepInView, promptList } from '../hooks/register'

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

test('기본 화면은 이름이 붙은 커밋, 병합, 분기점만 남기고 나머지를 접는다', () => {
  // origin/feat/e2e는 추적하는 로컬 브랜치가 없고 이미 병합됐으므로 숨겨져 접힌 구간에 들어간다.
  // main은 upstream도 원격 브랜치도 없어 로컬 전용이고, 원격에 없는 커밋은 top, m, a 3개다.
  const rows = buildRows(parseLog(LOG), new Set(), 1700000000 * 1000)
  expect(text(rows)).toEqual([
    '◉     main 로컬 ↑3',
    '●─╮  merge feat/e2e',
    '┊ ┊  ▸ 커밋 3개',
    '●─╯  ◇ v1',
    '○    c',
  ])
})

test('구간을 펼치면 그 안의 커밋을 레인 그래프와 제목으로 보여 준다', () => {
  const rows = buildRows(parseLog(LOG), new Set(['r:f2']), 1700000000 * 1000)
  expect(text(rows).slice(2, 6)).toEqual(['│ │  ▾ 커밋 3개', '│ ●  e2e 재시도', '● │  문서 정리', '│ ●  e2e 러너'])
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
  expect(text(rows)).toEqual(['◉     main ↑1', '│ ●  ✓ origin/spike', '●─╯  origin/main', '○    c'])
})

test('같은 원격을 여러 로컬 브랜치가 추적해도, 같은 커밋을 가리키는 로컬이 있으면 원격 이름을 합친다', () => {
  const log =
    rec('top', 'c', 'HEAD -> refs/heads/main, refs/remotes/origin/main', 'IRC 경로 수정') +
    rec('c', '', 'refs/heads/old', '첫 커밋')
  const track = { main: { up: 'origin/main', ahead: 0, behind: 0 }, old: { up: 'origin/main', ahead: 0, behind: 1 } }
  const rows = buildRows(parseLog(log), new Set(), 1700000000 * 1000, { track, marks: new Set() })
  expect(text(rows)).toEqual(['◉   main', '○   old ↓1'])
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
  expect(label('w2')).toContain(' wip 로컬 ↑2')
  expect(label('p1')).toBe(' pushed  ')
  expect(label('top')).toBe(' main  ')
  expect(label('c')).toBe(' gone-one 원격 삭제됨 ')
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

test('커서 아래위로 누를 수 있는 줄이 여유 있게 보이도록 창을 옮긴다', () => {
  // 높이 10이면 위아래로 2줄씩 여유를 둔다. 연결선처럼 누를 수 없는 줄은 여유로 세지 않는다.
  const rows = Array.from({ length: 30 }, (_, i) => ({ key: `c:${i}`, hash: String(i), graph: [], label: [], age: '' }))
  expect(keepInView(rows, 9, 0, 10)).toBe(2)
  expect(keepInView(rows, 3, 5, 10)).toBe(1)
  expect(keepInView(rows, 29, 0, 10)).toBe(20)
  const gaps = rows.map((r, i) => (i % 2 ? { key: `x:${i}`, graph: [], label: [], age: '' } : r))
  expect(keepInView(gaps, 8, 0, 10)).toBe(3)
})

test('패널에 브랜치와 그래프를 그리고, 접힌 구간을 누르면 펼친다', async ($, on) => {
  on('command.register', () => ({ value: { command: 'git-graph' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
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
    expect(await ui.find({ type: 'Text', text: /문서 정리/ })).toBeUndefined()
    await ui.press({ key: 'f:r:f2' })
    expect((await ui.find({ key: 'c:a' }))?.text).toContain('● │  문서 정리')
    await ui.press({ key: 'f:r:f2' })
    await ui.unmount()
  }
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

test('커서가 창 아래쪽으로 가면 그래프가 따라 스크롤된다', async ($, on) => {
  // 태그가 붙은 커밋 40개: 접히지 않고 모두 한 줄씩 보인다.
  const many = Array.from({ length: 40 }, (_, i) => rec(`h${i}`, i < 39 ? `h${i + 1}` : '', `tag: refs/tags/t${i}${i ? '' : ', HEAD -> refs/heads/main'}`, `커밋 ${i}`)).join('')
  on('command.register', () => ({ value: { command: 'git-graph' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.focus', () => ({}))
  on('clock.every', () => ({ deny: '시험에서는 타이머를 쓰지 않는다' }))
  on('clock.now', () => ({ value: 1700000000 * 1000 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => ({
    value: { exitCode: 0, stdout: e.argv.includes('log') ? many : '## main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'c:h0' })).toBeDefined()
  expect(await ui.find({ key: 'c:h20' })).toBeUndefined()
  await ui.unmount()

  const move = (element: string) => $.ui.focus({ component: 'Pane', requestId: 'git-graph', element, origin: { kind: 'person' } })
  await move('c:h20')
  // 방향키로 단축키 버튼에 가려는 이동은 막고, 커서는 그대로 둔다.
  expect(await move('act:x')).toEqual({})
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // 그래프 영역은 15줄(24 - 위 2 - 아래 3 - 상세 4), 여유는 3줄이라 9~23번째 줄이 보인다.
  expect(await ui.find({ key: 'c:h20' })).toBeDefined()
  expect(await ui.find({ key: 'c:h23' })).toBeDefined()
  expect(await ui.find({ key: 'c:h24' })).toBeUndefined()
  expect(await ui.find({ key: 'c:h8' })).toBeUndefined()
  await ui.unmount()
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
      ? `나\x1f1700000000\x1f${e.argv.at(-1) === 'top' ? 'IRC 경로 수정' : '첫 커밋'}\n\n 3 files changed, 42 insertions(+), 7 deletions(-)\n`
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
