# Diff Seismograph

A live seismograph of your session's edits, drawn in the terminal.

- **The band above the prompt** scrolls a two-channel trace in solid block bars: additions swing up in green, removals down in red. Each edit rings out and decays like a seismometer, older samples fade like phosphor, and a faint hum keeps it alive while you work. The HUD row shows `+added −removed · files`.
- **Quakes:** an edit of about 100 lines or more (magnitude 4.0+, Richter-style: 10 lines is M2.5, 1000 is M5.5) flashes a `◆ QUAKE M4.7 server.ts` banner for a few seconds.
- **`/quake`** opens a pane with the whole session's seismograph and a **heat map of the repo**: a squarified treemap of every tracked file, sized by bytes, where the files changed this session glow from purple through red and orange to white-hot. The hottest boxes are labeled with their `+added −removed`.
- `/quake band off` hides the band; `/quake band on` brings it back.

Edits, Writes, notebook edits and shell commands that change files (via Claude Code's own `bashEditDiff` record) all count. Failed or staged edits don't. When Claude Code couldn't measure a change (a rewrite too large to diff, or a shell diff it skipped or cut short), the file still lights up and is marked as having unmeasured changes. Line counts are never invented: a change too large to diff (a 10 MB+ rewrite, a file the shell diff left unexpanded, or a `git checkout`/`pull`/`reset` whose diff was skipped) counts as a quake at the threshold with `+0 −0, partial`. A shell diff Claude Code shares across parallel calls is counted once. Backgrounded shell commands carry no diff, so they don't appear.

The band and pane draw with `Raster` cells, so they need a terminal; on the desktop app you get a text sparkline and per-file totals instead.

## What it hooks

Events this mod hooks, as `claude plugin validate` reads the module:

- `session.start`
- `command.run{command=quake}`
- `tool.call`
- `ui.render{component=AbovePrompt}`
- `ui.render{component=Pane, requestId=diff-seismograph}`

Engine calls it makes: `$.clock.every`, `$.command.register`, `$.fs.stat (via realPath)`, `$.process.run (via scanRepo)`, `$.session.cwd (via scanRepo)`, `$.state.get`, `$.state.set`, `$.ui.blit (via tick)`, `$.ui.open`, `$.ui.resolve`.

Its `tool.call` hook only observes: it reads each finished call's record of changed lines and never refuses or rewrites a call.

## Privacy

It runs entirely on your machine and sends nothing over the network. It counts added and removed lines from Claude Code's own records of each edit, and runs `git` locally (`git rev-parse` and `git ls-tree`) only when you open `/quake`, to size the heat map. Counts live in the session's plugin state; no file contents are stored.

The mod collects no analytics or telemetry, and its author receives no data from it.

Full policy: [PRIVACY.md](PRIVACY.md).

## License

MIT

## Install

```
/plugin marketplace add ccdwyer/claude-mods
/plugin install diff-seismograph@ccdwyer-mods
/reload-plugins
```

## Develop

```
claude plugin validate .
claude plugin test .
```
