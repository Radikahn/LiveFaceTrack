import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import fs from 'node:fs';
import path from 'node:path';

const hasIcons = fs.existsSync(path.join(__dirname, 'resources/icon.icns'));
const signing = Boolean(process.env.APPLE_IDENTITY);

/**
 * §7: Squirrel's installer tooling needs Mono, and rcedit (which stamps the
 * icon and version metadata into the .exe) needs Wine. Both are optional --
 * maker-zip produces a perfectly good portable Windows build without either,
 * and Wine under Rosetta is the flakiest thing in the whole toolchain. So the
 * Squirrel maker is included only when the tools are actually present.
 */
function has(cmd: string): boolean {
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .some((dir) => dir && fs.existsSync(path.join(dir, cmd)));
}
const canBuildSquirrel =
  process.platform === 'win32' || ((has('wine') || has('wine64')) && has('mono'));

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Overlay',
    // Lowercase on every target: this is evaluated on the build host, so a
    // platform check here would describe the wrong machine.
    executableName: 'overlay',
    appBundleId: 'dev.radikahn.overlay',
    appCategoryType: 'public.app-category.video',
    // ORT's WASM loader and the ONNX model reader both go through paths that
    // cannot read inside an asar archive (§7). The failure looks like a
    // "failed to fetch", not a file-not-found, so unpack them up front.
    //
    // Note the missing `**/` the docs would lead you to write: @electron/asar
    // matches with `matchBase: true` but *without* `dot: true`, so a pattern
    // with a leading `**/` never descends into `.vite`. A bare basename glob
    // does, and matchBase makes it mean the same thing.
    asar: { unpack: '*.{node,wasm,onnx}' },
    // Icons and tray glyphs the main process reads at runtime.
    extraResource: [
      './resources/trayTemplate.png',
      './resources/trayTemplate@2x.png',
      './resources/tray-camera.png',
      './resources/tray-camera@2x.png',
      './resources/tray-screen.png',
      './resources/tray-screen@2x.png',
    ],
    ...(hasIcons ? { icon: './resources/icon' } : {}),
    extendInfo: {
      NSCameraUsageDescription:
        'Overlay reads your camera so it can place your PNGs on the faces it finds. Video never leaves this machine.',
      NSMicrophoneUsageDescription: 'Overlay does not record audio.',
      LSMinimumSystemVersion: '12.0.0',
    },
    ...(signing
      ? {
          osxSign: {
            identity: process.env.APPLE_IDENTITY,
            optionsForFile: () => ({
              entitlements: 'build/entitlements.mac.plist',
              hardenedRuntime: true,
            }),
          },
          osxNotarize: process.env.APPLE_API_KEY
            ? {
                appleApiKey: process.env.APPLE_API_KEY,
                appleApiKeyId: process.env.APPLE_API_KEY_ID!,
                appleApiIssuer: process.env.APPLE_API_ISSUER!,
              }
            : undefined,
        }
      : {}),
  },
  rebuildConfig: {},
  makers: [
    new MakerDMG({ format: 'ULFO' }, ['darwin']),
    // Also the no-Wine Windows fallback: a portable zip is a fine deliverable.
    new MakerZIP({}, ['darwin', 'win32']),
    ...(canBuildSquirrel
      ? [
          new MakerSquirrel(
            {
              name: 'overlay',
              ...(hasIcons ? { setupIcon: './resources/icon.ico' } : {}),
              setupExe: 'Overlay-Setup.exe',
            },
            ['win32']
          ),
        ]
      : []),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        { entry: 'src/main/index.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload/index.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [{ name: 'app', config: 'vite.renderer.config.ts' }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
