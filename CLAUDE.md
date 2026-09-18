# video-round-tripper: notes for coding agents

A library that round-trips a live web page through a video codec and paints the damaged result
back over it. The **artifacts are the deliverable** (blocking, banding, ringing, chroma bleed,
smeared motion), not fidelity.

Read these first; they are the project's real documentation, for humans and agents alike:

- [CONTRIBUTING.md](CONTRIBUTING.md): what is in the repo, commands, the demo pages, testing,
  releases.
- [ARCHITECTURE.md](ARCHITECTURE.md): how it works, and the gotchas. Read the gotchas before
  touching capture, the codec pipeline or the package build: most describe a failure that was
  SILENT (black canvas, frozen frame, wrong font), so `tsc`, the build and the unit tests all
  pass while the thing is broken.

## Working rules

- **Verify in a real browser, in real Chrome** (CONTRIBUTING.md has why and how). A passing
  build proves nothing here. Check the page is visible (`document.visibilityState`) before
  believing a frozen or black canvas, and eyeball the type after any capture change.
- **Measure, then write it down.** New lessons go into ARCHITECTURE.md's gotchas with the
  numbers that proved them, the way the existing ones are written.
- **Some checks need a human at a real screen** (on-interaction capture, anything judged "by
  eye", phones). Ask your human rather than guessing.
- **Releases are a human's call.** Pushing a `v<version>` tag publishes to npm (see
  CONTRIBUTING.md), so push one only on your human's explicit yes for that version.
- **Keep `roundtrip/README.md` identical to `README.md`**; a local pack refuses to run otherwise
  (CI and the publish workflow copy it themselves).
- If a `CLAUDE.local.md` exists beside this file, it holds the maintainer's machine- and
  account-specific notes (git-ignored); follow it too.
