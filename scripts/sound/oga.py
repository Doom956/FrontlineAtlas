import sys, re, urllib.request, html
for slug in sys.argv[1:]:
    u = 'https://opengameart.org/content/' + slug
    t = urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=30).read().decode('utf-8', 'replace')
    author = re.findall(r"field-name-author-submitter.*?<a href=.[^>]*>([^<]+)</a>", t, re.S)[:1]
    lic = sorted(set(re.findall(r"class=.license-name.>([^<]+)", t)))
    files = re.findall(r'href="(https://opengameart.org/sites/default/files/[^"]+\.(?:mp3|ogg|wav|flac|zip))"', t)
    tags = re.findall(r'href="/art-search-advanced\?field_art_tags_tid=[^"]+"[^>]*>([^<]+)', t)
    body = re.findall(r'field-name-body.*?<p>(.*?)</p>', t, re.S)[:1]
    print('==', slug, '|', author, '|', lic)
    print('   tags:', ', '.join(tags)[:200])
    print('   body:', html.unescape(re.sub('<[^>]+>', '', body[0]))[:240] if body else '')
    for f in sorted(set(files)): print('   ', f)
