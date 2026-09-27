import type { CapacitorConfig } from '@capacitor/cli';

// Phone apps: the same web build (dist/) inside a native shell. See docs/NATIVE.md.
const config: CapacitorConfig = {
  appId: 'app.framewright.editor',
  appName: 'Framewright',
  webDir: 'dist',
  backgroundColor: '#0b0d12',
  android: { allowMixedContent: false, webContentsDebuggingEnabled: false },
  ios: { contentInset: 'never', backgroundColor: '#0b0d12', limitsNavigationsToAppBoundDomains: false },
  plugins: { KeepAwake: {} },
};

export default config;
