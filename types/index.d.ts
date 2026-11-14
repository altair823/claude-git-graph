export type Run = { text: string; color?: string; bold?: true; dim?: true }
export type Graph = { header: string; lines: Run[][]; error?: string }

declare module 'claude-code' {
  interface PluginState {
    'git-graph': { graph: Shaped<Graph> }
  }
}
