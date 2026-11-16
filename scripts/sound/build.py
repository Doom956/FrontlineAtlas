import json, os, shutil, sys, html
S, DST = sys.argv[1], sys.argv[2]
spec = json.load(open(S + '/tools/spec.json', encoding='utf-8'))
res = {r['id']: r for r in json.load(open(S + '/tools/results.json', encoding='utf-8'))}
os.makedirs(DST + '/audio', exist_ok=True)
CATS = [
 ('music-peace', 'Music: peace and menu', 'Calm, strategic orchestral music for the menu and for peace time.'),
 ('music-war', 'Music: war', 'Tense, building music for when a war is on.'),
 ('music-battle', 'Music: heavy fighting', 'Full battle music with drums and brass.'),
 ('sting-victory', 'Sting: victory', 'Short music for winning the game.'),
 ('sting-defeat', 'Sting: defeat', 'Short music for losing the game.'),
 ('sfx-artillery', 'Artillery or cannon shot', ''), ('sfx-explosion', 'Small explosion', ''), ('sfx-explosion-big', 'Big explosion', ''),
 ('sfx-atom', 'Atom bomb', 'Deep, long rumble.'), ('sfx-missile', 'Missile launch', ''), ('sfx-ship-sinking', 'Ship sinking', 'Metal creaks and water.'),
 ('sfx-ship-horn', 'Ship horn', ''), ('sfx-plane-crash', 'Plane crash', ''), ('sfx-tank-shot', 'Tank shot', ''), ('sfx-tank-destroyed', 'Tank destroyed', ''),
 ('sfx-sonar', 'Submarine sonar ping', ''), ('sfx-front-gunfire', 'Gunfire at the front', 'Distant rifles and machine guns, for a soft loop under a busy front.'),
 ('ui-click', 'Button click', ''), ('ui-error', 'Error buzz', ''), ('build-placed', 'Building placed', 'Thud or hammer.'),
 ('building-done', 'Building done', 'Short chime.'), ('research-done', 'Research done', 'Short positive sting.'),
 ('alliance-request', 'Alliance request', 'Short horn or brass.'), ('alliance-formed', 'Alliance formed', 'Short horn or brass.'),
 ('alliance-broken', 'Alliance broken', 'Short horn or brass, falling.'), ('under-attack', 'Under attack', 'Short klaxon or siren.'),
 ('city-taken', 'City or capital taken', 'Fanfare hit.'), ('capital-lost', 'Capital lost', 'Low brass or bell.'),
 ('trade-coin', 'Trade coin', ''), ('countdown', 'Countdown tick', ''), ('countdown-go', 'Countdown go', ''),
]
order = {c[0]: i for i, c in enumerate(CATS)}
PICKED = set('''music-peace-km-americana music-peace-oga-heroes-theme music-peace-oga-the-fall-of-arcana music-war-km-crusade music-war-oga-battle-theme
music-battle-km-black-vortex music-battle-km-five-armies music-battle-oga-battle-theme-a music-battle-oga-heroic-demise sting-victory-fs470083 sting-defeat-oga-the-fallen
sfx-artillery-fs239137 sfx-explosion-fs182429 sfx-explosion-big-fs741173 sfx-missile-fs854476 sfx-ship-horn-fs261846 sfx-plane-crash-fs861876 sfx-tank-shot-fs127845
sfx-tank-destroyed-fs209772 sfx-sonar-fs12677 sfx-front-gunfire-fs840492 ui-click-kenney-click3 ui-error-kenney-error-008 build-placed-fs449955 alliance-request-fs198874
alliance-broken-fs790253 city-taken-fs592096-short capital-lost-fs374271 trade-coin-fs223344 countdown-fs361783'''.split())
REDO = {'sfx-atom', 'sfx-ship-sinking', 'building-done', 'research-done', 'alliance-formed', 'under-attack', 'countdown-go'}
items = []
for o in spec:
    r = res.get(o['id'])
    if not r: continue
    shutil.copy(f"{S}/out2/{r["file"]}", f"{DST}/audio/{r['file']}")
    by = o['licence'].startswith('CC BY')
    notes = [o['note']] if o['note'] else []
    if r['cut']: notes.append(f"cut from {r['srcDur']} s" + (" with a fade-out" if o['category'].startswith(('music', 'sting')) else ''))
    if r['loop']: notes.append('short seamless loop, left untrimmed')
    if r['limited']: notes.append(f"peak-limited at -1 dBFS, so it sits at {r['lufs']} LUFS instead of the target")
    if o.get('layers') and any((l.get('site') or '').startswith('Freesound') for l in o['layers']) and not any('Freesound' in n for n in notes): notes.insert(0, 'Freesound HQ preview')
    sites = sorted(set(l.get('site') for l in (o.get('layers') or []) if l.get('site') and not l['site'].startswith('Freesound')))
    if sites: notes.insert(0, 'from ' + ', '.join(sites))
    if o.get('layers'):
        st = [f"{l['title']} from {li['start']} s" for l, li in zip(o['layers'], r.get('info') or []) if li['start']]
        if st: notes.append('cut at ' + ', '.join(st))
        if len(o['layers']) > 1: notes.append('layered mix of ' + str(len(o['layers'])) + ' recordings')
    status = 'picked' if o['id'] in PICKED else 'variant' if o.get('variantOf') else 'new' if o.get('round') == 2 else 'round1-rejected' if o['category'] in REDO else 'round1'
    srcs = o.get('layers') or [dict(title=o['title'], author=o['author'], source=o['source'], lic=(o['licence'], o['licenceUrl']), site='')]
    credits = [f'"{l["title"]}" by {l["author"]} ({l["source"]}), licensed under {l["lic"][0]} ({l["lic"][1]}); trimmed, levelled and re-encoded' for l in srcs if l['lic'][0].startswith('CC BY')]
    items.append(dict(status=status, variantOf=o.get('variantOf'), round=o.get('round', 1),
        layers=[dict(title=l['title'], author=l['author'], source=l['source'], site=l.get('site'), licence=l['lic'][0], licenceUrl=l['lic'][1], startSec=li['start'], offsetSec=l.get('offset', 0), gainDb=l.get('gainDb', 0)) for l, li in zip(o['layers'], r.get('info'))] if o.get('layers') else None,
        id=o['id'], category=o['category'], for_=o['for_'], title=o['title'], author=o['author'], source=o['source'],
        licence=o['licence'], licenceUrl=o['licenceUrl'],
        credit=(' | '.join(credits) or None),
        file='audio/' + r['file'], durationSec=r['dur'], sizeBytes=r['bytes'], loudnessLufs=r['lufs'],
        format='Ogg Opus, 48 kHz, ' + ('stereo 80 kbps' if r['channels'] == 2 else 'mono 64 kbps'), notes='; '.join(notes) or None))
