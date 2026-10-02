import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { DEFAULT, Grid, Trace, base64, bandCells, baseName, countHunks, countTexts, magnitude, safeCode, sessionCells, squarify, treemapCells } from '../hooks/seismo'

const BAND = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} }
const PANE = { title: 'Diff Seismograph', isFocused: true, bodyColumns: 120, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

const patch = (add: number, del: number) => [
  { oldStart: 1, oldLines: del, newStart: 1, newLines: add, lines: [...Array.from({ length: add }, () => '+x'), ...Array.from({ length: del }, () => '-y'), ' ctx'] },
]

function tools(on: On) {
  on('tool.call', (_$, e) => {
    const call = e as { tool: string; file_path?: string; content?: string; command?: string }
    if (call.tool === 'Edit') {
      const lines = call.file_path?.includes('big') ? patch(240, 30) : patch(3, 1)
      return { result: { filePath: call.file_path, structuredPatch: lines } }
    }
    if (call.tool === 'Write') return { result: { type: 'create', filePath: call.file_path, content: 'a\nb\nc\n', structuredPatch: [] } }
    if (call.tool === 'Bash' && call.command === 'fail') return { isError: true as const, result: 'boom', text: 'boom' }
    if (call.tool === 'Bash') {
      return {
        result: {
          stdout: '',
          stderr: '',
          bashEditDiff: {
            files: [
              { filePath: '/repo/src/a.ts', hunks: patch(5, 2) },
              { filePath: '/repo/src/b.ts', hunks: patch(1, 4) },
            ],
            moreFiles: 0,
          },
        },
      }
    }
    return { result: {} }
  })
}

function git(on: On) {
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv.includes('--show-toplevel')) return ok('/repo\n')
    if (argv.includes('ls-tree')) {
      const rows = [
        '100644 blob aaa    9000\tsrc/big.ts',
        '100644 blob bbb    1200\tsrc/a.ts',
        '100644 blob ccc     400\tsrc/b.ts',
        '100644 blob ddd     300\tREADME.md',
      ]
      return ok(rows.join('\0') + '\0')
    }
    return ok('')
  })
}

type Run = Parameters<Engine['command']['run']>[0]
const quakeCmd = (args: string) => ({ command: 'quake', args }) as Run

