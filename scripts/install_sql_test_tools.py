"""Install a pinned, local-only PostgreSQL WASM test engine. No production dependencies."""
import io
import json
from pathlib import Path
import tarfile
from urllib.request import urlopen

root = Path(__file__).resolve().parents[1] / '.test-tools' / 'pglite'
root.mkdir(parents=True, exist_ok=True)
version = '0.3.14'
with urlopen(f'https://registry.npmjs.org/@electric-sql/pglite/{version}') as response:
    metadata = json.load(response)
with urlopen(metadata['dist']['tarball']) as response:
    archive = response.read()
import base64
import hashlib
algorithm, expected = metadata['dist']['integrity'].split('-', 1)
if algorithm != 'sha512' or base64.b64encode(hashlib.sha512(archive).digest()).decode() != expected:
    raise RuntimeError('Test package integrity check failed.')
with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as package:
    package.extractall(root, filter='data')
print(f'Installed PGlite {version} for local SQL verification.')
