import sys, json, urllib.request, urllib.error, urllib.parse, re, os
sys.stdout.reconfigure(encoding='utf-8')
DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'dl', 'meta', 'wmc.json')
seen = json.load(open(DB, encoding='utf-8')) if os.path.exists(DB) else {}
UA = {'User-Agent': 'sound-sourcing-script/1.0 (generic client)'}
def get(params):
    u = 'https://commons.wikimedia.org/w/api.php?' + urllib.parse.urlencode({**params, 'format': 'json'})
    import time
    for k in range(6):
        try:
            time.sleep(4); return json.load(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=40))
        except urllib.error.HTTPError as e:
            if e.code != 429: raise
            time.sleep(20 * (k + 1))
    raise SystemExit('rate limited')
for q in sys.argv[1:]:
    r = get({'action': 'query', 'generator': 'search', 'gsrnamespace': 6, 'gsrsearch': q + ' filetype:audio', 'gsrlimit': 30,
             'prop': 'imageinfo', 'iiprop': 'url|size|mime|extmetadata|mediatype', 'iiextmetadatafilter': 'LicenseShortName|Artist|ObjectName'})
    print('###', q)
    for p in (r.get('query', {}).get('pages', {}) or {}).values():
        ii = p['imageinfo'][0]; m = ii.get('extmetadata', {})
        lic = m.get('LicenseShortName', {}).get('value', '?')
        art = re.sub('<[^>]+>', '', m.get('Artist', {}).get('value', '?'))[:50].strip()
        dur = ii.get('duration')
        if not re.search(r'public domain|^cc0|^cc by \d|^cc-by-\d|^pd', lic.lower()) or 'sa' in lic.lower().split(): continue
        seen[p['title']] = dict(title=p['title'], url=ii['url'], page=ii.get('descriptionurl'), lic=lic, artist=art)
        print(f"  {p['title'][5:][:70]:70} | {lic:16} | {art:30} | {ii['size']//1024}KB")
json.dump(seen, open(DB, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
