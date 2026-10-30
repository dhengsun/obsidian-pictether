import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const { version } = JSON.parse(readFileSync('manifest.json', 'utf8'));
const pkg=JSON.parse(readFileSync('package.json','utf8'));
const versions=JSON.parse(readFileSync('versions.json','utf8'));
const manifest=JSON.parse(readFileSync('manifest.json','utf8'));
if(pkg.version!==version||versions[version]!==manifest.minAppVersion)throw new Error('Package, manifest and versions.json must agree.');
execFileSync(process.execPath,['licenses.mjs'],{stdio:'inherit'});
// Python's standard library produces a deterministic file list, without package dependencies or shell interpolation.
execFileSync('python3', ['-c', `import zipfile, sys
with zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_DEFLATED) as output:
    for name in ['main.js', 'manifest.json', 'styles.css', 'README.md', 'README.zh-CN.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']:
        output.write(name, 'pictether/' + name)
`, `pictether-${version}.zip`], { stdio: 'inherit' });
console.log(`Created pictether-${version}.zip`);