RANK = {'picked': 0, 'new': 2, 'round1': 3, 'round1-rejected': 4}
items.sort(key=lambda x: (order[x['category']], RANK.get(x['status'], 1), x['variantOf'] or x['id'], x['id']))
for x in items: x['for'] = x.pop('for_')
total = sum(x['sizeBytes'] for x in items)
man = dict(about='Candidate sounds and music for Frontline Atlas. Real recordings and music made by people; no AI or code-generated audio. '
                 'Licences are CC0 or CC BY only (no NC, ND or SA). Play them in listen.html.',
           processing='Silence trimmed; short fade-in (5 ms) and fade-out (30 ms, longer where cut) on every effect; loudness normalised (BS.1770 integrated) to about -16 LUFS for sound effects and -20 LUFS for music, peaks capped at -1 dBFS; encoded as Ogg Opus (music 80 kbps stereo, effects 64 kbps mono). Layered candidates mix 2 or 3 recordings at the listed offsets and gains.',
           status='status: picked (owner pick), variant (another take of a picked sound, see variantOf), new (round 2 candidate), round1 (round 1, not picked), round1-rejected (round 1, group redone in round 2)',
           count=len(items), totalBytes=total, categories=[dict(id=c, name=n, about=a) for c, n, a in CATS], files=items)
