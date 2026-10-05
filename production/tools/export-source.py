"""Export the audited Git index, never untracked files or local game assets."""
from pathlib import Path
import hashlib
import json
import subprocess
import sys
import zipfile

root = Path(__file__).resolve().parents[2]
target = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root.parent / 'webgal-screenplay-compiler-0.2.0-source.zip'
if target.exists():
    raise SystemExit('Refusing to overwrite an existing source archive')
subprocess.run(['node', 'production/tools/audit-source.mjs'], cwd=root, check=True)
names = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode('utf-8').split('\0')
manifest = []
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in filter(None, names):
        data = subprocess.check_output(['git', 'show', ':' + name], cwd=root)
        info = zipfile.ZipInfo('webgal-screenplay-compiler/' + name, (2026, 10, 5, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, data)
        manifest.append({'file': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    info = zipfile.ZipInfo('webgal-screenplay-compiler/SOURCE-MANIFEST.json', (2026, 10, 5, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    archive.writestr(info, json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
with zipfile.ZipFile(target) as archive:
    if archive.testzip() is not None:
        raise SystemExit('Archive CRC verification failed')
checksum = hashlib.sha256(target.read_bytes()).hexdigest()
target.with_suffix(target.suffix + '.sha256').write_text(checksum + '  ' + target.name + '\n', encoding='utf-8')
print(json.dumps({'files': len(manifest), 'bytes': target.stat().st_size, 'sha256': checksum}))
