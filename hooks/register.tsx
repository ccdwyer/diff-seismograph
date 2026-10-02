import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FileHeat, MapFile, Quake, RepoMap, Totals as SessionTotals } from '../types'
import {
  QUAKE_AT,
  Trace,
  bandCells,
  baseName,
  countHunks,
  countTexts,
  lineCount,
  magnitude,
  sessionCells,
  sparkline,
  treemapCells,
} from './seismo'
import type { MapEntry, Totals } from './seismo'

const events = atom({ plugin: 'diff-seismograph', key: 'events' } as const, [])
const heat = atom({ plugin: 'diff-seismograph', key: 'heat' } as const, {})
const totals = atom({ plugin: 'diff-seismograph', key: 'totals' } as const, { add: 0, del: 0, edits: 0, quakes: 0, files: 0 })
const quake = atom({ plugin: 'diff-seismograph', key: 'quake' } as const, null)
const map = atom({ plugin: 'diff-seismograph', key: 'map' } as const, null)
const largest = atom({ plugin: 'diff-seismograph', key: 'largest' } as const, null)
const band = atom({ plugin: 'diff-seismograph', key: 'band' } as const, true)

const PANE = 'diff-seismograph'
const BAND_KEY = 'seis'
const PANE_GRAPH = 'session'
const PANE_MAP = 'treemap'
const MAX_EVENTS = 2000
const MAX_FILES = 600
// Heat keeps the hottest files; past this the coldest are dropped (the totals keep the count).
const MAX_HEAT = 2000
// The engine expands at most this many files of a shell diff; one it lists but did not expand was too large.
const EXPANDED_FILES = 5
const FRAME_MS = 80
// How many shown frames the quake banner flashes for (about 5 seconds at 80 ms).
const FLASH_FRAMES = 62
const HUM_MS = 90_000

// Animation lives in the module: it is cosmetic, and a reload simply starts a fresh trace.
// `site` is set only while this plugin's band Raster is mounted and cleared whenever a
// render does not draw it, so the clock never paints into a site that is gone.
const trace = new Trace(256)
let site: { requestId: string; columns: number; rows: number } | null = null
let alert: { mag: number; file: string; framesLeft: number } | null = null
let frame = 0

/** `big`: the engine left the line counts out because the change was too large to diff. */
type Change = { file: string; add: number; del: number; known: boolean; big?: boolean }
/** A tool call's changes, and whether the engine said it left some out. */
type Changes = { list: Change[]; partial: boolean }
// Real paths already resolved this session, so a big shell diff does not stat every file every time.
const realPaths = new Map<string, string>()
// Shell diffs the engine attached to more than one parallel call: counted once.
const sharedSeen = new Set<string>()
type Record_ = Record<string, unknown>

function asRecord(value: unknown): Record_ | null {
  return value !== null && typeof value === 'object' ? (value as Record_) : null
}

/** Lines changed by a Write, from the best record the tool gave. */
function writeChange(file: string, r: Record_): Change {
  const patch = r.structuredPatch as { lines: string[] }[] | undefined
  if (patch !== undefined && patch.length > 0) return { file, ...countHunks(patch), known: true }
  const git = asRecord(r.gitDiff)
  if (git !== null && typeof git.additions === 'number' && typeof git.deletions === 'number') {
    return { file, add: git.additions, del: git.deletions, known: true }
  }
  const content = String(r.content ?? '')
  if (r.type === 'create') return { file, add: lineCount(content), del: 0, known: true }
  if (typeof r.originalFile === 'string') {
    // An empty patch with the old body present: either nothing changed or the diff timed out.
    if (r.originalFile === content) return { file, add: 0, del: 0, known: true }
    return measured(file, r.originalFile, content)
  }
  // The old body (over 10 MB) was left out: a big rewrite whose line counts are unknown. Never invent them.
  return { file, add: 0, del: 0, known: false, big: true }
}

/** A diff of two texts; a reorder too large to diff exactly is a change of unknown size, never "no change". */
function measured(file: string, before: string, after: string): Change {
  const c = countTexts(before, after)
  if (c.approx === true && c.add + c.del === 0) return { file, add: 0, del: 0, known: false }
  return { file, add: c.add, del: c.del, known: c.approx !== true }
}