function surfaces(on: On) {
  on('session.cwd', () => ({ value: '/repo' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>OTHER MOD</Text>
  })
}

async function deskPane($: Engine) {
  return $.ui.mount({ plugin: 'diff-seismograph', surface: 'desktop', component: 'Pane', requestId: 'diff-seismograph', props: PANE })
}

const edit = (file: string) => ({ tool: 'Edit' as const, file_path: file, old_string: 'a', new_string: 'b' })

describe('counting', () => {
  test('hunks count added and removed lines, not context', async () => {
    expect(countHunks(patch(3, 2))).toEqual({ add: 3, del: 2 })
    expect(countHunks(undefined)).toEqual({ add: 0, del: 0 })
  })

  test('text diffs are order-sensitive and count empty cells correctly', async () => {
    expect(countTexts('a\nb\nc', 'a\nc\nd\ne')).toEqual({ add: 2, del: 1 })
    expect(countTexts('', 'x\ny')).toEqual({ add: 2, del: 0 })
    expect(countTexts('x', '')).toEqual({ add: 0, del: 1 })
    expect(countTexts('a\nb', 'b\na')).toEqual({ add: 1, del: 1 })
    expect(countTexts('same\n', 'same\n')).toEqual({ add: 0, del: 0 })
  })

  test('magnitude is log-scaled like Richter', async () => {
    expect(magnitude(0, 0)).toBe(0)
    expect(magnitude(10, 0)).toBe(2.5)
    expect(magnitude(60, 40)).toBe(4)
    expect(magnitude(1000, 0)).toBe(5.5)
  })
})

describe('drawing', () => {
  test('only characters every terminal draws in one cell reach the grid', () => {
    expect(safeCode('a')).toBe(0x61)
    expect(safeCode('⣿')).toBe(0x28ff)
    expect(safeCode('█')).toBe(0x2588)
    // A wide watch emoji and a Devanagari combining mark both become "?".
    expect(safeCode('⌚')).toBe(0x3f)
    expect(safeCode('ि')).toBe(0x3f)
  })

  test('base64 matches the standard encoding for every padding case', async () => {
    for (const len of [0, 1, 2, 3, 4, 5, 31, 32]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37 + 11) & 0xff)
      expect(base64(bytes)).toBe(btoa(String.fromCharCode(...bytes)))
    }
  })

  test('cells pack as little-endian triplets', async () => {
    const grid = new Grid(1, 1)
    grid.set(0, 0, 0x2588, 0xff8800, DEFAULT)
    expect(grid.encode()).toBe(btoa(String.fromCharCode(0x88, 0x25, 0, 0, 0x00, 0x88, 0xff, 0, 0, 0, 0, 1)))
  })

  test('only width-1 printable code points reach the raster', async () => {
    expect(safeCode('a')).toBe(0x61)
    expect(safeCode('⠿')).toBe(0x283f)
    expect(safeCode('漢')).toBe(0x3f)
    expect(safeCode('⚠')).toBe(0x3f)
    expect(safeCode('😀')).toBe(0x3f)
    expect(safeCode('\n')).toBe(0x3f)
    expect(safeCode('\u0301')).toBe(0x3f)
    expect(safeCode('\u200d')).toBe(0x3f)
    expect(safeCode('\u009b')).toBe(0x3f)
    expect(baseName('C:\\work\\app.ts')).toBe('app.ts')
  })

  test('a two-row band still shows removals', async () => {
    const trace = new Trace(30)
    trace.kick(0, 200, 1)
    for (let i = 0; i < 3; i += 1) trace.step(false)
    const grid = bandCells(trace, 30, 2, { add: 0, del: 200, files: 1, quakes: 1 }, null, false)
    const fgs = Array.from({ length: 30 }, (_, i) => grid.cells[(30 + i) * 3 + 1] as number)
    expect(fgs.some(c => c !== DEFAULT && ((c >> 16) & 0xff) > ((c >> 8) & 0xff) + 0x40)).toBe(true)
  })

  test('the trace swings up for additions and down for removals, then settles', async () => {
    const trace = new Trace(40)
    expect(trace.settled).toBe(true)
    trace.kick(200, 0, 1)
    for (let i = 0; i < 5; i += 1) trace.step(false)
    const cells = bandCells(trace, 20, 3, { add: 200, del: 0, files: 1, quakes: 1 }, null, false)
    const upRow = Array.from({ length: 20 }, (_, i) => cells.cells[(20 + i) * 3] as number)
    expect(upRow.some(c => c >= 0x2582 && c <= 0x2588)).toBe(true)
    for (let i = 0; i < 200; i += 1) trace.step(false)
    expect(trace.settled).toBe(true)
  })

  test('the band names a quake in its HUD row', async () => {
    const grid = bandCells(new Trace(80), 40, 2, { add: 1, del: 1, files: 1, quakes: 1 }, { mag: 5.2, file: '/r/src/app.ts' }, false)
    const row = Array.from({ length: 40 }, (_, x) => String.fromCodePoint(grid.cells[x * 3] as number)).join('')
    expect(row).toMatch(/QUAKE M5\.2 app\.ts/)
  })

  test('squarify covers the box with every positive item', async () => {
    const placed = squarify(
      [{ weight: 6 }, { weight: 6 }, { weight: 4 }, { weight: 3 }, { weight: 2 }, { weight: 2 }, { weight: 1 }, { weight: 0 }],
      { x: 0, y: 0, w: 6, h: 4 },
    )
    expect(placed.length).toBe(7)
    const area = placed.reduce((s, p) => s + p.rect.w * p.rect.h, 0)
    expect(Math.abs(area - 24)).toBeLessThan(1e-6)
    for (const p of placed) {
      expect(p.rect.x).toBeGreaterThanOrEqual(-1e-9)
      expect(p.rect.y + p.rect.h).toBeLessThanOrEqual(4 + 1e-9)
    }
  })

  test('the treemap fills every cell and labels the hot file', async () => {
    const grid = treemapCells(
      [
        { path: 'src/hot.ts', bytes: 4000, heat: 1, add: 50, del: 3 },
        { path: 'src/cold.ts', bytes: 4000, heat: 0, add: 0, del: 0 },
        { path: 'README.md', bytes: 800, heat: 0, add: 0, del: 0 },
      ],
      40,
      10,
    )
    const empty = Array.from({ length: 400 }, (_, i) => grid.cells[i * 3 + 2]).filter(bg => bg === DEFAULT).length
    expect(empty).toBe(0)
    const text = Array.from({ length: 400 }, (_, i) => String.fromCodePoint(grid.cells[i * 3] as number)).join('')
    expect(text).toMatch(/hot\.ts/)
  })

  test('the session graph draws bars up for additions and down for removals, and a note when empty', async () => {
    const graph = sessionCells([{ at: 1, add: 10, del: 2 }, { at: 50, add: 1, del: 30 }], 30, 4)
    const top = Array.from({ length: 60 }, (_, i) => graph.cells[i * 3] as number)
    const bottom = Array.from({ length: 60 }, (_, i) => graph.cells[(60 + i) * 3] as number)
    expect(top.some(c => c >= 0x2581 && c <= 0x2588)).toBe(true)
    expect(bottom.some(c => c === 0x2580 || c === 0x2588)).toBe(true)
    const none = sessionCells([], 30, 4)
    const text = Array.from({ length: 120 }, (_, i) => String.fromCodePoint(none.cells[i * 3] as number)).join('')
    expect(text).toMatch(/no edits yet/)
  })
})

