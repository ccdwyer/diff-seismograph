# Privacy

It runs entirely on your machine and sends nothing over the network. It counts added and removed lines from Claude Code's own records of each edit, and runs `git` locally (`git rev-parse` and `git ls-tree`) only when you open `/quake`, to size the heat map, and resolves file paths on disk so the same file isn't counted twice under two spellings. Counts live in the session's plugin state; no file contents are stored.

The mod collects no analytics or telemetry, and its author receives no data from it.

Questions: https://github.com/ccdwyer/diff-seismograph/issues
