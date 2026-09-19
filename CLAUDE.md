# Overlay — working notes

Realtime face overlay for macOS + Windows. Electron + TypeScript, no native
modules. Read README.md first; it covers layout, commands and the traps.

## Ground rules

- **TypeScript end to end.** The detector sits behind the `FaceDetector`
  interface in `src/shared/types.ts` precisely so it *could* be swapped for a
  napi-rs implementation later. Don't add native modules to get there early —
  the current WASM path runs at ~2 ms/frame with ~31 ms of headroom.
- **`src/worker/yunet.ts` stays dependency-free.** No ORT import, no DOM. It is
  the only file that ports to another runtime.
- **Nothing leaves the machine.** No telemetry, no CDN, no remote fetch at
  runtime. Every asset is imported from source so Vite emits it locally.
- **Validate every IPC payload** through `src/shared/schema.ts` before it can
  reach the filesystem. The renderer is sandboxed and gets bytes, never paths.

## Before you claim something works

`npm run typecheck && npm run verify:decode && npm run selftest`.

The decode is pinned bit-exact against OpenCV's `FaceDetectorYN` (IoU 1.00000,
0.000 px keypoint error). If you touch `yunet.ts`, `verify:decode` is the thing
that catches a subtle break — plausible-looking boxes that are slightly wrong
are the failure mode, and they will look fine on screen.

`npm run selftest` runs inside a real Electron window and is the only check that
covers cross-origin isolation, ORT threading and the asar paths. Run it against
a **packaged** build before shipping — dev and packaged fail differently.

## Don't leave GUI processes running

`npm start` and `--selftest` launch real windows. Kill them when done:
`pkill -f "odbb/out/Overlay" ; pkill -f "electron-forge start"`.

Screen mode in particular can leave a click-through, always-on-top window
around. The panic key is the way out (see README).

## Current state

Build order steps 1–9 of the original plan are done and verified. Step 10
(signing, notarization, installers) is configured but unexercised — there is no
Developer ID in this environment, and Wine/Mono are not installed, so Windows
currently ships as a portable zip.

Not built: video export (§10 open question, deliberately out of scope) and a
GitHub Actions matrix for native builds on both platforms.
