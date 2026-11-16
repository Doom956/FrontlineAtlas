import json, glob, os, sys, re
S = sys.argv[1]
FS = {}
for f in glob.glob(S + '/dl/meta/fs*.json'): FS.update(json.load(open(f, encoding='utf-8')))
CC0 = ('CC0 1.0', 'https://creativecommons.org/publicdomain/zero/1.0/')
BY3 = ('CC BY 3.0', 'https://creativecommons.org/licenses/by/3.0/')
BY4 = ('CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/')
out = []
def add(cat, for_, id_, title, author, page, lic, src, maxs, start=0.0, member=None, note=''):
    out.append(dict(id=id_, category=cat, for_=for_, title=title, author=author, source=page, licence=lic[0], licenceUrl=lic[1],
                    src=src, member=member, start=start, max=maxs, note=note))
def fs(cat, for_, sid, maxs, start=0.0, note=''):
    r = FS[str(sid)]
    lic = CC0 if 'zero' in r['lic'] else BY4 if '4.0' in r['lic'] else BY3
    add(cat, for_, f"{cat}-fs{sid}", r['title'].rsplit('.', 1)[0] if r['title'].lower().endswith(('.wav', '.mp3', '.flac', '.ogg', '.aif', '.aiff')) else r['title'],
        r['user'].replace('%20', ' '), r['url'], lic, r['mp3'], maxs, start, note=note or 'Freesound HQ preview')
def km(cat, for_, title, fn, isrc, maxs, start=0.0):
    add(cat, for_, f"{cat}-km-{fn[:-4].lower().replace(' ', '-')}", title, 'Kevin MacLeod (incompetech.com)',
        f'https://incompetech.com/music/royalty-free/index.html?isrc={isrc}', BY4,
        'https://incompetech.com/music/royalty-free/mp3-royaltyfree/' + fn.replace(' ', '%20'), maxs, start)
def oga(cat, for_, slug, title, author, lic, src, maxs, start=0.0, member=None):
    add(cat, for_, f"{cat}-oga-" + re.sub(r'[^a-z0-9]+', '-', title.lower().split(' (')[0]).strip('-'), title, author, 'https://opengameart.org/content/' + slug, lic, src, maxs, start, member)
def ken(cat, for_, pack, fn, maxs, start=0.0):
    add(cat, for_, f"{cat}-kenney-{fn[:-4].lower().replace('_', '-')}", f"{pack.replace('-', ' ').title()}: {fn[:-4]}", 'Kenney (kenney.nl)',
        f'https://kenney.nl/assets/{pack}', CC0, f'kenney/{pack}', maxs, start, member=fn)
