// One recorded tool call: when, the file that changed most, lines added and removed across
// every file it changed, how many files, and whether the line counts are partial.
export type Quake = { at: number; file: string; files: number; add: number; del: number; mag: number; partial: boolean }
// Per-file totals for the session. `touched` counts changes whose line counts were not available.
export type FileHeat = { add: number; del: number; touched: number }
// Running session totals, kept separately so trimming the event history never lowers them.
export type Totals = { add: number; del: number; edits: number; quakes: number; files: number }
// One tracked file of the repo for the treemap: path relative to the repo root and its size in bytes.
export type MapFile = { path: string; bytes: number }
export type RepoMap = { root: string; files: MapFile[]; more: number; isCut: boolean; at: number }

declare module 'claude-code' {
  interface PluginState {
    'diff-seismograph': {
      events: Quake[]
      heat: Record<string, FileHeat>
      totals: Totals
      quake: Quake | null
      map: RepoMap | null
      largest: Quake | null
      band: boolean
    }
  }
}
