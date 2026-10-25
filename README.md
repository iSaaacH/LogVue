# LogVue

LogVue is a desktop app for organising and reviewing FTC Control Hub RLOG files. It turns a folder of raw logs into a searchable library of sessions, with match metadata, notes, and links back to the exact logs involved. It is also designed for agentic workflows: the archive stays readable through ordinary filesystem tools, while MCP handles live Control Hub operations.

<p align="center">
  <img src="docs/images/log-import-suggested-matches.png" width="1200" alt="Log import with suggested matches">
</p>

## What it does

- Imports logs from a Control Hub over ADB or from a local folder.
- Suggests logs for a match using their recorded timestamps.
- Organises sessions into libraries, events, matches, and child sessions.
- Supports searching by op-mode, alliance, tags, filenames, and other session details.
- Adds match metadata, tags, and rich-text notes to sessions.
- Links notes directly to logs so an observation can highlight the relevant file.
- Discovers and controls SpiderKit desktop simulations from a robot project's
  `spiderkit-sim.json` manifest.
- Syncs event and match data from FTCScout.
- Keeps session metadata and notes in filesystem-readable `session.json` and `notes.md` sidecars for agentic browsing.
- Provides MCP tools for live Control Hub status, log discovery, session creation, managed importing, and explicitly operator-gated FTC OpMode control.

## Agentic support

Agents can browse the archive through the filesystem and use MCP for live Control Hub operations and RLOG importing.

## Workflows

### Import logs

When a match has been created, LogVue compares the match time with available Control Hub logs and suggests the most likely files. Select the logs to import and LogVue copies them into the session while preserving their metadata.

### Browse the Control Hub

The Control Hub view lists available RLOG files with op-mode, timestamp, size, import status, and filename. Logs can be imported individually, in batches, or into a new session.

<p align="center">
  <img src="docs/images/control-hub-log-browser.png" width="1200" alt="Control Hub log browser">
</p>

### Highlight logs from notes

Mention a log from the Notes editor with `@`. Selecting the mention brings the matching log into focus, making it easy to move from an observation to the evidence behind it.

<p align="center">
  <img src="docs/images/notes-log-highlight.png" width="1200" alt="Log highlighted from a note">
</p>

### Simulate an OpMode

Choose a robot repository containing `spiderkit-sim.json`. LogVue can run its declared build,
discover the packaged SpiderKit plugins and OpModes, and control a simulation over the
`spiderkit-sim-opmode` protocol. The robot-local runner remains responsible for lifecycle, pacing,
plants, and logging; LogVue is the operator UI and live gamepad source.

Use **Build** after selecting a fresh robot checkout and again after changing robot or SpiderKit
code. LogVue itself may be running from `npm run dev`; the generated distribution belongs to the
selected robot repository, not to the LogVue installation.

Choose **Mini controls ↗** in the top toolbar (available from every view) to open a small driving panel above
AdvantageScope. The main window minimises automatically. The panel has keyboard/controller
selection, held Aim/Intake/Shoot buttons, pause/run, step, and stop. Uncheck **Stay on top** if
needed. **Full setup ↗** (or closing the panel) restores the main window without restarting the
simulation. Switching away from the panel releases its inputs; renderer failure stops the worker.

Continuous Run is always real-time, which suits a human driving with a LIVE gamepad. For agent
tests, RLOG-driven sessions, and batch log generation, set an absolute simulation timestamp and use
**Run fast** directly. LogVue initializes a fresh worker when needed; SpiderKit crosses the START
edge, executes the exact fixed-dt ticks without wall-clock pacing, and returns paused only after the
corresponding RLOG frames are complete. **Run fast** can then continue that paused worker to a later
timestamp.

## Development

```sh
npm install
npm run dev
```

Run the type checks with:

```sh
npm run typecheck
```

LogVue is released under the BSD 3-Clause License. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