O = 'https://opengameart.org/sites/default/files/'
# ---- music (max 180 s)
km('music-peace', 'music.peace', 'Crossing the Divide', 'Crossing the Divide.mp3', 'USUAN1400034', 180)
km('music-peace', 'music.peace', 'Americana', 'Americana.mp3', 'USUAN1200092', 180)
oga('music-peace', 'music.peace', 'heroes-theme', 'Heroes Theme', 'Alexandr Zhelanov', BY3, O + 'Heroes%20Theme_0.mp3', 180)
oga('music-peace', 'music.menu', 'the-fall-of-arcana-epic-game-theme-music', 'The Fall of Arcana', 'Matthew Pablo', BY3, O + 'The%20Fall%20of%20Arcana_0.mp3', 180)
km('music-war', 'music.war', 'Crusade', 'Crusade.mp3', 'USUAN1100884', 180)
km('music-war', 'music.war', 'Minima', 'Minima.mp3', 'USUAN1200053', 180)
km('music-war', 'music.war', 'Lost Frontier', 'Lost Frontier.mp3', 'USUAN1300039', 180)
oga('music-war', 'music.war', 'battle-theme-0', 'Battle Theme', 'Wolfgang_', CC0, O + 'Battle.mp3', 180)
km('music-battle', 'music.battle', 'Five Armies', 'Five Armies.mp3', 'USUAN1100875', 180)
km('music-battle', 'music.battle', 'Black Vortex', 'Black Vortex.mp3', 'USUAN1300037', 180)
oga('music-battle', 'music.battle', 'battle-theme-a', 'Battle Theme A', 'cynicmusic', CC0, O + 'battleThemeA.mp3', 180)
oga('music-battle', 'music.battle', 'heroic-demise-updated-version', 'Heroic Demise (Updated Version)', 'Matthew Pablo', BY3, O + 'Heroic%20Demise%20%28New%29_0.mp3', 180)
oga('music-battle', 'music.battle', 'battle-march-epic-orchestral-music-loop', 'Battle March (short loop)', 'PlayOnLoop', BY3, O + 'POL-battle-march-short_0.wav', 180)
# ---- stings (max 10 s)
oga('sting-victory', 'victory', 'victory-fanfare-short', 'Victory Fanfare Short', 'cynicmusic', CC0, O + 'Heavy_ConceptB.wav', 10)
oga('sting-victory', 'victory', 'victory-theme-for-rpg', 'Victory Theme for RPG (opening)', 'cynicmusic', CC0, O + 'Victory1_1.mp3', 10)
fs('sting-victory', 'victory', 470083, 10, note='Freesound HQ preview; composed and orchestrated by the author')
km('sting-victory', 'victory', 'Discovery Hit', 'Discovery Hit.mp3', 'USUAN1300023', 10)
oga('sting-defeat', 'defeat', 'the-fallen-rpg-orchestral-essentials-defeated-music', 'The Fallen (opening)', 'InspectorJ', BY3, O + 'The%20Fallen%20MP3_0.zip', 10, member='*.mp3')
oga('sting-defeat', 'defeat', 'medieval-defeat-theme', 'Medieval: Defeat Theme', 'RandomMind', CC0, O + 'defeat_0.mp3', 10)
km('sting-defeat', 'defeat', 'Taps v2 (opening)', 'Taps v2.mp3', 'USUAN1100861', 10)
# ---- sound effects
for i in (702245, 184365, 239137): fs('sfx-artillery', 'shot (artillery / bombard)', i, 2.5)
for i in (182429, 182431, 336011): fs('sfx-explosion', 'explosion', i, 1.6)
for i in (741174, 741173, 563010): fs('sfx-explosion-big', 'explosionBig (new)', i, 3.5)
for i in (322365, 741175): fs('sfx-atom', 'atomBomb', i, 8)
for i in (854476, 151858, 521377): fs('sfx-missile', 'missileLaunch', i, 2.5)
for i in (238289, 119468, 442773): fs('sfx-ship-sinking', 'shipSunk', i, 2.5)
for i in (636075, 261847, 261846): fs('sfx-ship-horn', 'shipHorn', i, 3)
for i in (668549, 184947, 861876): fs('sfx-plane-crash', 'planeCrash (new)', i, 3)
for i in (127845, 854186, 448002): fs('sfx-tank-shot', 'tankShot (new)', i, 2)
for i in (209772, 587887): fs('sfx-tank-destroyed', 'tankDestroyed (new) / unitLost', i, 2)
ken('sfx-tank-destroyed', 'tankDestroyed (new) / unitLost', 'sci-fi-sounds', 'explosionCrunch_000.ogg', 2)
for i in (12677, 493162, 70299): fs('sfx-sonar', 'sonarPing (new)', i, 3)
for i in (840492, 855244, 854635): fs('sfx-front-gunfire', 'frontGunfire (new, soft loop)', i, 15)
ken('ui-click', 'uiClick', 'interface-sounds', 'click_001.ogg', 0.3)
ken('ui-click', 'uiClick', 'ui-audio', 'click3.ogg', 0.3)
ken('ui-click', 'uiClick', 'ui-audio', 'click1.ogg', 0.3)
for f in ('error_002.ogg', 'error_006.ogg', 'error_008.ogg'): ken('ui-error', 'uiError', 'interface-sounds', f, 0.6)
fs('build-placed', 'buildPlaced', 17012, 0.5)
fs('build-placed', 'buildPlaced', 449955, 0.5)
ken('build-placed', 'buildPlaced', 'impact-sounds', 'impactPlank_medium_000.ogg', 0.5)
for i in (353232, 611113, 333694): fs('building-done', 'buildingDone', i, 1.6)
for i in (592096, 578853, 397355): fs('research-done', 'researchDone', i, 2.2)
for i in (350433, 194625, 198874): fs('alliance-request', 'allianceRequest', i, 2.5)
for i in (855457, 397353): fs('alliance-formed', 'allianceFormed', i, 3)
for i in (790253, 242208, 578591): fs('alliance-broken', 'allianceBroken / allianceExpired', i, 2.5)
for i in (45933, 514982, 584001): fs('under-attack', 'underAttack', i, 1.5)
ken('city-taken', 'cityTaken / capitalTaken', 'music-jingles', 'jingles_HIT00.ogg', 2)
ken('city-taken', 'cityTaken / capitalTaken', 'music-jingles', 'jingles_HIT05.ogg', 2)
add('city-taken', 'cityTaken / capitalTaken', 'city-taken-fs592096-short', 'triumph tada horns 1 eo (first hit)', 'Empiremonkey', FS['592096']['url'], CC0, FS['592096']['mp3'], 1.2, note='Freesound HQ preview; same file as research-done, cut to the first hit')
for i in (569356, 374271): fs('capital-lost', 'capitalLost / cityLost', i, 2.5)
ken('capital-lost', 'capitalLost / cityLost', 'impact-sounds', 'impactBell_heavy_000.ogg', 2.5)
for i in (223344, 400116): fs('trade-coin', 'tradeCoin', i, 0.8)
ken('trade-coin', 'tradeCoin', 'rpg-audio', 'handleCoins.ogg', 0.8)
for i in (361783, 534094): fs('countdown', 'countdown', i, 0.3)
ken('countdown', 'countdown', 'interface-sounds', 'tick_004.ogg', 0.3)
for i in (161662, 665100): fs('countdown-go', 'countdownGo', i, 1.2)
ken('countdown-go', 'countdownGo', 'interface-sounds', 'confirmation_001.ogg', 1.2)

