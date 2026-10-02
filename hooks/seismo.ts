// Pure drawing and counting for Diff Seismograph: no engine calls in this file.

export const DEFAULT = 0x01000000

type Hunk = { lines: readonly string[] }

/** Lines added and removed in a set of unified-diff hunks. */
export function countHunks(hunks: readonly Hunk[] | undefined): { add: number; del: number } {
  let add = 0
  let del = 0
  for (const hunk of hunks ?? []) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) add += 1
      else if (line.startsWith('-')) del += 1
    }
  }
  return { add, del }
}

export function lineCount(text: string | undefined): number {
  return text === undefined ? 0 : linesOf(text).length
}

function linesOf(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

const LCS_LIMIT = 4_000_000

/**
 * Lines added and removed between two texts, order-sensitive (a longest-common-subsequence
 * diff), so reordering lines counts as a change. Very large inputs fall back to a multiset
 * count, which can only under-count reorders.
 */
/** Lines added and removed. `approx` is set when the texts were too large for an exact, order-aware diff. */
export function countTexts(before: string, after: string): { add: number; del: number; approx?: true } {
  const a = linesOf(before)
  const b = linesOf(after)
  // Trim the common head and tail first: most edits touch a small middle.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  if (midA.length === 0 || midB.length === 0) return { add: midB.length, del: midA.length }
  if (midA.length * midB.length > LCS_LIMIT) {
    const seen = new Map<string, number>()
    for (const line of midA) seen.set(line, (seen.get(line) ?? 0) + 1)
    let common = 0
    for (const line of midB) {
      const n = seen.get(line) ?? 0
      if (n > 0) {
        seen.set(line, n - 1)
        common += 1
      }
    }
    return { add: midB.length - common, del: midA.length - common, approx: true }
  }
  let prev = new Uint32Array(midB.length + 1)
  let cur = new Uint32Array(midB.length + 1)
  for (let i = 1; i <= midA.length; i += 1) {
    for (let j = 1; j <= midB.length; j += 1) {
      cur[j] = midA[i - 1] === midB[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, cur[j - 1] as number)
    }
    const t = prev
    prev = cur
    cur = t
  }
  const common = prev[midB.length] as number
  return { add: midB.length - common, del: midA.length - common }
}

/** Richter-style magnitude of a change: 10 lines is M2.5, 100 is M4.0, 1000 is M5.5. */
export function magnitude(add: number, del: number): number {
  const total = add + del
  if (total <= 0) return 0
  return Math.round((1 + 1.5 * Math.log10(total)) * 10) / 10
}

export const QUAKE_AT = 4

// ---- cell packing ----

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard padded base64 of a byte array; no reliance on the environment's encoders. */
export function base64(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = (bytes[i] as number) << 16
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + '=='
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + '='
  }
  return out
}

/** A grid of `[codePoint, fg, bg]` cells, row-major. */
export class Grid {
  readonly cells: Uint32Array
  constructor(readonly columns: number, readonly rows: number) {
    this.cells = new Uint32Array(columns * rows * 3)
    for (let i = 0; i < columns * rows; i += 1) {
      this.cells[i * 3] = 0x20
      this.cells[i * 3 + 1] = DEFAULT
      this.cells[i * 3 + 2] = DEFAULT
    }
  }

  set(x: number, y: number, code: number, fg: number, bg: number = DEFAULT): void {
    if (x < 0 || y < 0 || x >= this.columns || y >= this.rows) return
    const i = (y * this.columns + x) * 3
    this.cells[i] = code
    this.cells[i + 1] = fg
    this.cells[i + 2] = bg
  }

  bg(x: number, y: number, bg: number): void {
    if (x < 0 || y < 0 || x >= this.columns || y >= this.rows) return
    this.cells[(y * this.columns + x) * 3 + 2] = bg
  }

  /** Writes text left to right, one printable width-1 character per cell; anything else becomes '?'. */
  text(x: number, y: number, text: string, fg: number, bg: number = DEFAULT): number {
    let col = x
    for (const ch of text) {
      if (col >= this.columns) break
      this.set(col, y, safeCode(ch), fg, bg)
      col += 1
    }
    return col
  }

  encode(): string {
    // The engine reads little-endian u32s; build the bytes explicitly so the host's byte order never matters.
    const bytes = new Uint8Array(this.cells.length * 4)
    for (let i = 0; i < this.cells.length; i += 1) {
      const v = this.cells[i] as number
      bytes[i * 4] = v & 0xff
      bytes[i * 4 + 1] = (v >>> 8) & 0xff
      bytes[i * 4 + 2] = (v >>> 16) & 0xff
      bytes[i * 4 + 3] = (v >>> 24) & 0xff
    }
    return base64(bytes)
  }
}

