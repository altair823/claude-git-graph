import { expect, test } from 'claude-code/testing'

import { parseAnsi } from '../hooks/register'

const PANE = {
  plugin: 'git-graph',
  component: 'Pane',
  requestId: 'git-graph',
  props: {
    title: 'Git',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const LOG =
  '* \x1b[33ma1b2c3d\x1b[m\x1b[33m (\x1b[1;36mHEAD -> \x1b[m\x1b[1;32mmain\x1b[m\x1b[33m)\x1b[m first \x1b[2m2 hours ago\x1b[m\n' +
  '\x1b[31m|\x1b[m\x1b[32m\\\x1b[m\n'

test('git 색 코드를 색 구간으로 나눈다', () => {
  expect(parseAnsi('\x1b[1;31m|\x1b[m plain')).toEqual([
    { text: '|', bold: true, color: 'red' },
    { text: ' plain' },
  ])
  expect(parseAnsi('\x1b[2mdim\x1b[22m\x1b[94mx')).toEqual([
    { text: 'dim', dim: true },
    { text: 'x', color: 'blueBright' },
  ])
})

test('패널에 브랜치, 변경 개수, 그래프 줄을 그린다', async ($, on) => {
  on('command.register', () => ({ value: { command: 'git-graph' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => ({
    value: e.argv.includes('status')
      ? { exitCode: 0, stdout: '## main...origin/main [ahead 1]\n M a.ts\n?? b.ts\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      : { exitCode: 0, stdout: LOG, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /변경/ }))?.text).toBe(
      'main...origin/main [ahead 1]  변경 2개',
    )
    expect((await ui.find({ type: 'Text', text: /a1b2c3d/ }))?.text).toBe(
      '* a1b2c3d (HEAD -> main) first 2 hours ago',
    )
    await ui.unmount()
  }
})

test('git 저장소가 아니면 안내만 그린다', async ($, on) => {
  on('command.register', () => ({ value: { command: 'git-graph' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('git 저장소가 아닙니다')
  await ui.unmount()
})