# ===================================================================== round 2
WM = json.load(open(S + '/dl/meta/wmc.json', encoding='utf-8'))
SB = json.load(open(S + '/dl/meta/sb.json', encoding='utf-8'))
def FSd(sid):
    r = FS[str(sid)]; lic = CC0 if 'zero' in r['lic'] else BY4 if '4.0' in r['lic'] else BY3
    t = r['title']; t = t.rsplit('.', 1)[0] if t.lower().endswith(('.wav', '.mp3', '.flac', '.ogg', '.aif', '.aiff')) else t
    return dict(key=f'fs{sid}', src=r['mp3'], member=None, title=t, author=r['user'].replace('%20', ' '), source=r['url'], lic=lic, site='Freesound (HQ preview)')
def WMd(title, author=None):
    r = WM['File:' + title]; l = r['lic'].lower()
    lic = CC0 if ('cc0' in l) else ('Public domain', 'https://en.wikipedia.org/wiki/Public_domain') if 'public' in l else BY4 if '4.0' in l else BY3
    key = 'wm-' + re.sub(r'[^a-z0-9]+', '-', title.lower().rsplit('.', 1)[0]).strip('-')[:40]
    return dict(key=key, src=r['url'], member=None, title=title.rsplit('.', 1)[0], author=author or r['artist'], source=r['page'], lic=lic, site='Wikimedia Commons')
def SBd(page, author):
    r = SB[page]; lic = ('Public domain', 'https://en.wikipedia.org/wiki/Public_domain') if r['lic'] == 'Public Domain' else BY3
    return dict(key='sb' + page.split('-')[0], src=r['mp3'].replace(' ', '%20'), member=None, title=r['title'], author=author, source=r['page'], lic=lic, site='SoundBible')
def OGAd(slug, title, author, lic, src, member=None, key=None):
    return dict(key=key or 'oga-' + slug[:30], src=src, member=member, title=title, author=author, source='https://opengameart.org/content/' + slug, lic=lic, site='OpenGameArt')
def KENd(pack, fn):
    return dict(key='kenney-' + fn[:-4].lower().replace('_', '-'), src=f'kenney/{pack}', member=fn, title=f"{pack.replace('-', ' ').title()}: {fn[:-4]}", author='Kenney (kenney.nl)', source=f'https://kenney.nl/assets/{pack}', lic=CC0, site='Kenney')
