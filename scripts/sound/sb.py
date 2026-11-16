import sys, re, urllib.request, urllib.parse, html, json, os, time
sys.stdout.reconfigure(encoding='utf-8')
UA = {'User-Agent': 'Mozilla/5.0'}
DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'dl', 'meta', 'sb.json')
seen = json.load(open(DB, encoding='utf-8')) if os.path.exists(DB) else {}
def get(u): time.sleep(1); return urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=40).read().decode('utf-8', 'replace')
for q in sys.argv[1:]:
    t = get('https://soundbible.com/search.php?q=' + urllib.parse.quote(q))
    print('###', q)
    for blk in t.split('data-source="')[1:]:
        mp3 = blk.split('"')[0]
        lic = (re.search(r'<h4>([^<]+)</h4>', blk) or [None, ''])[1]
        m = re.search(r"<h3><a href='([^']+)'>([^<]+)</a>", blk)
        if not m or lic not in ('Attribution 3.0', 'Public Domain'): continue
        page, title = m.group(1), html.unescape(m.group(2))
        if q.lower().split()[0] not in (title + page).lower(): continue
        seen[page] = dict(page='https://soundbible.com/' + page, title=title, lic=lic, mp3='https://soundbible.com/' + mp3)
        print(f"  {lic:16} {title[:50]:50} {page}")
json.dump(seen, open(DB, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
