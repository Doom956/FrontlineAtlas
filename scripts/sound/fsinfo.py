import sys, re, json, urllib.request, html, concurrent.futures as cf
UA = {'User-Agent': 'Mozilla/5.0'}
def info(sid):
    r = urllib.request.urlopen(urllib.request.Request(f'https://freesound.org/s/{sid}/', headers=UA), timeout=40)
    t = r.read().decode('utf-8', 'replace'); url = r.geturl()
    g = lambda pat: (re.search(pat, t, re.S) or [None, ''])[1]
    lic = g(r'href="(https?://creativecommons.org/[^"]+)"')
    desc = html.unescape(re.sub(r'<[^>]+>', ' ', g(r'id="soundDescriptionSection"[^>]*>(.*?)</div>')))
    desc = re.sub(r'\s+', ' ', desc).strip()
    tags = re.findall(r'href="/browse/tags/([^/"]+)/', t)
    return dict(id=sid, url=url, title=html.unescape(g(r'data-title="([^"]*)"')), user=url.split('/people/')[1].split('/')[0] if '/people/' in url else '',
                dur=float(g(r'data-duration="([^"]*)"') or 0), lic=lic, mp3=g(r'data-mp3="([^"]+)"').replace('-lq.mp3', '-hq.mp3'),
                desc=desc[:400], tags=sorted(set(tags))[:25])
ids = sys.argv[2:]
with cf.ThreadPoolExecutor(4) as ex: res = list(ex.map(info, ids))
json.dump({r['id']: r for r in res}, open(sys.argv[1], 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
for r in res: print(f"{r['id']:>7} {r['user'][:16]:16} {r['lic'][-22:]:22} {r['title'][:40]:40} | {r['desc'][:150]}")
