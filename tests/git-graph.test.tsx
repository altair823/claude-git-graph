import { expect, test } from 'claude-code/testing'

import { buildRows, fit, parseLog, trimGraphs } from '../hooks/graph'
import { keepInView } from '../hooks/register'

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
  const rows = buildRows(parseLog(LOG), new Set(), 1700000000 * 1000)
  expect(text(rows)).toEqual([
    '◉     main',
    '●─╮  merge feat/e2e',
    '│ ●  origin/feat/e2e',
    '┊ ┊  ▸ 커밋 2개',
    '●─╯  v1',
    '○    c',
  ])
})

test('구간을 펼치면 그 안의 커밋을 레인 그래프와 제목으로 보여 준다', () => {
  const rows = buildRows(parseLog(LOG), new Set(['r:a']), 1700000000 * 1000)
  expect(text(rows).slice(3, 6)).toEqual(['│ │  ▾ 커밋 2개', '● │  문서 정리', '│ ●  e2e 러너'])
})

test('한글은 2칸으로 세어 자르고 오른쪽 끝에 시각을 붙인다', () => {
  const line = fit([{ t: '가나다라마바' }], [{ t: '2d' }], 10)
  expect(line.map(s => s.t).join('')).toBe('가나다… 2d')
})

test('커서 아래위로 누를 수 있는 줄이 하나씩 보이도록 창을 옮긴다', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ key: `c:${i}`, hash: String(i), graph: [], label: [], age: '' }))
  expect(keepInView(rows, 9, 0, 10)).toBe(1)
  expect(keepInView(rows, 3, 5, 10)).toBe(2)
  expect(keepInView(rows, 29, 0, 10)).toBe(20)
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
    await ui.press({ key: 'f:r:a' })
    expect((await ui.find({ key: 'c:a' }))?.text).toContain('● │  문서 정리')
    await ui.press({ key: 'f:r:a' })
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