json.dump(man, open(DST + '/manifest.json', 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
# credits
lines = ['Credits for the CC BY files (required if a file is used in the game):', '']
lines += [f'- {c}' for x in items if x['credit'] for c in x['credit'].split(' | ')]
lines = list(dict.fromkeys(lines))
lines += ['', 'CC0 files need no credit; their authors are listed in manifest.json.']
open(DST + '/CREDITS.md', 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
# listen page
E = html.escape
def fmt(s): return f"{int(s//60)}:{int(s%60):02d}" if s >= 60 else f"{s:.1f} s"
sec = []
for c, n, a in CATS:
    xs = [x for x in items if x['category'] == c]
    if not xs: continue
    rows = []
    for x in xs:
        badge = {'picked': '<em class="b p">Picked</em>', 'variant': '<em class="b v">Variation</em>', 'new': '<em class="b n2">New</em>', 'round1-rejected': '<em class="b r">Round 1</em>', 'round1': ''}[x['status']]
        rows.append(f'''<li class="c{' var' if x['status'] == 'variant' else ''}{' pk' if x['status'] == 'picked' else ''}"><div class="t">{badge}<b>{E(x['title'])}</b><span>by {E(x['author'])}</span></div>
<audio controls preload="none" src="{E(x['file'])}"></audio>
<div class="m"><span>For: {E(x['for'])}</span><span>{fmt(x['durationSec'])}</span><span>{x['sizeBytes']//1024} KB</span>
<a href="{E(x['licenceUrl'])}" target="_blank" rel="noopener">{E(x['licence'])}</a><a href="{E(x['source'])}" target="_blank" rel="noopener">Source</a>
<code>{E(x['id'])}</code></div>{f'<div class="n">{E(x["notes"])}</div>' if x['notes'] else ''}</li>''')
    sec.append(f'<section><h2>{E(n)} <small>{len(xs)} files</small></h2>{f"<p>{E(a)}</p>" if a else ""}<ul>{"".join(rows)}</ul></section>')
nav = ''.join(f'<a href="#{c}">{E(n)}</a>' for c, n, a in CATS if any(x['category'] == c for x in items))
sec = [s.replace('<section>', f'<section id="{c}">', 1) for s, (c, n, a) in zip(sec, [c for c in CATS if any(x['category'] == c[0] for x in items)])]
page = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sound Candidates</title><style>
:root{{--bg:#101418;--card:#1a2027;--line:#2b333c;--text:#e7ecf0;--dim:#9aa7b2;--acc:#5fc4b8}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,sans-serif}}
main{{max-width:960px;margin:0 auto;padding:24px 16px 64px}}h1{{margin:0 0 6px;font-size:26px}}header p{{color:var(--dim);margin:4px 0}}
nav{{display:flex;flex-wrap:wrap;gap:6px;margin:16px 0 8px}}nav a{{color:var(--text);background:var(--card);border:1px solid var(--line);border-radius:6px;padding:4px 9px;text-decoration:none;font-size:13px}}
h2{{font-size:19px;margin:30px 0 4px;border-bottom:1px solid var(--line);padding-bottom:6px}}h2 small{{color:var(--dim);font-weight:400;font-size:13px}}
section>p{{color:var(--dim);margin:4px 0 10px}}ul{{list-style:none;padding:0;margin:0;display:grid;gap:10px}}
.c{{min-width:0;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}}.t{{overflow-wrap:anywhere;min-width:0;display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}}.t span{{color:var(--dim)}}
audio{{width:100%;margin:8px 0 6px;height:36px}}.m{{display:flex;flex-wrap:wrap;overflow-wrap:anywhere;gap:6px 14px;font-size:13px;color:var(--dim)}}.m a{{color:var(--acc)}}
code{{overflow-wrap:anywhere;font-size:12px;color:var(--dim)}}
.var{{margin-left:28px;border-left:3px solid var(--acc)}}.pk{{border-color:var(--acc)}}.b{{font-style:normal;font-size:11px;font-weight:600;border-radius:4px;padding:1px 6px;margin-right:2px}}
.b.p{{background:var(--acc);color:#0b1a18}}.b.v{{border:1px solid var(--acc);color:var(--acc)}}.b.n2{{background:#e0b44c;color:#1d1505}}.b.r{{border:1px solid var(--line);color:var(--dim)}}
@media (max-width:600px){{.var{{margin-left:12px}}}}.n{{overflow-wrap:anywhere;font-size:12px;color:var(--dim);margin-top:4px}}
</style></head><body><main><header><h1>Frontline Atlas: sound candidates</h1>
<p>{len(items)} candidates, {total/1048576:.1f} MB in all. Real recordings and music made by people, CC0 or CC BY only. Pick one or more per group by ear.</p>
<p>Round 2: the owner's picks are marked <em class="b p">Picked</em>, with their extra takes indented under them as <em class="b v">Variation</em>. New candidates for the groups that were redone are marked <em class="b n2">New</em>. Round 1 files are kept below them.</p><p>Each file is trimmed and levelled (sound effects about -16 LUFS, music about -20 LUFS), given a short fade at both ends, and encoded as Ogg Opus. Plays in Chrome, Edge and Firefox, and in Safari 17 or newer. Licence, source and the slot each one is for are under each player.</p>
</header><nav>{nav}</nav>{''.join(sec)}</main></body></html>'''
open(DST + '/listen.html', 'w', encoding='utf-8').write(page)
print(len(items), 'items', total, 'bytes')