/** What a finished tool call changed on disk, per file, from the tool's own record. */
function changesOf(e: { tool: string; [k: string]: unknown }, result: unknown): Changes {
  const none: Changes = { list: [], partial: false }
  const r = asRecord(result)
  if (r === null || r.staged === true) return none
  switch (e.tool) {
    case 'Edit':
      return { list: [{ file: String(r.filePath ?? e.file_path ?? ''), ...countHunks(r.structuredPatch as { lines: string[] }[] | undefined), known: true }], partial: false }
    case 'Write': {
      const c = writeChange(String(r.filePath ?? e.file_path ?? ''), r)
      return { list: [c], partial: !c.known }
    }
    case 'NotebookEdit': {
      const c = measured(String(r.notebook_path ?? e.notebook_path ?? ''), String(r.old_source ?? ''), String(r.new_source ?? ''))
      return { list: [c], partial: !c.known }
    }
    case 'Bash': {
      const diff = asRecord(r.bashEditDiff)
      if (diff === null) return none
      const files = (diff.files as { filePath: string; hunks: { lines: string[] }[] }[] | undefined) ?? []
      const out: Change[] = files.map(f => ({ file: f.filePath, ...countHunks(f.hunks), known: true }))
      const shown = new Set(out.map(c => c.file))
      const more = Number(diff.moreFiles ?? 0)
      const partial = diff.skipped === true || diff.unavailable === true || more > 0
      // A listed file the engine did not expand, while it had room to: its hunks were too large. A big change.
      const hadRoom = files.length < EXPANDED_FILES
      for (const path of (diff.changedFiles as string[] | undefined) ?? []) {
        if (!shown.has(path)) out.push({ file: path, add: 0, del: 0, known: false, big: hadRoom })
      }
      // Files past the listed ones still count toward the file total.
      if (more > 0) out.push({ file: `(+${more} more files)`, add: 0, del: 0, known: false })
      // A git checkout, pull, reset and the like: the diff was skipped, and those rewrite the tree.
      if (partial && out.length === 0) out.push({ file: '(shell command)', add: 0, del: 0, known: false, big: diff.skipped === true })
      return { list: out, partial: partial || out.some(c => !c.known) }
    }
    default:
      return none
  }
}

/** A key for a shell diff the engine shared across parallel calls, so it is counted once. */
function sharedKey(result: unknown): string | null {
  const diff = asRecord(asRecord(result)?.bashEditDiff)
  if (diff === null || diff.shared !== true) return null
  const files = (diff.files as { filePath: string; hunks: { lines: string[] }[] }[] | undefined) ?? []
  return JSON.stringify([files.map(f => [f.filePath, countHunks(f.hunks)]), diff.changedFiles ?? [], diff.moreFiles ?? 0])
}

/** The path a change is keyed by: its real path where it still exists, so `/tmp` and `/private/tmp` match. */
async function realPath($: EngineInterface, path: string): Promise<string> {
  if (!path.startsWith('/')) return path
  const cached = realPaths.get(path)
  if (cached !== undefined) return cached
  try {
    const stat = await $.fs.stat(path, { resolve: true })
    const real = stat.realPath ?? path
    realPaths.set(path, real)
    return real
  } catch {
    return path
  }
}

function hudOf(t: SessionTotals): Totals {
  return { add: t.add, del: t.del, files: t.files, quakes: t.quakes }
}

/** Keeps the hottest MAX_HEAT files, so the heat map (and every edit's copy of it) stays bounded. */
function capHeat(files: Record<string, FileHeat>): Record<string, FileHeat> {
  const keys = Object.keys(files)
  if (keys.length <= MAX_HEAT) return files
  const kept = keys.sort((a, b) => weightOf(files[b] as FileHeat) - weightOf(files[a] as FileHeat)).slice(0, MAX_HEAT)
  const out: Record<string, FileHeat> = {}
  for (const k of kept) out[k] = files[k] as FileHeat
  return out
}

function sameQuake(a: Quake | null, b: Quake | null): boolean {
  return a !== null && b !== null && a.at === b.at && a.file === b.file && a.add === b.add && a.del === b.del
}

/** Halves the oldest half of the history by merging neighbours, so a long session keeps its shape in bounded space. */
function compact(list: Quake[]): Quake[] {
  if (list.length <= MAX_EVENTS) return list
  const half = Math.floor(list.length / 2)
  const merged: Quake[] = []
  for (let i = 0; i < half; i += 2) {
    const a = list[i]!
    const b = list[i + 1]
    if (b === undefined || i + 1 >= half) {
      merged.push(a)
      continue
    }
    const big = a.mag >= b.mag ? a : b
    // A merged bucket is drawn by its summed lines; its magnitude is recomputed from them, and the
    // largest real edit is kept separately (the `largest` atom), so a bucket is never reported as one.
    const add = a.add + b.add
    const del = a.del + b.del
    merged.push({ at: a.at, file: big.file, files: a.files + b.files, add, del, mag: magnitude(add, del), partial: a.partial || b.partial })
  }
  return [...merged, ...list.slice(half)]
}

