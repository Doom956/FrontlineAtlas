import json, os, sys, urllib.request, shutil, zipfile, fnmatch, io, glob, concurrent.futures as cf
S = sys.argv[1]; D = S + '/dl/src'; os.makedirs(D, exist_ok=True)
spec = [o for o in json.load(open(S + '/tools/spec.json', encoding='utf-8')) if len(sys.argv) < 3 or sys.argv[2] in o['id']]
UA = {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://freesound.org/'}
def one(o):
    src = o['src']
    if src.startswith('kenney/'):
        hits = glob.glob(f"{S}/dl/{src}/**/{o['member']}", recursive=True)
        ext = os.path.splitext(hits[0])[1]; dst = f"{D}/{o['id']}{ext}"; shutil.copy(hits[0], dst); return o['id'], os.path.getsize(dst)
    ext = os.path.splitext(src.split('?')[0])[1].lower()
    data = urllib.request.urlopen(urllib.request.Request(src, headers=UA), timeout=120).read()
    if ext == '.zip':
        z = zipfile.ZipFile(io.BytesIO(data)); names = [n for n in z.namelist() if fnmatch.fnmatch(n.lower(), o['member'])]
        data = z.read(names[0]); ext = os.path.splitext(names[0])[1].lower(); o['zipMember'] = names[0]
    dst = f"{D}/{o['id']}{ext}"; open(dst, 'wb').write(data); return o['id'], len(data)
with cf.ThreadPoolExecutor(4) as ex:
    futs = {ex.submit(one, o): o for o in spec}
    for f in cf.as_completed(futs):
        try: i, n = f.result(); print(f'{n//1024:>6}KB {i}')
        except Exception as e: print('FAIL', futs[f]['id'], e)
