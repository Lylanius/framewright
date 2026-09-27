# Getting Framewright on each device

Framewright is one app that runs in four "wrappers". They all have the same editor; the differences are what the device lets an app do.

| Device | Easiest way | What you get over the browser version |
|---|---|---|
| **Windows PC** | Unzip `Framewright-Windows-Portable.zip`, open the `Framewright` folder, double-click **Framewright.exe** | Files used where they are (no copies), MKV/AVI/etc. via FFmpeg, screen recording with game sound, real "Save as", second-monitor preview |
| **Linux PC** | Make `Framewright-*.AppImage` executable (right-click → Properties → "Allow executing") and double-click | Same as Windows, except computer sound can't be recorded |
| **Mac** | Build it with the recipe below (needs a Mac or GitHub), then right-click → **Open** the first time | Same as Windows (computer sound needs a recent macOS; untested) |
| **Android phone** | Install `Framewright.apk` from the recipe (allow "install unknown apps" when asked) | Save/share exports straight to Photos, TikTok, etc.; screen stays awake while exporting; back button works |
| **iPhone / iPad** | For now: open the web version in Safari → Share → **Add to Home Screen**. For the real app: the recipe's `.ipa` + Sideloadly (below) | Save Video / share sheet; screen stays awake |

## First run on Windows

The app isn't signed with a paid Microsoft certificate, so Windows says *"Windows protected your PC"*. Click **More info → Run anyway**. You only do this once.

## The build recipe (Mac, Android, iPhone and the Windows installer)

This environment can't run Apple's or Google's build tools, so there's a ready-made recipe that makes GitHub's free build machines do it:

1. Make a free GitHub account if you don't have one, and create a **private** repository (e.g. `framewright`).
2. Upload this project folder to it (GitHub Desktop is the easiest: *Add existing repository* → *Publish*).
3. In the repository, open **Actions → Build apps → Run workflow**.
4. About 20 minutes later, open the finished run and download from **Artifacts**:
   - `Framewright-Windows` — installer (`Framewright-Setup.exe`) and portable `.exe`
   - `Framewright-macOS` — `.dmg` for Apple Silicon and Intel Macs
   - `Framewright-Linux` — `.AppImage`
   - `Framewright-Android` — `Framewright.apk`
   - `Framewright-iOS` — `Framewright-unsigned.ipa`

Nothing is published anywhere; the files only appear in your private repository.

### Putting the iPhone app on your phone

Apple only lets you install your own apps by signing them with your Apple ID:

1. Install **Sideloadly** (Windows/Mac, free) and plug your iPhone in.
2. Drag `Framewright-unsigned.ipa` into Sideloadly, enter your Apple ID, press **Start**.
3. On the iPhone: Settings → General → VPN & Device Management → trust your Apple ID. Turn on Developer Mode if asked.

With a free Apple ID the app must be re-signed every 7 days (Sideloadly can do it automatically over Wi-Fi). A paid Apple Developer account (£79/year) removes that limit and allows TestFlight. The Add-to-Home-Screen web version never expires and has almost everything.

## Building on your own computer (if you prefer)

Needs Node 20+.

```bash
npm install
npm run desktop          # try the desktop app straight away
npm run desktop:win      # on Windows → release/Framewright-Setup-*.exe
npm run desktop:mac      # on a Mac   → release/*.dmg
npm run desktop:linux    # on Linux   → release/*.AppImage

npm run mobile:sync      # copy the latest web build into the phone projects
npx cap open android     # opens Android Studio → Run ▶ onto your phone
npx cap open ios         # opens Xcode (Mac only) → pick your iPhone → Run ▶
```

After changing any web code, run `npm run mobile:sync` again before rebuilding the phone apps.

## Formats the editor can't read (desktop app)

MKV, AVI, WMV, FLV, some ProRes/DNxHD and old camera formats: the desktop app converts them with **FFmpeg**. If FFmpeg isn't on your computer, Framewright asks whether to download it (about 30 MB, once). Your videos never leave your computer — only the converter program is downloaded. The converted copy lives in the app's data folder (Help → Open app data folder); your original is never changed.

## Where things are kept

| | Browser / phone | Desktop app |
|---|---|---|
| Projects | Inside the browser/app storage | Same (in the app's data folder) |
| Your media | A private copy inside the browser/app | **Not copied** — used from where it is. Move or rename a file and the app asks you to re-link it |
| Recordings | Inside the project | `Videos/Framewright Recordings` |
| Exports | Downloads / share sheet | Wherever you choose in "Save as" |
| Sync folder (optional) | Chrome/Edge on computers only | Yes — pick a folder in OneDrive/Dropbox/Drive/iCloud Drive on the home screen |