/** One animation frame: scroll the trace and repaint the band's Raster in place. */
async function tick($: EngineInterface): Promise<void> {
  const hum = Date.now() - trace.lastKick < HUM_MS
  if (trace.settled && alert === null && !hum) return
  const at = site
  if (at === null) return
  trace.step(hum)
  frame += 1
  const t = await read($, totals)
  const flashing = alert !== null && alert.framesLeft > 0
  const cells = bandCells(trace, at.columns, at.rows, hudOf(t), flashing ? alert : null, flashing && frame % 6 < 3).encode()
  const res = await $.ui.blit({ requestId: at.requestId, key: BAND_KEY, cells, columns: at.columns, rows: at.rows })
  if (res.deny !== undefined) {
    if (site === at) site = null
    return
  }
  // The banner only counts down while it is actually on screen.
  if (alert !== null) {
    alert.framesLeft -= 1
    if (alert.framesLeft <= 0) alert = null
  }
}

/** Tracked files of the repository the session works in, with their sizes, from one bounded git call. */
async function scanRepo($: EngineInterface): Promise<RepoMap | null> {
  try {
    return await scanRepoOrThrow($)
  } catch {
    // git missing or too slow: the seismograph still opens, just without the heat map.
    return null
  }
}

async function scanRepoOrThrow($: EngineInterface): Promise<RepoMap | null> {
  const cwd = await $.session.cwd()
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 4000 })
  if (top.exitCode !== 0) return null
  const root = await realPath($, top.stdout.trim())
  const tree = await $.process.run(['git', 'ls-tree', '-r', '-l', '-z', 'HEAD'], { cwd: root, timeoutMs: 8000 })
  const files: MapFile[] = []
  let isCut = false
  if (tree.exitCode === 0) {
    const entries = tree.stdout.split('\0')
    // Every whole entry ends in NUL; the piece after the last NUL is empty, or cut off.
    const tail = entries.pop()
    isCut = tree.isStdoutTruncated || (tail !== undefined && tail.length > 0)
    for (const entry of entries) {
      // "<mode> blob <sha> <size>\t<path>"
      const tab = entry.indexOf('\t')
      if (tab < 0) continue
      const meta = entry.slice(0, tab).trim().split(/\s+/)
      if (meta[1] !== 'blob') continue
      const bytes = Number(meta[3])
      if (!Number.isFinite(bytes)) continue
      files.push({ path: entry.slice(tab + 1), bytes })
    }
  }
  files.sort((a, b) => b.bytes - a.bytes)
  return { root, files: files.slice(0, MAX_FILES), more: Math.max(0, files.length - MAX_FILES), isCut, at: Date.now() }
}

function weightOf(fh: FileHeat): number {
  return fh.add + fh.del + fh.touched
}

/** Treemap entries: the repo's files, plus touched files the scan missed (new, or cut by the size limit). */
function entriesOf(repo: RepoMap, files: Record<string, FileHeat>): MapEntry[] {
  let peak = 1
  for (const fh of Object.values(files)) peak = Math.max(peak, weightOf(fh))
  const heatOf = (fh: FileHeat | undefined) => (fh === undefined ? 0 : Math.max(0.08, Math.log10(1 + weightOf(fh)) / Math.log10(1 + peak)))
  const seen = new Set<string>()
  const out: MapEntry[] = []
  for (const f of repo.files) {
    const abs = `${repo.root}/${f.path}`
    seen.add(abs)
    const fh = files[abs]
    out.push({ path: f.path, bytes: f.bytes, heat: heatOf(fh), add: fh?.add ?? 0, del: fh?.del ?? 0 })
  }
  for (const [abs, fh] of Object.entries(files)) {
    if (seen.has(abs) || !abs.startsWith(`${repo.root}/`)) continue
    out.push({ path: abs.slice(repo.root.length + 1), bytes: Math.max(200, (fh.add + 1) * 40), heat: heatOf(fh), add: fh.add, del: fh.del })
  }
  return out
}