describe('hooks', () => {
  test('no band before the first edit, then a raster band above other mods', async ($, on) => {
    tools(on)
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>OTHER MOD</Text>
    })
    const quiet = await $.ui.mount({ plugin: 'diff-seismograph', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await quiet.find({ type: 'Raster' })).toBeUndefined()
    expect(await quiet.find({ type: 'Text', text: 'OTHER MOD' })).toBeDefined()
    await quiet.unmount()
    await $.tool.call(edit('/repo/src/a.ts'))
    const ui = await $.ui.mount({ plugin: 'diff-seismograph', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ type: 'Raster', key: 'seis' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'OTHER MOD' })).toBeDefined()
    await ui.unmount()
    const desk = await $.ui.mount({ plugin: 'diff-seismograph', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    expect(await desk.find({ type: 'Text', text: /\+3 −1/ })).toBeDefined()
    expect(await desk.find({ type: 'Text', text: 'OTHER MOD' })).toBeDefined()
    await desk.unmount()
  })

  test('edits, writes and shell changes all count; errors and staged writes do not', async ($, on) => {
    tools(on)
    surfaces(on)
    await $.tool.call(edit('/repo/src/a.ts'))
    await $.tool.call({ tool: 'Write', file_path: '/repo/src/new.ts', content: 'a\nb\nc\n' })
    await $.tool.call({ tool: 'Bash', command: 'sed -i s/x/y/ src/*.ts' })
    await $.tool.call({ tool: 'Bash', command: 'fail' })
    const band = await $.ui.mount({ plugin: 'diff-seismograph', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    expect(await band.find({ type: 'Text', text: /\+12 −7 · 3 files/ })).toBeDefined()
    await band.unmount()
    const pane = await deskPane($)
    expect(await pane.find({ type: 'Text', text: /3 edits/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'a.ts +8 −3' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'b.ts +1 −4' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'new.ts +3 −0' })).toBeDefined()
    await pane.unmount()
  })

  test('a big edit is recorded as a quake', async ($, on) => {
    tools(on)
    surfaces(on)
    await $.tool.call(edit('/repo/src/big.ts'))
    const pane = await deskPane($)
    expect(await pane.find({ type: 'Text', text: /largest: M4\.\d big\.ts \(\+240 −30\)/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /1 quake\b/ })).toBeDefined()
    await pane.unmount()
  })

  test('/quake opens the pane with the seismograph and the repo heat map', async ($, on) => {
    tools(on)
    git(on)
    surfaces(on)
    await $.tool.call(edit('/repo/src/big.ts'))
    await $.tool.call(edit('/repo/src/a.ts'))
    const ran = await $.command.run(quakeCmd(''))
    expect(String(ran.text)).toMatch(/2 edits/)
    const pane = await $.ui.mount({ plugin: 'diff-seismograph', surface: 'terminal', component: 'Pane', requestId: 'diff-seismograph', props: PANE })
    expect(await pane.find({ type: 'Raster', key: 'session' })).toBeDefined()
    expect(await pane.find({ type: 'Raster', key: 'treemap' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /QUAKE|largest: M/ })).toBeDefined()
    await pane.unmount()
    const desk = await deskPane($)
    expect(await desk.find({ type: 'Text', text: /big\.ts \+240/ })).toBeDefined()
    await desk.unmount()
  })

  test('a large Write with no patch still counts, from its old body or git stats', async ($, on) => {
    surfaces(on)
    on('tool.call', (_$, e) => {
      const call = e as { file_path?: string }
      if (call.file_path === '/repo/a.ts') return { result: { type: 'update', filePath: '/repo/a.ts', content: 'x\ny\nz\n', structuredPatch: [], originalFile: 'x\nq\n' } }
      if (call.file_path === '/repo/b.ts') return { result: { type: 'update', filePath: '/repo/b.ts', content: 'n\n', structuredPatch: [], originalFile: null, gitDiff: { filename: 'b.ts', status: 'modified', additions: 1, deletions: 900, changes: 901, patch: '' } } }
      return { result: { type: 'update', filePath: '/repo/c.ts', content: 'one\ntwo\n', structuredPatch: [], originalFile: null } }
    })
    await $.tool.call({ tool: 'Write', file_path: '/repo/a.ts', content: 'x' })
    await $.tool.call({ tool: 'Write', file_path: '/repo/b.ts', content: 'n' })
    await $.tool.call({ tool: 'Write', file_path: '/repo/c.ts', content: 'one' })
    const pane = await deskPane($)
    expect(await pane.find({ type: 'Text', text: 'a.ts +2 −1' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'b.ts +1 −900' })).toBeDefined()
    // The old body was left out (over 10 MB): a big rewrite of unknown size, never counted as all-new lines.
    expect(await pane.find({ type: 'Text', text: 'c.ts +0 −0 (+ unmeasured changes)' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /largest: M5\.\d b\.ts/ })).toBeDefined()
    await pane.unmount()
  })

  test('shell diffs the engine did not expand still count as touched files', async ($, on) => {
    surfaces(on)
    on('tool.call', () => ({ result: { stdout: '', stderr: '', bashEditDiff: { files: [{ filePath: '/repo/a.ts', hunks: patch(2, 0) }], moreFiles: 1, changedFiles: ['/repo/a.ts', '/repo/gen.ts'] } } }))
    await $.tool.call({ tool: 'Bash', command: 'npm run codegen' })
    const pane = await deskPane($)
    expect(await pane.find({ type: 'Text', text: 'gen.ts +0 −0 (+ unmeasured changes)' })).toBeDefined()
    // Two listed files plus the one the engine only counted (moreFiles).
    expect(await pane.find({ type: 'Text', text: /3 files/ })).toBeDefined()
    await pane.unmount()
  })

  test('the largest quake stays the largest after a smaller one', async ($, on) => {
    surfaces(on)
    on('tool.call', (_$, e) => {
      const call = e as { file_path?: string }
      return { result: { filePath: call.file_path, structuredPatch: call.file_path === '/repo/huge.ts' ? patch(1200, 0) : patch(110, 0) } }
    })
    await $.tool.call(edit('/repo/huge.ts'))
    await $.tool.call(edit('/repo/small.ts'))
    const pane = await deskPane($)
    expect(await pane.find({ type: 'Text', text: /largest: M\d\.\d huge\.ts/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /latest quake: M\d\.\d small\.ts/ })).toBeDefined()
    await pane.unmount()
  })

  test('/quake band off hides the band', async ($, on) => {
    tools(on)
    surfaces(on)
    await $.tool.call(edit('/repo/src/a.ts'))
    await $.command.run(quakeCmd('band off'))
    const ui = await $.ui.mount({ plugin: 'diff-seismograph', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await ui.find({ type: 'Raster' })).toBeUndefined()
    await ui.unmount()
  })

  test('a reorder too large to diff exactly is an unmeasured change, never "no change"', async ($, on) => {
    surfaces(on)
    const lines = Array.from({ length: 2100 }, (_, i) => `line ${i}`)
    on('tool.call', () => ({ result: { type: 'update', filePath: '/repo/big.ts', content: [...lines].reverse().join('\n'), structuredPatch: [], originalFile: lines.join('\n') } }))
    await $.tool.call({ tool: 'Write', file_path: '/repo/big.ts', content: 'x' })
    const pane = await deskPane($)
    expect(await pane.find({ type: 'Text', text: 'big.ts +0 −0 (+ unmeasured changes)' })).toBeDefined()
    await pane.unmount()
  })

  test('a shell diff shared by parallel calls is counted once', async ($, on) => {
    surfaces(on)
    on('tool.call', () => ({ result: { stdout: '', stderr: '', bashEditDiff: { files: [{ filePath: '/repo/a.ts', hunks: patch(5, 0) }], moreFiles: 0, shared: true } } }))
    await $.tool.call({ tool: 'Bash', command: 'sed -i x a.ts' })
    await $.tool.call({ tool: 'Bash', command: 'sleep 1' })
    const pane = await deskPane($)
    expect(await pane.find({ type: 'Text', text: 'a.ts +5 −0' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /1 edit ·/ })).toBeDefined()
    await pane.unmount()
  })

  test('a git command whose diff the engine skipped is a quake with no invented line total', async ($, on) => {
    surfaces(on)
    on('tool.call', () => ({ result: { stdout: '', stderr: '', bashEditDiff: { files: [], moreFiles: 0, skipped: true } } }))
    await $.tool.call({ tool: 'Bash', command: 'git checkout main' })
    const pane = await deskPane($)
    expect(await pane.find({ type: 'Text', text: /1 quake/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /\+0 −0, partial/ })).toBeDefined()
    await pane.unmount()
  })

  test('the band reserves its rows before the mods beneath draw', async ($, on) => {
    on('session.cwd', () => ({ value: '/repo' }))
    let belowRows = -1
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      belowRows = e.props.maxRows
      const { Text } = $.ui.resolve(e)
      return <Text>OTHER MOD</Text>
    })
    on('tool.call', () => ({ result: { filePath: '/repo/a.ts', structuredPatch: patch(3, 1) } }))
    await $.tool.call(edit('/repo/a.ts'))
    const ui = await $.ui.mount({ plugin: 'diff-seismograph', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    // The band takes 3 of the 6 rows; the plugins beneath are told they have the other 3.
    expect(belowRows).toBe(3)
    await ui.unmount()
  })

})
