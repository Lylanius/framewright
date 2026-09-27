/**
 * Phone apps (iOS / Android via Capacitor). When the page runs inside the
 * native app, install `window.fwNative` with share/save, back button and
 * keep-awake. In a normal browser this does nothing.
 */
import type { NativeBridge } from './native';

export async function installCapacitorBridge(): Promise<void> {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string } }).Capacitor;
  if (!cap?.isNativePlatform?.()) return;
  const [{ Filesystem, Directory }, { Share }, { App }, { KeepAwake }] = await Promise.all([
    import('@capacitor/filesystem'), import('@capacitor/share'), import('@capacitor/app'), import('@capacitor-community/keep-awake'),
  ]);
  const platform = cap.getPlatform?.() === 'ios' ? 'ios' : 'android';
  const backHandlers: (() => boolean)[] = [];
  void App.addListener('backButton', ({ canGoBack }) => {
    for (let i = backHandlers.length - 1; i >= 0; i--) if (backHandlers[i]()) return;
    if (canGoBack) window.history.back(); else void App.minimizeApp();
  });

  const bridge: NativeBridge = {
    shell: platform,
    version: (await App.getInfo().catch(() => ({ version: '' }))).version,
    os: platform,
    async shareFile(blob: Blob, filename: string) {
      // Write in 3 MB slices so a long 4K export never becomes one giant string in memory.
      const path = `exports/${filename}`;
      const SLICE = 3 * 1024 * 1024;
      await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => undefined);
      for (let off = 0; off < Math.max(1, blob.size); off += SLICE) {
        const data = await toBase64(blob.slice(off, off + SLICE));
        if (off === 0) await Filesystem.writeFile({ path, data, directory: Directory.Cache, recursive: true });
        else await Filesystem.appendFile({ path, data, directory: Directory.Cache });
      }
      const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
      try {
        await Share.share({ title: filename, files: [uri], dialogTitle: 'Save or share your video' });
        return 'shared';
      } catch {
        return 'declined';
      }
    },
    onBack(fn) { backHandlers.push(fn); },
    // Post reminders: shown by the phone at the scheduled time, even if the app is closed.
    async notifyAt(id, at, title, body) {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      const perm = await LocalNotifications.checkPermissions();
      if (perm.display !== 'granted') await LocalNotifications.requestPermissions();
      await LocalNotifications.schedule({ notifications: [{ id, title, body, schedule: { at: new Date(at), allowWhileIdle: true } }] });
    },
    async cancelNotify(id) {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      await LocalNotifications.cancel({ notifications: [{ id }] });
    },
    async keepAwake(on) { await (on ? KeepAwake.keepAwake() : KeepAwake.allowSleep()).catch(() => undefined); },
  };
  (window as unknown as { fwNative?: NativeBridge }).fwNative = bridge;
  document.documentElement.dataset.shell = platform;
}

function toBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}
