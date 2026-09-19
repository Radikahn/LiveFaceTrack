# Overlay — working notes

Realtime face overlay for macOS + Windows. Electron + TypeScript, no native
modules. Read README.md first; it covers layout, commands and the traps.

## Ground rules

- **TypeScript end to end.** The detector sits behind the `FaceDetector`
  interface in `src/shared/types.ts` precisely so it _could_ be swapped for a
  napi-rs implementation later. Don't add native modules to get there early —
  the current WASM path runs at ~2 ms/frame with ~31 ms of headroom.
- **`src/worker/yunet.ts` stays dependency-free.** No ORT import, no DOM. It is
  the only file that ports to another runtime.
- **Nothing leaves the machine.** No telemetry, no CDN, no remote fetch at
  runtime. Every asset is imported from source so Vite emits it locally.
- **Validate every IPC payload** through `src/shared/schema.ts` before it can
  reach the filesystem. The renderer is sandboxed and gets bytes, never paths.

## Commit messages are load-bearing

Releases are cut by `release-please` from [Conventional
Commits](https://www.conventionalcommits.org/), so the prefix decides the
version bump: `fix:` patch, `feat:` minor, `feat!:`/`BREAKING CHANGE:` major.
`chore:`, `docs:`, `refactor:`, `ci:`, `test:` release nothing. A mislabelled
commit ships the wrong version number, silently.

## Before you claim something works

`npm run format:check && npm test && npm run selftest`
(`npm test` = typecheck + verify:decode).

The decode is pinned bit-exact against OpenCV's `FaceDetectorYN` (IoU 1.00000,
0.000 px keypoint error). If you touch `yunet.ts`, `verify:decode` is the thing
that catches a subtle break — plausible-looking boxes that are slightly wrong
are the failure mode, and they will look fine on screen.

`npm run selftest` runs inside a real Electron window and is the only check that
covers cross-origin isolation, ORT threading and the asar paths. Run it against
a **packaged** build before shipping — dev and packaged fail differently.

CI runs the same three on every PR, and additionally self-tests the _packaged_
app on macOS and Windows. Keep it that way: dev and packaged fail differently.

## Don't leave GUI processes running

`npm start` and `--selftest` launch real windows. Kill them when done:
`pkill -f "odbb/out/Overlay" ; pkill -f "electron-forge start"`.

Screen mode in particular can leave a click-through, always-on-top window
around. The panic key is the way out (see README).

## The overlay must always be escapable

A desktop overlay is transparent, click-through, always-on-top and
non-focusable. If every exit is broken, force-quit is the only way out — that
has already happened once. There are three, and the self-test asserts two of
them:

1. the Stop pill (hover hit-test toggles `setIgnoreMouseEvents`),
2. the global panic hotkey,
3. the tray menu.

Never remove one without checking the others still work, and never make the
pill's visibility depend on capture succeeding — the case where you most need
it is the case where the stream never opened.

## Current state

Build order steps 1–9 of the original plan are done and verified, and CI/CD is
in place: test + format + build on macOS and Windows, with automatic versioning
and release publishing driven by `release-please`.

Signing is configured but unexercised — there is no Developer ID in this
environment, so releases ship unsigned until `APPLE_IDENTITY` and the notary
secrets are added to the repo.

Not built: video export (§10 of the original plan, deliberately out of scope).