/** A code point the Raster accepts: printable, width 1, in the BMP. */
export function safeCode(ch: string): number {
  const code = ch.codePointAt(0) ?? 0x3f
  // A conservative allowlist of characters every terminal draws in exactly one cell: ASCII,
  // Latin, Greek and Cyrillic letters (no combining marks), common punctuation, arrows,
  // math, box drawing, blocks, geometric shapes and braille. Anything else draws as "?".
  const ranges: Array<[number, number]> = [
    [0x20, 0x7e], [0xa0, 0xac], [0xae, 0x2ff], [0x370, 0x482], [0x48a, 0x52f],
    [0x2010, 0x2027], [0x2030, 0x205e], [0x20a0, 0x20bf], [0x2100, 0x214f], [0x2190, 0x21ff],
    [0x2200, 0x22ff], [0x2500, 0x25ff], [0x2800, 0x28ff],
  ]
  for (const [lo, hi] of ranges) if (code >= lo && code <= hi) return code
  return 0x3f
}

// ---- color ----

export function rgb(r: number, g: number, b: number): number {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  return (c(r) << 16) | (c(g) << 8) | c(b)
}

function scale(color: number, f: number): number {
  return rgb(((color >> 16) & 0xff) * f, ((color >> 8) & 0xff) * f, (color & 0xff) * f)
}

function mix(a: number, b: number, t: number): number {
  const ch = (c: number, s: number) => ((c >> s) & 0xff) * (1 - t) + ((b >> s) & 0xff) * t
  return rgb(ch(a, 16), ch(a, 8), ch(a, 0))
}

const HEAT = [0x2b1055, 0x7b1fa2, 0xd32f2f, 0xff6f00, 0xffd600, 0xfffde0]

/** Heat palette from cold purple (0) to white-hot (1). */
export function heatColor(t: number): number {
  const x = Math.max(0, Math.min(1, t)) * (HEAT.length - 1)
  const i = Math.min(HEAT.length - 2, Math.floor(x))
  return mix(HEAT[i] as number, HEAT[i + 1] as number, x - i)
}

export const GREEN = 0x39ff88
export const RED = 0xff3b5c
export const AMBER = 0xffc040
export const CYAN = 0x34e2e2
export const DIM = 0x4a5568

// ---- block bars ----

const EIGHTHS = [0x20, 0x2581, 0x2582, 0x2583, 0x2584, 0x2585, 0x2586, 0x2587, 0x2588]

function glow(color: number, age: number, isPeak: boolean): number {
  const base = scale(color, age)
  return isPeak ? mix(base, 0xffffff, 0.35 * age) : base
}

/**
 * Solid bars around a baseline: `upRows` rows above it filled from the bottom in eighths
 * (additions, green) and `downRows` rows below it filled from the top in halves (removals,
 * red). One sample per column; the right edge is newest and brightest.
 */
export function barsInto(grid: Grid, top: number, upRows: number, downRows: number, up: ArrayLike<number>, down: ArrayLike<number>, fade: boolean): void {
  const n = grid.columns
  const offset = up.length - n
  for (let x = 0; x < n; x += 1) {
    const i = x + offset
    const u = i < 0 ? 0 : Math.max(0, Math.min(1, up[i] as number))
    const d = i < 0 ? 0 : Math.max(0, Math.min(1, down[i] as number))
    const age = fade ? 0.3 + 0.7 * (x / Math.max(1, n - 1)) ** 1.4 : 1
    if (downRows === 0) {
      // Compact: one row carries both channels, the stronger one wins the cell.
      const v = Math.max(u, d)
      const k = Math.round(v * 8)
      if (k === 0) grid.set(x, top, x % 3 === 0 ? 0x2581 : 0x20, 0x16202b)
      else grid.set(x, top, EIGHTHS[k] as number, glow(d > u ? RED : GREEN, age, true))
      continue
    }
    // Up: eighths from the baseline upward.
    let eighths = Math.round(u * upRows * 8)
    for (let r = 0; r < upRows; r += 1) {
      const y = top + upRows - 1 - r
      const k = Math.max(0, Math.min(8, eighths))
      eighths -= 8
      const isPeak = k > 0 && (k < 8 || eighths <= 0)
      if (k === 0) grid.set(x, y, r === 0 && x % 3 === 0 ? 0x2581 : 0x20, r === 0 ? 0x16202b : DEFAULT)
      else grid.set(x, y, EIGHTHS[k] as number, glow(GREEN, age, isPeak))
    }
    // Down: halves from the baseline downward.
    let halves = Math.round(d * downRows * 2)
    for (let r = 0; r < downRows; r += 1) {
      const y = top + upRows + r
      const k = Math.max(0, Math.min(2, halves))
      halves -= 2
      const isPeak = k > 0 && (k < 2 || halves <= 0)
      if (k === 0) grid.set(x, y, 0x20, DEFAULT)
      else grid.set(x, y, k === 2 ? 0x2588 : 0x2580, glow(RED, age, isPeak))
    }
  }
}