def item(cat, for_, id_, maxs, layers, variant=None, note='', title=None):
    # layers: list of (sourcedict, start, offset_s, gain_db); start may be 'oN' = N-th detected onset
    L = [dict(d, start=st, offset=off, gainDb=g) for d, st, off, g in layers]
    lic = BY4 if any(l['lic'][0] == 'CC BY 4.0' for l in L) else BY3 if any(l['lic'][0] == 'CC BY 3.0' for l in L) else L[0]['lic']
    if len(L) > 1 and lic[0] not in ('CC BY 4.0', 'CC BY 3.0'): lic = CC0 if all(l['lic'][0] == 'CC0 1.0' for l in L) else ('CC0 / public domain', 'https://creativecommons.org/publicdomain/zero/1.0/')
    out.append(dict(id=id_, category=cat, for_=for_, title=title or ' + '.join(l['title'] for l in L), author=' + '.join(dict.fromkeys(l['author'] for l in L)),
                    source=' ; '.join(l['source'] for l in L), licence=lic[0], licenceUrl=lic[1], src=None, member=None, start=0.0, max=maxs,
                    note=note, layers=L, variantOf=variant, round=2))
one = lambda d, st=0.0: [(d, st, 0.0, 0.0)]
O = 'https://opengameart.org/sites/default/files/'
# ---- new candidates for rejected groups
item('sfx-atom', 'atomBomb', 'sfx-atom-r2-qubodup-nuclear', 10, one(FSd(194623), 'o1'), note='Paulstretched mix of CC0 explosion recordings by the author')
item('sfx-atom', 'atomBomb', 'sfx-atom-r2-tnt-thunder', 10, [(FSd(165808), 'o1', 0.0, 0.0), (FSd(486557), 0.0, 0.35, -3.0)], title='TNT demolition crack + thunder rumble (layered)')
item('sfx-atom', 'atomBomb', 'sfx-atom-r2-ied-thunder', 10, [(FSd(189778), 'o1', 0.0, 0.0), (FSd(338088), 'o1', 0.25, -2.0)], title='Military IED blast + thunder clap rumble (layered)')
item('sfx-atom', 'atomBomb', 'sfx-atom-r2-windy', 10, one(FSd(182797), 'o1'), note='forced ammunition explosion, US Government footage')
item('sfx-ship-sinking', 'shipSunk', 'sfx-ship-sinking-r2-liner', 4, [(FSd(500148), 0.0, 0.0, 0.0), (FSd(439232), 0.0, 0.5, -4.0), (FSd(539823), 0.0, 1.2, -6.0)], title='Liner groans + rushing water + bubbles (layered)')
item('sfx-ship-sinking', 'shipSunk', 'sfx-ship-sinking-r2-harbour', 4, [(FSd(73257), 0.0, 0.0, 0.0), (FSd(442773), 0.0, 0.6, -4.0), (FSd(539823), 1.0, 1.4, -6.0)], title='Ship groans + big splash + bubbling (layered)')
item('sfx-ship-sinking', 'shipSunk', 'sfx-ship-sinking-r2-submarine', 4, [(SBd('1625-Submarine-Creaking.html', 'SoundBible.com'), 0.0, 0.0, 0.0), (SBd('1790-Water-Churning.html', 'Mark DiAngelo'), 0.0, 0.8, -5.0)], title='Submarine creaking + water churning (layered)')
item('sfx-ship-sinking', 'shipSunk', 'sfx-ship-sinking-r2-thimras', 4, one(OGAd('ship-sinking', 'Ship sinking', 'Thimras', CC0, O + 'ship_destroyed_0.ogg')), note='sailing ship breaking up and sinking')
item('building-done', 'buildingDone', 'building-done-r2-bell-ring', 1.8, one(WMd('Bell-ring.flac')))
item('building-done', 'buildingDone', 'building-done-r2-triangle', 1.8, one(FSd(349503)))
item('building-done', 'buildingDone', 'building-done-r2-ship-brass-bell', 1.8, one(SBd('1745-Ship-Brass-Bell.html', 'Mike Koenig')))
item('building-done', 'buildingDone', 'building-done-r2-hand-bell', 1.8, one(FSd(339818)))
item('research-done', 'researchDone', 'research-done-r2-first-sergeants-call', 2.6, one(WMd('FirstSergeantsCall.mp3')))
item('research-done', 'researchDone', 'research-done-r2-triumphal-fanfare', 2.6, one(SBd('1823-Winning-Triumphal-Fanfare.html', 'John Stracke')))
item('research-done', 'researchDone', 'research-done-r2-big-triumph', 2.6, one(FSd(592099)), note='opening of a longer tada')
item('research-done', 'researchDone', 'research-done-r2-euphonium', 2.6, one(FSd(198852)), note='opening of a longer fanfare')
item('alliance-formed', 'allianceFormed', 'alliance-formed-r2-assembly', 3, one(WMd('Assembly bugle call.ogg')), note='opening of the US Marine Corps bugle call')
item('alliance-formed', 'allianceFormed', 'alliance-formed-r2-attention', 3, one(WMd('Attention Bugle Call (US).oga')))
item('alliance-formed', 'allianceFormed', 'alliance-formed-r2-trumpet-fanfare-2', 3, one(FSd(855458)), note='military ceremony trumpet, US Government footage')
item('under-attack', 'underAttack', 'under-attack-r2-dive-klaxon', 2, one(WMd('WWII submarine dive klaxon.ogg')))
item('under-attack', 'underAttack', 'under-attack-r2-civil-defense', 2, one(WMd('Civil-defense-siren-waver.ogg'), 1.0))
item('under-attack', 'underAttack', 'under-attack-r2-motor-siren', 2, one(WMd('Motorsirene - Feuerwehralarm.ogg'), 0.5))
item('under-attack', 'underAttack', 'under-attack-r2-air-raid-test', 2, one(FSd(578987), 1.0))
item('countdown-go', 'countdownGo', 'countdown-go-r2-cannon', 1.5, one(SBd('909-Cannon.html', 'SoundBible.com')))
item('countdown-go', 'countdownGo', 'countdown-go-r2-salute-cannon', 1.5, one(WMd('01 Salute Cannon Reveille.ogg', 'Unknown (public domain)'), 'o1'))
item('countdown-go', 'countdownGo', 'countdown-go-r2-cannon-shot', 1.5, one(FSd(187767), 'o1'), note='US Government footage')
item('countdown-go', 'countdownGo', 'countdown-go-r2-hand-bell', 1.5, one(FSd(339818)), note='same hand bell as building-done-r2-hand-bell, shorter')
# ---- variants of the picked sounds
def var(picked, n, maxs, d, st=0.0, note=''):
    p = next(o for o in out if o['id'] == picked)
    item(p['category'], p['for_'], f'{picked}-v{n}', maxs, one(d, st), variant=picked, note=note)
