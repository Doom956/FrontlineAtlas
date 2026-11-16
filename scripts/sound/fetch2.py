import json, os, sys, urllib.request, urllib.error, shutil, zipfile, fnmatch, io, glob, time
S = sys.argv[1]; D = S + '/dl/lay'; os.makedirs(D, exist_ok=True)
spec = json.load(open(S + '/tools/spec.json', encoding='utf-8'))
L = {}
for o in spec:
    for l in o.get('layers') or []: L[l['key']] = l
cache = {}
for k, l in sorted(L.items()):
    if glob.glob(f'{D}/{k}.*'): continue
    src = l['src']
    try:
        if src.startswith('kenney/'):
            h = glob.glob(f"{S}/dl/{src}/**/{l['member']}", recursive=True)[0]; shutil.copy(h, f'{D}/{k}{os.path.splitext(h)[1]}'); print('ok', k); continue
        ua = {'User-Agent': 'sound-sourcing-script/1.0 (generic client)'} if 'wikimedia' in src else {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://soundbible.com/' if 'soundbible' in src else 'https://freesound.org/'}
        src = src.split('?utm_')[0]
        if src not in cache:
            for t in range(5):
                try:
                    if 'wikimedia' in src: time.sleep(25 + 40 * t)
                    cache[src] = urllib.request.urlopen(urllib.request.Request(src, headers=ua), timeout=180).read(); break
                except urllib.error.HTTPError as e:
                    if e.code != 429 or t == 4: raise
        data = cache[src]; ext = os.path.splitext(src.split('?')[0])[1].lower()
        if ext == '.zip':
            z = zipfile.ZipFile(io.BytesIO(data)); names = sorted(n for n in z.namelist() if fnmatch.fnmatch(os.path.basename(n), l['member']))
            print('  zip members', l['member'], names[:5]); data = z.read(names[0]); ext = os.path.splitext(names[0])[1].lower()
        open(f'{D}/{k}{ext}', 'wb').write(data); print('ok', k, len(data) // 1024, 'KB')
    except Exception as e: print('FAIL', k, src, e)
