"""Restore the traffic RKNN from verified parts without replacing other models."""
from pathlib import Path
import argparse, hashlib, json, os, tempfile

root=Path(__file__).resolve().parent.parent
source=root/'rk3568/app/model/traffic_rk3568_fp16.rknn.parts'
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output',type=Path,help='Optional output path; defaults to the model directory.')
args=parser.parse_args()
manifest=json.loads((source/'manifest.json').read_text(encoding='utf-8'))
output=args.output or source.parent/manifest['target']
def digest(path):
 h=hashlib.sha256()
 with path.open('rb') as f:
  for data in iter(lambda:f.read(1024*1024),b''):h.update(data)
 return h.hexdigest()
if output.exists():
 if output.stat().st_size==manifest['bytes'] and digest(output)==manifest['sha256']:
  print('Already verified:',output)
  raise SystemExit(0)
 raise SystemExit('Refusing to overwrite a different existing model: '+str(output))
output.parent.mkdir(parents=True,exist_ok=True)
fd,name=tempfile.mkstemp(prefix='traffic_restore_',suffix='.tmp',dir=output.parent)
temp=Path(name)
try:
 total=0;whole=hashlib.sha256()
 with os.fdopen(fd,'wb') as f:
  for row in manifest['parts']:
   name=row['file']
   if Path(name).name!=name:raise ValueError('Invalid part filename')
   data=(source/name).read_bytes()
   if len(data)!=row['bytes'] or hashlib.sha256(data).hexdigest()!=row['sha256']:
    raise ValueError('Part checksum mismatch: '+name)
   f.write(data);whole.update(data);total+=len(data)
 if total!=manifest['bytes'] or whole.hexdigest()!=manifest['sha256']:
  raise ValueError('Complete model checksum mismatch')
 if output.exists():raise FileExistsError('Output appeared while restoring; refusing replacement')
 os.replace(temp,output)
 print('Restored and SHA-256 verified:',output)
 print(manifest['sha256'])
finally:
 if temp.exists():temp.unlink()