P = 'sfx-artillery-fs239137'; var(P, 2, 2.5, FSd(239137), 'o2', 'next shot in the same recording'); var(P, 3, 2.5, FSd(182822), 'o1'); var(P, 4, 2.5, FSd(182822), 'o3'); var(P, 5, 2.5, FSd(184365), 'o2')
P = 'sfx-explosion-fs182429'; var(P, 2, 1.6, FSd(182431)); var(P, 3, 1.6, FSd(171971)); var(P, 4, 1.6, FSd(189778), 'o1'); var(P, 5, 1.6, WMd('Explosion-LS100155.ogg'))
P = 'sfx-explosion-big-fs741173'; var(P, 2, 3.5, FSd(741174)); var(P, 3, 3.5, FSd(741175)); var(P, 4, 3.5, FSd(182797), 'o1')
P = 'sfx-missile-fs854476'; var(P, 2, 2.5, FSd(182794), 'o1'); var(P, 3, 2.5, FSd(184274), 'o1'); var(P, 4, 2.5, FSd(184274), 'o3')
P = 'sfx-ship-horn-fs261846'; var(P, 2, 3, FSd(261847)); var(P, 3, 3, WMd('Cruise ship Albatros ship horn.ogg')); var(P, 4, 3, WMd('Fog signal Bremerhaven.ogg'))
P = 'sfx-plane-crash-fs861876'; var(P, 2, 3, FSd(861876), 'o2', 'another cut of the same recording'); var(P, 3, 3, FSd(184947)); var(P, 4, 3, FSd(668549))
P = 'sfx-tank-shot-fs127845'; var(P, 2, 2, FSd(239135), 'o1'); var(P, 3, 2, FSd(239135), 'o3'); var(P, 4, 2, FSd(184275), 'o1'); var(P, 5, 2, FSd(169743), 'o1')
P = 'sfx-tank-destroyed-fs209772'; var(P, 2, 2, FSd(843247)); var(P, 3, 2, FSd(843248)); var(P, 4, 2, FSd(843249))
P = 'sfx-sonar-fs12677'; var(P, 2, 3, FSd(12677), 'o2', 'second ping of the same recording'); var(P, 3, 3, FSd(493162)); var(P, 4, 3, FSd(70299)); var(P, 5, 3, OGAd('sonar-ping', 'Sonar Ping', 'Spiceman', CC0, O + 'sonar_ping_0.mp3'))
P = 'sfx-front-gunfire-fs840492'; var(P, 2, 15, FSd(205588), 5.0, 'second loop bed'); var(P, 3, 15, FSd(205588), 40.0, 'third loop bed, later in the same recording'); var(P, 4, 15, WMd('Dragout - War sounds (cc0) (freesound).ogg'), 0.0, 'fourth loop bed')
P = 'ui-click-kenney-click3'; var(P, 2, 0.3, KENd('ui-audio', 'click1.ogg')); var(P, 3, 0.3, KENd('ui-audio', 'click2.ogg')); var(P, 4, 0.3, KENd('ui-audio', 'click4.ogg'))
P = 'ui-error-kenney-error-008'; var(P, 2, 0.6, KENd('interface-sounds', 'error_007.ogg')); var(P, 3, 0.6, KENd('interface-sounds', 'error_003.ogg'))
P = 'build-placed-fs449955'; var(P, 2, 0.5, FSd(447922)); var(P, 3, 0.5, KENd('impact-sounds', 'impactPlank_medium_001.ogg')); var(P, 4, 0.5, KENd('impact-sounds', 'impactPlank_medium_002.ogg'))
P = 'alliance-request-fs198874'; var(P, 2, 2.5, WMd('FirstCall.mp3')); var(P, 3, 2.5, WMd('OfficersCall.mp3'))
P = 'alliance-broken-fs790253'; var(P, 2, 2.5, WMd('Taps on bugle.ogg'), 0.0, 'opening of Taps'); var(P, 3, 2.5, FSd(373267))
P = 'city-taken-fs592096-short'; var(P, 2, 1.2, FSd(592096), 'o2', 'another hit of the same recording'); var(P, 3, 1.2, FSd(397353), 0.0, 'related brass hit (also a round 1 allianceFormed candidate)')
P = 'capital-lost-fs374271'; var(P, 2, 2.5, FSd(374030)); var(P, 3, 2.5, FSd(373267)); var(P, 4, 2.5, WMd('25822 heigh-hoo peace-bell-hiroshima.wav'))
P = 'trade-coin-fs223344'
for n, f in ((2, '*1*.ogg'), (3, '*2*.ogg'), (4, '*3*.ogg')): var(P, n, 0.8, OGAd('coins-sounds', f'Coins sounds ({n - 1})', 'jalastram', BY3, O + 'Coins%20sounds%20%5BOGG%5D.zip', member=f, key=f'oga-jalastram-coins-{n - 1}'))
var(P, 5, 0.8, KENd('rpg-audio', 'handleCoins2.ogg'))
P = 'countdown-fs361783'; var(P, 2, 0.3, FSd(489706), 'o2', 'one tick of a mechanical clock'); var(P, 3, 0.3, FSd(489706), 'o5', 'another tick of the same clock'); var(P, 4, 0.3, FSd(534094))
ids = [o['id'] for o in out]; assert len(ids) == len(set(ids)), [i for i in ids if ids.count(i) > 1]
json.dump(out, open(S + '/tools/spec.json', 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
print(len(out), 'items')
