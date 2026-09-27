// Sets Framewright's icon and version info on the Windows .exe without Wine
// (pure JavaScript PE editing), then zips the portable build.
// Usage: node desktop/win-brand.mjs release/win-unpacked
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as ResEdit from 'resedit';
import png2icons from 'png2icons';

const dir = process.argv[2] ?? 'release/win-unpacked';
const exe = path.join(dir, 'Framewright.exe');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const ico = png2icons.createICO(fs.readFileSync('desktop/build/icon.png'), png2icons.BICUBIC2, 0, false, true);
fs.writeFileSync('desktop/build/icon.ico', ico);

const data = fs.readFileSync(exe);
const pe = ResEdit.NtExecutable.from(data, { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(pe);
const iconFile = ResEdit.Data.IconFile.from(ico);
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
const gid = groups[0]?.id ?? 1, lang = groups[0]?.lang ?? 1033;
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, gid, lang, iconFile.icons.map((i) => i.data));
const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
const [a, b, c] = pkg.version.split('.').map(Number);
vi.setFileVersion(a, b, c, 0, 1033);
vi.setProductVersion(a, b, c, 0, 1033);
vi.setStringValues({ lang: 1033, codepage: 1200 }, {
  FileDescription: 'Framewright video editor', ProductName: 'Framewright', CompanyName: 'Framewright',
  OriginalFilename: 'Framewright.exe', InternalName: 'Framewright', LegalCopyright: 'Personal use',
});
vi.outputToResourceEntries(res.entries);
res.outputResource(pe);
fs.writeFileSync(exe, Buffer.from(pe.generate()));
console.log('branded', exe);

const zip = path.resolve('release', `Framewright-Windows-Portable-${pkg.version}.zip`);
fs.rmSync(zip, { force: true });
// Zip as a "Framewright" folder so extracting doesn't spill files everywhere.
const link = path.resolve(path.dirname(dir), 'Framewright');
fs.rmSync(link, { force: true, recursive: true });
fs.symlinkSync(path.resolve(dir), link);
execFileSync('zip', ['-qr9', zip, 'Framewright'], { cwd: path.dirname(link) });
fs.rmSync(link, { force: true });
console.log('zipped', zip, (fs.statSync(zip).size / 1e6).toFixed(1), 'MB');
