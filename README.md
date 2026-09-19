# Overlay

A small glass window that holds your PNGs. Pick camera or screen. The PNG rides
on every face it finds.

macOS 12+ (arm64/x64) and Windows 10 1903+/11 (x64), both built from one Apple
Silicon Mac. TypeScript end to end — no native modules, no cross-compile.

Nothing leaves the machine.

---

## Quick start

```bash
npm install
node scripts/fetch-assets.mjs   # icons + tray glyphs
npm start                       # dev, with HMR
```

Add `?debug` to the stage URL (or run `npm start` and open devtools) to get
boxes, keypoints and a `capture / infer / draw` HUD instead of the overlays.

## Verifying it

Three layers, cheapest first:

```bash
npm run typecheck      # tsc, no emit
npm run verify:decode  # the YuNet decode vs OpenCV's reference implementation
npm run selftest       # the whole runtime, inside a real Electron window
```

`verify:decode` needs fixtures generated once by `scripts/verify-decode.py`
(`pip install onnx onnxruntime opencv-python-headless numpy`); the generated
fixtures are committed, so it runs without Python.

`npm run selftest` also works against a packaged build, which is the only way to
prove the shipped artifact is cross-origin isolated:

```bash
npm run package -- --platform=darwin --arch=arm64
./out/Overlay-darwin-arm64/Overlay.app/Contents/MacOS/overlay --selftest
```

Current baseline on an M-series Mac: **1.3–2.2 ms per frame** at 320×192,
4 threads, SIMD — roughly 31 ms of headroom against a 30fps budget.

## Building

```bash
npm run make -- --platform=darwin --arch=arm64
npm run make -- --platform=darwin --arch=x64
npm run make -- --platform=win32  --arch=x64
```

The Windows Squirrel installer needs Wine + Mono (`brew install --cask
wine-stable && brew install mono`). They are optional: `forge.config.ts` detects
them and drops the Squirrel maker when they are absent, leaving a portable zip,
which is a perfectly good Windows deliverable.

Signing is opt-in through `APPLE_IDENTITY` / `APPLE_API_KEY*`; without them you
get an unsigned build. On macOS that matters more than usual — see below.

---

## Layout

```
src/
  main/        lifecycle, windows, protocol, library, capture, ipc
  preload/     the entire renderer surface, over contextBridge
  shared/      types, IPC channel names, zod schemas
  worker/      yunet.ts (decode) + detector.worker.ts (ORT session)
  renderer/
    home/      the 400x620 glass window + calibration sheet
    stage/     capture -> detect -> compose
    selftest/  dev/CI integration test (ships, loads only on --selftest)
scripts/       asset pipeline, model surgery, decode verification
resources/     icons, tray glyphs, the vendored model
test/fixtures/ the reference scene and OpenCV's answers for it
```

`src/worker/yunet.ts` has no dependencies — not on ORT, not on the DOM. It is
the one file that survives a port to another runtime, which is the whole point
of keeping the decode isolated.

---

## Things that cost time, so you don't pay twice

**The upstream model has static 640×640 axes.** Not dynamic, whatever the docs
suggest. Nothing in the graph depends on that — there are no baked-in spatial
constants — so `scripts/make-dynamic.py` relaxes the declared dims once and the
result is vendored at `resources/models/yunet.onnx`. That buys 320×192 for a
16:9 source instead of padding out to a 640 square: ~3× less work per frame.
The worker also reads `inputMetadata` at runtime and obeys a pinned size if it
ever meets one, so a stock export degrades rather than breaks.

**`asar.unpack: '**/*.wasm'` silently matches nothing.** `@electron/asar`
matches with `matchBase: true` but _without_ `dot: true`, so a leading `**/`
never descends into `.vite`. The working pattern is the bare
`*.{node,wasm,onnx}` — matchBase makes it mean the same thing, and it actually
reaches dot-directories.

**ORT hangs, rather than failing, if it can't find its `.mjs` glue.** It spawns
pthread workers from that file. Under a custom protocol it cannot guess the URL,
and `InferenceSession.create` simply never settles — no error, no rejection.
Set _both_ halves of `wasmPaths`:

```ts
ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: mjsUrl };
```

**Serve the renderer through `fs`, not `net.fetch('file://…')`.** Electron
patches `fs` to read inside asar archives and to redirect `app.asar/x` to
`app.asar.unpacked/x`; the file:// network stack does neither. `.wasm` also has
to be served as `application/wasm` or `instantiateStreaming` refuses it. Both
failures look like a hang.

