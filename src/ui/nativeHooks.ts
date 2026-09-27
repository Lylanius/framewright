/**
 * Wires the desktop / phone shells into the editor: native menus, "Open with",
 * window title, Android back button. Does nothing in a plain browser.
 */
import { nativeBridge } from '../platform/native';
import { saveProjectFile } from './actions';
import { popOutPreview } from './popout';
import { useApp } from './store';

let installed = false;

export function installNativeHooks(): void {
  if (installed) return;
  const native = nativeBridge();
  if (!native) return;
  installed = true;
  const st = useApp.getState;

  native.onMenu?.((cmd) => {
    const s = st();
    const inEditor = s.screen === 'editor' && !!s.project;
    switch (cmd) {
      case 'import': if (inEditor) void importViaNative(); break;
      case 'save-project-file': if (inEditor) void saveProjectFile(); break;
      case 'record-screen': if (inEditor) s.setRecorder('screen'); break;
      case 'record-camera': if (inEditor) s.setRecorder('camera'); break;
      case 'export': if (inEditor) s.setExportOpen(true); break;
      case 'close-project': if (inEditor) void s.closeProject(); break;
      case 'undo': s.undo(); break;
      case 'redo': s.redo(); break;
      case 'shortcuts': s.setShortcutsOpen(true); break;
      case 'popout-preview': if (inEditor) popOutPreview(); else s.toast('Open a project first.'); break;
    }
  });

  native.onOpenProjectFile?.((text, path) => {
    const name = path.split(/[\\/]/).pop() ?? 'project.framewright.json';
    void st().openProjectFile(new File([text], name, { type: 'application/json' }));
  });

  if (native.setTitle) {
    let last = '';
    useApp.subscribe((s) => {
      const t = s.screen === 'editor' && s.project ? s.project.name : '';
      if (t !== last) { last = t; native.setTitle!(t); }
    });
  }

  // Android back: close whatever is on top before leaving the app.
  native.onBack?.(() => {
    const s = st();
    if (s.recorder) { s.setRecorder(null); return true; }
    if (s.exportOpen) { s.setExportOpen(false); return true; }
    if (s.shortcutsOpen) { s.setShortcutsOpen(false); return true; }
    if (s.mobileSheet) { s.setMobileSheet(null); return true; }
    if (s.screen === 'editor') { void s.closeProject(); return true; }
    return false;
  });
}

/** Desktop "Import media…": the native picker, files used where they are. */
export async function importViaNative(): Promise<boolean> {
  const native = nativeBridge();
  if (!native?.openMedia) return false;
  const refs = await native.openMedia();
  if (!refs.length) return true;
  const files = refs.map((r) => ({ name: r.name, type: '', size: r.size, data: { url: r.url, size: r.size }, path: r.path }));
  await useApp.getState().importFiles(files);
  return true;
}