// ---- the live trace ----

/** Normalizes a line count to 0..1: 1 line barely moves the needle, 1000 lines is full scale. */
export function kickSize(lines: number): number {
  if (lines <= 0) return 0
  return Math.min(1, 0.4 + Math.log10(1 + lines) / 3.4)
}

/**
 * A scrolling two-channel trace: additions swing up, removals swing down, and each kick rings
 * out like a seismometer (damped oscillation) before settling to a faint hum.
 */
export class Trace {
  up: Float32Array
  down: Float32Array
  private energyUp = 0
  private energyDown = 0
  private phase = 0
  private seed = 0x9e3779b9
  lastKick = 0

  constructor(width: number) {
    this.up = new Float32Array(width)
    this.down = new Float32Array(width)
  }

  resize(width: number): void {
    if (width === this.up.length) return
    const up = new Float32Array(width)
    const down = new Float32Array(width)
    const n = Math.min(width, this.up.length)
    up.set(this.up.subarray(this.up.length - n), width - n)
    down.set(this.down.subarray(this.down.length - n), width - n)
    this.up = up
    this.down = down
  }

  kick(add: number, del: number, now: number): void {
    this.energyUp = Math.min(1, this.energyUp + kickSize(add))
    this.energyDown = Math.min(1, this.energyDown + kickSize(del))
    this.lastKick = now
  }

  /** True when there is nothing left moving: no energy and an all-quiet buffer. */
  get settled(): boolean {
    if (this.energyUp > 0.002 || this.energyDown > 0.002) return false
    for (let i = 0; i < this.up.length; i += 1) if ((this.up[i] as number) > 0.06 || (this.down[i] as number) > 0.06) return false
    return true
  }

  private noise(): number {
    // xorshift32: deterministic jitter, no Math.random needed.
    let x = this.seed
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.seed = x >>> 0
    return (this.seed % 1000) / 1000
  }

  /** Advances one sample: everything scrolls left one dot and a new sample enters on the right. */
  step(hum: boolean): void {
    const w = this.up.length
    this.up.copyWithin(0, 1)
    this.down.copyWithin(0, 1)
    // A ringing envelope: big swings that wobble as they die out, plus a faint live hum.
    const ring = 0.55 + 0.45 * Math.abs(Math.sin(this.phase)) * (0.7 + 0.3 * this.noise())
    this.up[w - 1] = Math.min(1, this.energyUp * ring + (hum ? 0.05 + 0.1 * this.noise() : 0))
    this.down[w - 1] = Math.min(1, this.energyDown * ring + (hum ? 0.05 + 0.1 * this.noise() : 0))
    this.energyUp *= 0.95
    this.energyDown *= 0.95
    if (this.energyUp < 0.004) this.energyUp = 0
    if (this.energyDown < 0.004) this.energyDown = 0
    this.phase += 0.9
  }

}

export type Totals = { add: number; del: number; files: number; quakes: number }