function describe(ev: Quake): string {
  const where = ev.files > 1 ? `${ev.files} files (most in ${baseName(ev.file)})` : baseName(ev.file)
  return `M${ev.mag.toFixed(1)} ${where} (+${ev.add} −${ev.del}${ev.partial ? ', partial' : ''})`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'quake',
      description: 'Diff Seismograph: open the session seismograph and repo heat map (`/quake band off` hides the band)',
      argumentHint: '[band on|off]',
      immediate: true,
    })
    $.clock.every(FRAME_MS, () => tick($))
    return next(e)
  })

  on('command.run', { command: 'quake' }, async ($, e) => {
    const args = e.args.trim().toLowerCase()
    if (args === 'band off' || args === 'band on') {
      await update($, band, () => args === 'band on')
      if (args === 'band off') site = null
      return { text: `Diff Seismograph: band ${args === 'band on' ? 'on' : 'off'}.` }
    }
    const repo = await scanRepo($)
    await update($, map, () => repo)
    await $.ui.open({ id: PANE, title: 'Diff Seismograph' })
    const t = await read($, totals)
    return { text: `Diff Seismograph: ${t.edits} edit${t.edits === 1 ? '' : 's'} this session${repo === null ? ' (not a git repo, so no heat map)' : ''}.` }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    // A shell diff shared by parallel calls is the same change: count it once.
    const shared = sharedKey(ran.result)
    if (shared !== null) {
      if (sharedSeen.has(shared)) return ran
      sharedSeen.add(shared)
      if (sharedSeen.size > 200) sharedSeen.clear()
    }
    const got = changesOf(e as { tool: string }, ran.result)
    const found = got.list.filter(c => c.file.length > 0 && (c.add + c.del > 0 || !c.known))
    if (found.length === 0) return ran
    const changes: Change[] = []
    for (const c of found) changes.push(c.file.startsWith('(') ? c : { ...c, file: await realPath($, c.file) })
    const now = Date.now()
    const add = changes.reduce((s, c) => s + c.add, 0)
    const del = changes.reduce((s, c) => s + c.del, 0)
    const biggest = changes.reduce((a, b) => (b.add + b.del > a.add + a.del ? b : a))
    const partial = got.partial || changes.some(c => !c.known)
    const isBig = changes.some(c => c.big === true)
    // A change too large to diff counts as a quake at the threshold, with no invented line total.
    const mag = isBig ? Math.max(QUAKE_AT, magnitude(add, del)) : magnitude(add, del)
    const ev: Quake = { at: now, file: isBig ? (changes.find(c => c.big === true) as Change).file : biggest.file, files: changes.length, add, del, mag, partial }
    const isQuake = ev.mag >= QUAKE_AT
    await update($, events, cur => compact([...cur, ev]))
    const files = await update($, heat, cur => {
      const nextHeat: Record<string, FileHeat> = { ...cur }
      for (const c of changes) {
        const was = nextHeat[c.file] ?? { add: 0, del: 0, touched: 0 }
        nextHeat[c.file] = { add: was.add + c.add, del: was.del + c.del, touched: was.touched + (c.known ? 0 : 1) }
      }
      return capHeat(nextHeat)
    })
    const fileCount = Object.keys(files).length
    await update($, totals, cur => ({ add: cur.add + add, del: cur.del + del, edits: cur.edits + 1, quakes: cur.quakes + (isQuake ? 1 : 0), files: Math.max(cur.files ?? 0, fileCount) }))
    await update($, largest, cur => (cur === null || add + del > cur.add + cur.del ? ev : cur))
    trace.kick(Math.max(add, partial ? 20 : 0), del, now)
    if (isQuake) {
      alert = { mag: ev.mag, file: ev.files > 1 ? `${ev.files} files` : ev.file, framesLeft: FLASH_FRAMES }
      await update($, quake, () => ev)
    }
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const t = await read($, totals)
    const isOn = await read($, band)
    if (e.props.hasSurvey || !isOn || t.edits === 0 || e.props.maxRows < 2 || e.props.bodyColumns < 20) {
      if (site !== null && site.requestId === e.requestId) site = null
      return next(e)
    }
    const hud = hudOf(t)
    const flashingNow = alert !== null && alert.framesLeft > 0
    if (e.surface !== 'terminal') {
      if (site !== null && site.requestId === e.requestId) site = null
      // One row here: the mods beneath get the rest of the band.
      const below = await next({ ...e, props: { ...e.props, maxRows: e.props.maxRows - 1 } })
      const list = await read($, events)
      const { Box, Text } = $.ui.resolve(e)
      const line = sparkline(list.map(ev => ev.add + ev.del), 40)
      const quakeNote = flashingNow && alert !== null ? `  ◆ QUAKE M${alert.mag.toFixed(1)} ${baseName(alert.file)}` : ''
      return (
        <Box flexDirection="column">
          <Text>
            ≋ {line} +{hud.add} −{hud.del} · {hud.files} files{quakeNote}
          </Text>
          {below}
        </Box>
      )
    }
    const { Box, Raster } = $.ui.resolve(e)
    const columns = Math.min(512, e.props.bodyColumns)
    const rows = e.props.maxRows >= 4 ? 3 : 2
    // Reserve this band's rows before the mods beneath draw, so together they fit.
    const below = await next({ ...e, props: { ...e.props, maxRows: e.props.maxRows - rows } })
    site = { requestId: e.requestId, columns, rows }
    trace.resize(columns)
    const flashing = alert !== null && alert.framesLeft > 0
    const cells = bandCells(trace, columns, rows, hud, flashing ? alert : null, flashing).encode()
    return (
      <Box flexDirection="column">
        <Raster key={BAND_KEY} columns={columns} rows={rows} cells={cells} />
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, events)
    const files = await read($, heat)
    const repo = await read($, map)
    const latest = await read($, quake)
    const t = await read($, totals)
    const biggest = await read($, largest)
    const hottest = Object.entries(files)
      .sort((a, b) => weightOf(b[1]) - weightOf(a[1]))
      .slice(0, 6)
    const columns = Math.max(30, Math.min(512, e.props.bodyColumns))
    const viewRows = e.viewport?.rows ?? 40
    const fileCount = Object.keys(files).length
    const summary = `+${t.add} −${t.del} across ${fileCount} file${fileCount === 1 ? '' : 's'} · ${t.edits} edit${t.edits === 1 ? '' : 's'} · ${t.quakes} quake${t.quakes === 1 ? '' : 's'}`
    const largestLine = biggest === null ? '' : `largest: ${describe(biggest)}`
    const latestLine = latest === null || sameQuake(latest, biggest) ? '' : `latest quake: ${describe(latest)}`
    const fileLine = (file: string, fh: FileHeat) => `${baseName(file)} +${fh.add} −${fh.del}${fh.touched > 0 ? ' (+ unmeasured changes)' : ''}`
    if (e.surface !== 'terminal') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Text bold>Session seismograph</Text>
          <Text>{sparkline(list.map(ev => ev.add + ev.del), Math.min(80, columns))}</Text>
          <Text>{summary}</Text>
          {largestLine.length > 0 && <Text>{largestLine}</Text>}
          {latestLine.length > 0 && <Text>{latestLine}</Text>}
          {hottest.map(([file, fh]) => (
            <Text key={file}>{fileLine(file, fh)}</Text>
          ))}
        </Box>
      )
    }
    const { Box, Text, Raster } = $.ui.resolve(e)
    const graphRows = 6
    const mapRows = Math.max(6, Math.min(40, viewRows - graphRows - 11))
    const graph = sessionCells(list, columns, graphRows).encode()
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">
          ≋ SESSION SEISMOGRAPH
        </Text>
        <Raster key={PANE_GRAPH} columns={columns} rows={graphRows} cells={graph} />
        <Text>
          <Text color="green">+{t.add}</Text> <Text color="red">−{t.del}</Text>
          <Text dimColor>
            {' '}
            across {fileCount} file{fileCount === 1 ? '' : 's'} · {t.edits} edit{t.edits === 1 ? '' : 's'} · {t.quakes} quake
            {t.quakes === 1 ? '' : 's'}
          </Text>
        </Text>
        {largestLine.length > 0 && <Text color="red">◆ {largestLine}</Text>}
        {latestLine.length > 0 && <Text color="yellow">◇ {latestLine}</Text>}
        <Text bold color="cyan">
          ▦ REPO HEAT MAP
        </Text>
        {repo === null ? (
          <Text dimColor>Not a git repository, or git is unavailable: no heat map.</Text>
        ) : (
          <Raster key={PANE_MAP} columns={columns} rows={mapRows} cells={treemapCells(entriesOf(repo, files), columns, mapRows).encode()} />
        )}
        {repo !== null && repo.isCut && <Text dimColor>The file listing was cut off: the map shows part of the repo.</Text>}
        {repo !== null && repo.more > 0 && <Text dimColor>Largest {repo.files.length} files shown; {repo.more} smaller ones left out.</Text>}
        {hottest.length > 0 && <Text dimColor>hottest: {hottest.map(([file, fh]) => fileLine(file, fh)).join('  ')}</Text>}
      </Box>
    )
  })
}
