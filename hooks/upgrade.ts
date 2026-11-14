// 새 버전 알림과 자동 업데이트. 설치 캐시에서 실행될 때만 동작한다(저장소 작업 사본을 연결한 개발용 실행은 건너뛴다).
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Upgrade } from '../types'

// 릴리스 태그를 조회할 저장소. 설치한 컴퓨터는 이미 이 저장소의 git 인증을 갖고 있으므로 비공개여도 조회된다.
const UPSTREAM = 'https://gitea.altair823.xyz/altair823-org/claude-git-graph.git'
// 인증이 없을 때 입력을 기다리며 멈추지 않게 한다.
const QUIET = { GIT_TERMINAL_PROMPT: '0' }

const upgrade = atom({ plugin: 'git-graph', key: 'upgrade' } as const, { latest: '', ready: false } as Upgrade, { shape: 'upgrade-1' })

// 설치 캐시 경로(.../plugins/cache/<마켓플레이스>/<플러그인>/<버전>)에서 `플러그인@마켓플레이스`를 꺼낸다.
export function installedId(root: string): string | undefined {
  const m = /\/plugins\/cache\/([^/]+)\/([^/]+)\/[^/]+\/?$/.exec(root)
  return m ? `${m[2]}@${m[1]}` : undefined
}

const parts = (v: string) => v.split('.').map(Number)
export function newer(a: string, b: string): boolean {
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  }
  return false
}

// git ls-remote --tags --refs 출력에서 가장 높은 vX.Y.Z 태그의 버전.
export function latestTag(out: string): string | undefined {
  const versions = [...out.matchAll(/refs\/tags\/v(\d+\.\d+\.\d+)$/gm)].map(m => m[1]!)
  return versions.reduce<string | undefined>((best, v) => (!best || newer(v, best) ? v : best), undefined)
}

// 이 모듈이 실행 중인 버전. 세션을 시작할 때 읽는다.
export let running = ''

export async function readVersion($: EngineInterface): Promise<string> {
  running = await $.fs
    .read(`${$.plugin.root}/.claude-plugin/plugin.json`)
    .then(text => String(JSON.parse(text).version ?? ''), () => '')
  return running
}

// 패널 둘째 줄의 u 버튼 문구. 새 버전이 없으면 빈 문자열이다. 그리는 중에 읽으므로 상태가 바뀌면 다시 그린다.
export async function upgradeLabel($: EngineInterface): Promise<string> {
  const known = await read($, upgrade)
  return known.latest && running && newer(known.latest, running) ? `${known.latest} ${known.ready ? '적용' : '업데이트'}` : ''
}

// 엔진은 다른 파일로 $를 넘기는 곳을 함수 선언으로만 따라간다. 화살표 함수로 쓰면 모듈이 올라오지 않는다.
async function runUpdate($: EngineInterface, id: string): Promise<boolean> {
  return $.process
    .run(['claude', 'plugin', 'update', id], { env: QUIET, timeoutMs: 120_000 })
    .then(r => r.exitCode === 0, () => false)
}

// 최신 태그를 확인하고, 새 버전이면 바로 받아 둔다. 받은 버전은 다음 세션부터 쓰이고, 지금 세션은 u로 적용한다.
// Gitea가 응답하지 않거나 인증이 없으면 조용히 넘긴다. 다음 확인 때 다시 시도한다.
export async function checkUpgrade($: EngineInterface) {
  const id = installedId($.plugin.root)
  if (!id) return
  const current = running || (await readVersion($))
  const out = await $.process.run(['git', 'ls-remote', '--tags', '--refs', UPSTREAM, 'v*'], { env: QUIET, timeoutMs: 20_000 }).catch(() => undefined)
  const latest = out?.exitCode === 0 ? latestTag(out.stdout) : undefined
  if (!latest || !current || !newer(latest, current)) return
  const known = await read($, upgrade)
  if (known.latest === latest && known.ready) return
  const ready = await runUpdate($, id)
  await update($, upgrade, () => ({ latest, ready }))
  if (known.latest !== latest) {
    $.ui.toast(
      ready
        ? `git-graph ${latest}을 받았습니다. 패널에서 u를 누르면 지금 적용하고, 다음 세션부터는 자동으로 씁니다`
        : `git-graph ${latest}이 나왔습니다. 패널에서 u를 누르면 업데이트합니다`,
    )
  }
}

// u: 아직 받지 못했으면 받고, /reload-plugins로 지금 세션에 적용한다.
export async function applyUpgrade($: EngineInterface) {
  const id = installedId($.plugin.root)
  const known = await read($, upgrade)
  if (!id || !known.latest) return
  if (!known.ready && !(await runUpdate($, id))) {
    return $.ui.toast(`업데이트하지 못했습니다. 터미널에서 claude plugin update ${id}를 실행해 주세요`)
  }
  await $.command.run({ command: 'reload-plugins' })
}
