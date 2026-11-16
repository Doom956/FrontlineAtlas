import sys, re, urllib.request, urllib.parse, html, json
UA = {'User-Agent': 'Mozilla/5.0'}
def search(q, lic='Creative Commons 0', n=10, maxdur=None, user=None):
    f = (f'license:"{lic}"' if lic else '') + (f' duration:[0 TO {maxdur}]' if maxdur else '') + (f' username:"{user}"' if user else '')
    u = 'https://freesound.org/search/?' + urllib.parse.urlencode({'q': q, 'f': f, 's': 'Num downloads (most first)'})
    t = urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=40).read().decode('utf-8', 'replace')
    out = []
    for blk in t.split('data-sound-id="')[1:]:
        sid = blk.split('"')[0]
        g = lambda k: (re.search(k + r'="([^"]*)"', blk) or [None, ''])[1]
        user = (re.search(r'href="/people/([^/]+)/sounds/' + sid, blk) or [None, ''])[1]
        lic_ = (re.search(r'title="License: ([^"]+)"', blk) or [None, ''])[1]
        out.append(dict(id=sid, user=user, title=html.unescape(g('data-title')), dur=round(float(g('data-duration') or 0), 2),
                        dl=int(g('data-num-downloads') or 0), lic=lic_, mp3=g('data-mp3').replace('-lq.mp3', '-hq.mp3')))
        if len(out) >= n: break
    return out
if __name__ == '__main__':
    lic = 'Creative Commons 0'; user = None; n = 10
    for q in sys.argv[1:]:
        if q.startswith('LIC='): lic = q[4:]; continue
        if q.startswith('USER='): user = q[5:] or None; continue
        if q.startswith('N='): n = int(q[2:]); continue
        md = None
        if '@' in q: q, md = q.split('@')
        print('###', q, md or '', lic, user or '')
        for r in search(q, lic, n=n, maxdur=md, user=user):
            print(f"  {r['id']:>7} {r['dur']:>7}s {r['dl']:>6}dl  {r['user'][:18]:18} {r['lic'][:12]:12} {r['title'][:60]}")
