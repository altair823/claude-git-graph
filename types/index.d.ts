export type Commit = { h: string; p: string[]; refs: string[]; s: string; t: number }

// 로컬 브랜치 하나의 upstream과 앞선 수, 뒤처진 수. gone은 upstream이 원격에서 지워진 경우다.
export type Track = { up: string; ahead: number; behind: number; gone?: true }

export type Repo = {
  branch: string
  changes: number
  name: string
  commits: Commit[]
  more: boolean
  // 로컬 브랜치 이름별 동기화 상태
  track: Record<string, Track>
  // 마지막 fetch 시각(ms). 기록이 없으면 0
  fetched: number
  error?: string
}

// open: 펼친 구간 id, cur: 커서가 있는 줄의 key(커밋 줄이면 그 커밋의 상세를 보여 준다),
// start: 그래프 영역의 첫 줄, marks: x로 고른 것(c:<해시> 또는 b:<브랜치>)
export type View = { open: string[]; cur: string; start: number; marks: string[] }

export type Detail = { h: string; author: string; t: number; s: string; files: number; add: number; del: number }

declare module 'claude-code' {
  interface PluginState {
    'git-graph': { repo: Shaped<Repo>; view: Shaped<View>; detail: Shaped<Detail> }
  }
}