**Desktop `getUserMedia` does not reject without Screen Recording permission on
macOS — it hangs.** Main pre-flights the permission and refuses to open a stage
window it knows cannot capture; the stage also has a 10s timeout as a backstop.
Note the grant is tied to the code signature and **resets every time the
signature changes**, so expect to re-approve on every unsigned dev build.

**Cross-origin isolation is load-bearing.** Without COOP/COEP there is no
`SharedArrayBuffer`, and ORT drops to one thread — a working app at a third of
the speed, with nothing to tell you why. Dev gets the headers from Vite's
server, production from the `app://` handler in `src/main/protocol.ts`. The
self-test asserts it in both.

---

## Known blind spots

These are properties of the platforms, not bugs:

- DRM surfaces (Netflix, some banking apps) capture as black on both platforms.
- macOS drops screen capture on fast user switching; the stream just ends. The
  stage listens for that and reports it.
- `backgroundMaterial` (acrylic) needs Windows 11 build 22621+. On Windows 10 it
  no-ops, so the renderer is told and the CSS falls back to a near-opaque tint.
- Detecting at 320 loses small or distant faces. That is the trade being made;
  raise `target` in `DetectorOptions` if you need them back.

## Stopping an overlay

The desktop overlay is click-through by design, which also means it cannot
catch a click on its own Stop button. Three ways out, in the order you will
reach for them:

1. **The Stop pill**, top right of the overlay. The window keeps receiving
   mouse _move_ events while ignoring clicks, so the stage hit-tests the
   pointer against the pill and asks for real mouse events back only while the
   cursor is over it. Everything else still passes through to the desktop.
2. **The panic key** — `Cmd+Shift+Escape` on macOS, `Ctrl+Alt+Shift+O` on
   Windows. Registered globally, works even if the renderer is wedged. The
   first candidate is not always available (`Ctrl+Shift+Esc` is Task Manager on
   Windows), so the accelerator that actually took is shown on the pill and in
   the tray menu.
3. **The tray icon**, tinted with the live mode's accent — blue for camera,
   magenta for screen. Its menu has Stop and Quit.

`npm run selftest` asserts that the panic key registered and that the stop
surface is exposed, because the failure mode is an overlay you cannot dismiss.

---

## CI and releases

`.github/workflows/ci.yml` runs on every PR and push to `main`:

| Job     | Runner          | What                                                         |
| ------- | --------------- | ------------------------------------------------------------ |
| `check` | ubuntu          | `format:check`, `typecheck`, `verify:decode`                 |
| `build` | macos + windows | package, **self-test the packaged app**, make distributables |

The self-test runs against the packaged artifact rather than the source tree,
because dev and packaged fail differently — cross-origin isolation, ORT
threading and the asar paths are only real once it is packaged.

### Releasing

Versioning is automatic and driven by [Conventional
Commits](https://www.conventionalcommits.org/):

- `fix:` → patch, `feat:` → minor, `feat!:` / `BREAKING CHANGE:` → major
- `docs:`, `chore:`, `refactor:`, `ci:`, `test:` do not trigger a release

`release-please` keeps a "chore(main): release X.Y.Z" PR open on `main`,
accumulating the changelog. **Merging that PR** bumps `package.json`, writes
`CHANGELOG.md`, tags, and creates the GitHub release — which triggers the
build matrix to attach:

```
Overlay-<version>-arm64.dmg              macOS Apple Silicon
Overlay-<version>-x64.dmg                macOS Intel
Overlay-darwin-<arch>-<version>.zip      macOS, portable
Overlay-<version>-win32-x64-Setup.exe    Windows installer
Overlay-win32-x64-<version>.zip          Windows, portable
```

Nothing is published by pushing to `main` alone; the release PR is the gate.

**One repo setting is required:** Settings → Actions → General → Workflow
permissions → enable _"Allow GitHub Actions to create and approve pull
requests"_, or release-please cannot open its PR.

Builds are unsigned unless `APPLE_IDENTITY` (and optionally `APPLE_API_KEY`,
`APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) are set as repository secrets and
exported in the publish job. On macOS that matters more than usual: Gatekeeper
blocks unsigned apps, and the Screen Recording grant resets whenever the
signature changes.
