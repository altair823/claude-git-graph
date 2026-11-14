export type Commit = { h: string; p: string[]; refs: string[]; s: string; t: number }

export type Repo = {
  branch: string
  changes: number
  name: string
  commits: Commit[]
  more: boolean
  error?: string
}

// open: 펼친 구간 id, sel: 고른 커밋, cur: 커서가 있는 줄의 key, start: 그래프 영역의 첫 줄
export type View = { open: string[]; sel: string; cur: string; start: number }

export type Detail = { h: string; author: string; t: number; s: string; files: number; add: number; del: number }

declare module 'claude-code' {
  interface PluginState {
    'git-graph': { repo: Shaped<Repo>; view: Shaped<View>; detail: Shaped<Detail> }
  }
}
