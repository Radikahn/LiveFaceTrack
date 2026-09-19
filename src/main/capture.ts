import { desktopCapturer, shell, systemPreferences } from 'electron';
import type { Permissions, PermissionState, ScreenSource } from '@shared/types';

const isMac = process.platform === 'darwin';

/**
 * §4. macOS gates both camera and screen recording; Windows gates neither for
 * screen, and handles camera through Settings -> Privacy (getUserMedia simply
 * rejects with NotAllowedError when it is off, so there is nothing to check up
 * front there).
 */
export function permissions(): Permissions {
  if (!isMac) {
    return { camera: 'unknown', screen: 'granted' };
  }
  return {
    camera: systemPreferences.getMediaAccessStatus('camera') as PermissionState,
    screen: systemPreferences.getMediaAccessStatus('screen') as PermissionState,
  };
}

/** The one macOS permission that can actually be prompted for. */
export async function requestCamera(): Promise<boolean> {
  if (!isMac) return true;
  if (systemPreferences.getMediaAccessStatus('camera') === 'granted') return true;
  return systemPreferences.askForMediaAccess('camera');
}

/**
 * Screen Recording cannot be prompted programmatically, so we deep-link the
 * settings pane instead. Note the grant is tied to the code signature and
 * resets whenever it changes -- expect to re-approve every unsigned dev build.
 */
export async function openScreenSettings(): Promise<void> {
  if (isMac) {
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    );
  } else if (process.platform === 'win32') {
    await shell.openExternal('ms-settings:privacy-webcam');
  }
}

export async function sources(): Promise<ScreenSource[]> {
  const found = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: false,
  });
  return found.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
    displayId: s.display_id,
  }));
}