/** The band: one HUD row over a braille trace. `flash` alternates the quake banner's colors. */
export function bandCells(
  trace: Trace,
  columns: number,
  rows: number,
  totals: Totals,
  quake: { mag: number; file: string } | null,
  flash: boolean,
): Grid {
  const grid = new Grid(columns, rows)
  let x = grid.text(0, 0, '≋ SEISMO ', CYAN)
  x = grid.text(x, 0, `+${totals.add}`, GREEN)
  x = grid.text(x + 1, 0, `−${totals.del}`, RED)
  x = grid.text(x + 1, 0, `· ${totals.files} file${totals.files === 1 ? '' : 's'}`, DIM)
  if (quake !== null) {
    const name = baseName(quake.file)
    const banner = ` ◆ QUAKE M${quake.mag.toFixed(1)} ${name} `
    // The alert wins the row: it overwrites the stats on a narrow band rather than being cut off.
    const start = Math.max(0, columns - banner.length)
    const fg = flash ? 0x000000 : RED
    const bg = flash ? RED : DEFAULT
    for (let i = start; i < columns; i += 1) grid.set(i, 0, 0x20, DEFAULT)
    grid.text(start, 0, banner.slice(0, columns - start), fg, bg)
  } else if (totals.quakes > 0) {
    const note = `${totals.quakes} quake${totals.quakes === 1 ? '' : 's'}`
    grid.text(Math.max(x + 2, columns - note.length), 0, note, DIM)
  }
  const body = rows - 1
  if (body <= 0) return grid
  if (body === 1) {
    barsInto(grid, 1, 1, 0, trace.up, trace.down, true)
    return grid
  }
  const upRows = Math.ceil(body / 2)
  barsInto(grid, 1, upRows, body - upRows, trace.up, trace.down, true)
  return grid
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

// ---- the session graph ----

/** The whole session as stacked bars: additions up, removals down, log-scaled, oldest at the left. */
export function sessionCells(
  events: readonly { at: number; add: number; del: number }[],
  columns: number,
  rows: number,
): Grid {
  const grid = new Grid(columns, rows)
  if (events.length === 0) {
    grid.text(1, Math.floor(rows / 2), 'no edits yet', DIM)
    return grid
  }
  const start = events[0]!.at
  const end = Math.max(events[events.length - 1]!.at, start + 1)
  const up = new Float32Array(columns)
  const down = new Float32Array(columns)
  events.forEach((ev, k) => {
    // Few enough events: one column each, in order, so a burst sharing a timestamp still spreads out.
    const x =
      events.length <= columns
        ? Math.round((k / Math.max(1, events.length - 1)) * (columns - 1))
        : Math.min(columns - 1, Math.floor((k * columns) / events.length))
    up[x] = (up[x] as number) + ev.add
    down[x] = (down[x] as number) + ev.del
  })
  let peak = 1
  for (let i = 0; i < columns; i += 1) peak = Math.max(peak, up[i] as number, down[i] as number)
  const norm = (v: number) => Math.log10(1 + v) / Math.log10(1 + peak)
  const upRows = Math.max(1, Math.ceil(rows / 2))
  barsInto(grid, 0, upRows, Math.max(1, rows - upRows), up.map(norm), down.map(norm), false)
  return grid
}

// ---- the treemap ----

export type Rect = { x: number; y: number; w: number; h: number }
export type Placed<T> = { item: T; rect: Rect }

/** Squarified treemap (Bruls, Huizing, van Wijk) of positive weights into a rectangle. */
export function squarify<T extends { weight: number }>(items: readonly T[], box: Rect): Placed<T>[] {
  const sorted = items.filter(i => i.weight > 0).sort((a, b) => b.weight - a.weight)
  const total = sorted.reduce((s, i) => s + i.weight, 0)
  if (total <= 0 || box.w <= 0 || box.h <= 0) return []
  const scaleArea = (box.w * box.h) / total
  const out: Placed<T>[] = []
  let rest = { ...box }
  let row: T[] = []
  const worst = (r: T[], side: number) => {
    const areas = r.map(i => i.weight * scaleArea)
    const sum = areas.reduce((a, b) => a + b, 0)
    const max = Math.max(...areas)
    const min = Math.min(...areas)
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min))
  }
  const layout = (r: T[]) => {
    const areas = r.map(i => i.weight * scaleArea)
    const sum = areas.reduce((a, b) => a + b, 0)
    if (rest.w >= rest.h) {
      const w = sum / rest.h
      let y = rest.y
      r.forEach((item, k) => {
        const h = (areas[k] as number) / w
        out.push({ item, rect: { x: rest.x, y, w, h } })
        y += h
      })
      rest = { x: rest.x + w, y: rest.y, w: rest.w - w, h: rest.h }
    } else {
      const h = sum / rest.w
      let x = rest.x
      r.forEach((item, k) => {
        const w = (areas[k] as number) / h
        out.push({ item, rect: { x, y: rest.y, w, h } })
        x += w
      })
      rest = { x: rest.x, y: rest.y + h, w: rest.w, h: rest.h - h }
    }
  }
  for (const item of sorted) {
    const side = Math.min(rest.w, rest.h)
    if (row.length === 0 || worst([...row, item], side) <= worst(row, side)) {
      row.push(item)
    } else {
      layout(row)
      row = [item]
    }
  }
  if (row.length > 0) layout(row)
  return out
}

export type MapEntry = { path: string; bytes: number; heat: number; add: number; del: number }

/**
 * The treemap grid: every tracked file sized by bytes (softened, so small files still show),
 * touched files filled with heat colors, untouched ones in two dark tones so borders read,
 * and the hottest files labeled where their box is wide enough.
 */
export function treemapCells(entries: readonly MapEntry[], columns: number, rows: number): Grid {
  const grid = new Grid(columns, rows)
  // Each cell is one column wide and roughly two "units" tall on screen, so lay out in a
  // box twice as tall as the row count and halve when rasterizing: rectangles look square.
  // Keep only as many files as the grid can show: hot files first, then the largest.
  const room = Math.max(1, Math.floor((columns * rows) / 3))
  const kept = [...entries].sort((a, b) => (b.heat > 0 ? 1 : 0) - (a.heat > 0 ? 1 : 0) || b.bytes - a.bytes).slice(0, room)
  const items = kept.map(e => ({ ...e, weight: Math.max(1, e.bytes) ** 0.6 }))
  const placed = squarify(items, { x: 0, y: 0, w: columns, h: rows * 2 })
  const owner = new Int32Array(columns * rows).fill(-1)
  // Smallest first, so where rounding overlaps, the larger file keeps the cell.
  const order = placed.map((_, k) => k).reverse()
  order.forEach(k => {
    const p = placed[k]!
    const x0 = Math.round(p.rect.x)
    const x1 = Math.max(x0 + 1, Math.round(p.rect.x + p.rect.w))
    const y0 = Math.round(p.rect.y / 2)
    const y1 = Math.max(y0 + 1, Math.round((p.rect.y + p.rect.h) / 2))
    for (let y = y0; y < Math.min(rows, y1); y += 1) for (let x = x0; x < Math.min(columns, x1); x += 1) owner[y * columns + x] = k
  })
  const hottest = new Set(
    placed
      .map((p, k) => ({ k, heat: p.item.heat }))
      .filter(p => p.heat > 0)
      .sort((a, b) => b.heat - a.heat)
      .slice(0, 10)
      .map(p => p.k),
  )
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      const k = owner[y * columns + x] as number
      if (k < 0) continue
      const item = placed[k]!.item
      const edge = x === 0 || owner[y * columns + x - 1] !== k
      const bg = item.heat > 0 ? heatColor(0.15 + 0.85 * item.heat) : k % 2 === 0 ? 0x161b22 : 0x1f2630
      grid.set(x, y, edge && item.heat === 0 ? 0x258f : 0x20, 0x0b0e14, bg)
    }
  }
  // Labels: top-left of each hot (or large) box that has room for at least a few characters.
  placed.forEach((p, k) => {
    const x0 = Math.round(p.rect.x)
    const width = Math.round(p.rect.x + p.rect.w) - x0
    const y0 = Math.round(p.rect.y / 2)
    const height = Math.round((p.rect.y + p.rect.h) / 2) - y0
    if (width < 4 || height < 1) return
    const isHot = hottest.has(k)
    if (!isHot && (width < 10 || height < 2)) return
    const name = baseName(p.item.path)
    const label = name.length > width - 1 ? name.slice(0, width - 2) + '…' : name
    const bg = p.item.heat > 0 ? heatColor(0.15 + 0.85 * p.item.heat) : k % 2 === 0 ? 0x161b22 : 0x1f2630
    const fg = p.item.heat > 0.55 ? 0x0b0e14 : p.item.heat > 0 ? 0xffffff : 0x8b95a5
    grid.text(x0 + 1, y0, label, fg, bg)
    if (isHot && height >= 2 && width >= 8) {
      const delta = `+${p.item.add} −${p.item.del}`
      grid.text(x0 + 1, y0 + 1, delta.slice(0, width - 1), fg, bg)
    }
  })
  return grid
}

/** A text sparkline, for surfaces with no Raster. */
export function sparkline(values: readonly number[], width: number): string {
  const blocks = '▁▂▃▄▅▆▇█'
  if (values.length === 0) return ''
  const per = Math.max(1, Math.ceil(values.length / width))
  const buckets: number[] = []
  for (let i = 0; i < values.length; i += per) buckets.push(values.slice(i, i + per).reduce((a, b) => a + b, 0))
  const peak = Math.max(1, ...buckets)
  return buckets.map(v => blocks[Math.min(7, Math.floor((Math.log10(1 + v) / Math.log10(1 + peak)) * 7.99))]).join('')
}
