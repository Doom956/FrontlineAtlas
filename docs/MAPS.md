# Real-world maps

Besides the procedural generator (`src/sim/mapgen.ts`), Frontline Atlas ships 12 maps of the real world. They are baked
offline from Natural Earth data into small compressed blobs that are bundled with the game, so no data is fetched at
runtime and every load is identical.

| id | name | size (tiles) | land tiles | spawns | single player (nations / tribes) | multiplayer | blob (gzip) |
|---|---|---|---|---|---|---|---|
| `world` | World | 2600 x 1009 | 798 422 | 40 | 5 / 200 | 10 / 90 | 99 KB |
| `europe` | Europe | 1975 x 1337 | 1 301 181 | 34 | 7 / 325 | 10 / 145 | 112 KB |
| `asia` | Asia | 1622 x 1600 | 1 315 572 | 37 | 7 / 330 | 10 / 145 | 130 KB |
| `africa` | Africa | 1493 x 1556 | 1 300 065 | 35 | 7 / 325 | 10 / 145 | 89 KB |
| `north-america` | North America | 1358 x 1600 | 876 785 | 28 | 5 / 220 | 10 / 95 | 95 KB |
| `south-america` | South America | 1075 x 1600 | 801 059 | 22 | 5 / 200 | 10 / 90 | 64 KB |
| `oceania` | Oceania | 2115 x 1600 | 860 027 | 20 | 5 / 215 | 10 / 95 | 75 KB |
| `middle-east` | Middle East | 1459 x 1281 | 1 398 283 | 25 | 8 / 350 | 10 / 155 | 97 KB |
| `mediterranean` | Mediterranean | 1823 x 978 | 1 098 233 | 28 | 6 / 275 | 10 / 120 | 95 KB |
| `british-isles` | British Isles | 1081 x 1600 | 512 418 | 18 | 5 / 130 | 10 / 55 | 50 KB |
| `east-asia` | East Asia | 1958 x 1452 | 1 501 753 | 26 | 8 / 375 | 10 / 165 | 122 KB |
| `scandinavia` | Scandinavia | 1342 x 1405 | 998 872 | 18 | 6 / 250 | 10 / 110 | 80 KB |

All 12 maps together add about **1.5 MB** to the single-file build (the blobs are base64 strings in
`src/maps/data/*.ts`, 1.08 MB of gzip data, 1.46 MB as base64, plus a ~16 KB manifest). The exact numbers are printed by the build script
and listed in `src/maps/manifest.json`.

## Data sources and licences

- **Natural Earth** 1:10m vector data (public domain): land, minor islands, lakes, physical geography regions
  (mountain ranges, plateaus, deserts, basins, plains, wetlands, deltas, tundra), glaciated areas, elevation points
  (named peaks), rivers + lake centerlines, 200 m bathymetry (continental shelf), populated places (capitals and
  cities used for the spawns). Downloaded from the Natural Earth GitHub mirror
  `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/`.
  Natural Earth is in the public domain; no permission is needed. Suggested attribution (show it in the credits /
  about screen):

  > Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com.

- **Hand-drawn supplements** (`scripts/maps/extra.ts`): rough lon/lat outlines drawn for this project from general
  geography (uplands Natural Earth has no polygon for, such as the Scottish Highlands, Wales, Norway, Iceland, the
  Japanese mountains; some extra arid or wet interiors; woodland belts such as the eastern US, Labrador and
  Fennoscandia; open farmland or treeless areas such as Jutland, East Anglia, the Northern Isles, western Anatolia; the
  outline of the cold Changtang plateau; rough onshore oil provinces). They are original to Frontline Atlas (same licence as the
  code) and are not taken from any other data set or game.
- **Climate shape** (`scripts/maps/terrain.ts`): the northern tree line by longitude and a moisture-by-latitude table
  are simple assumed curves, not measured data.

No elevation raster is used (none with a suitable licence is reachable from the build environment); relief comes from
Natural Earth's mountain range / plateau polygons, peaks and glaciers as described below.

## How a map is made (`scripts/maps/`)

1. **Projection and size.** World: equirectangular, 180 W to 180 E, 56 S to 83.7 N (Antarctica and the far Arctic
   cropped). Africa, South America, Oceania, Middle East, Mediterranean, British Isles: equirectangular with a standard
   parallel in the middle of the map (true shape there). Europe, Asia, North America, East Asia, Scandinavia: Lambert
   conformal conic. The scale is chosen so the map has about its target land tile count, within 2600 x 1600.
2. **Land / water.** Natural Earth land + minor islands, minus lakes (scanline fill at tile centres, rings clipped to
   the map and densified so clip edges follow the projection). Reservoirs only become water where they are at least
   ~6 tiles wide (long dammed rivers, such as the Brazilian ones, would cut the land apart). Natural Earth's
   "Alkaline Lake" features in Australia (Eyre, Torrens, Gairdner, Mackay, Amadeus, ...) are dry salt pans, so they
   are desert land; salt lakes that hold water (Great Salt Lake, Qinghai, Van, Urmia, Balkhash, Issyk-Kul, the Dead
   Sea, ...) stay water. Islets under ~6 tiles and ponds under ~30 tiles are dropped, one-tile spurs and notches
   smoothed.
3. **Relief.** A ruggedness field: every mountain range polygon adds a profile that rises from its rim to its core
   (higher for major ranges; old ranges such as the Appalachians or the Urals stay mostly hills), with a foothill band
   outside; plateaus add hill patches (Tibet, Altiplano, Ethiopia, Colorado more); named peaks add cones that grow
   with their height; mid-latitude glaciers mark high mountains. The field is domain-warped (no straight polygon edges),
   gets valley noise in the high ranges, then mountains = top band, hills = next band.
4. **Biomes.** Deserts from the desert / dry basin polygons and the salt pans (ragged edges); green valleys of the
   major rivers through them (Nile, Tigris, Euphrates, Indus, ...). Tundra north of the tree line, on polar glaciers /
   ice, and on the cold Changtang plateau of north-western Tibet (there even over hills; the rest of the Tibet plateau is
   hills and mountains). Swamps from wetlands, the Sudd and the deltas that are real wetlands (Danube, Niger); the
   other deltas (Nile, Ganges, Mekong, Mississippi, ...) are farmland: plains with extra fertile land. Forest vs plains
   from a moisture value (latitude belts, coast distance, rainforest basins, woodland belts, steppes, open farmland):
   forest needs moisture above a fixed threshold (the same on every map), and at most a per-map share of the plains +
   forest land is forest (default 48 %; British Isles 15 %, Scandinavia 70 %).
5. **Cleanup** (same filters as the generator): 8-neighbour majority filter, small regions merged into their
   neighbours, speckle pass.
6. **Water.** Shallow water on the continental shelf (Natural Earth 200 m depth line, at most ~160 km out) and always
   a 2-3 tile coastal band; lakes are shallow.
7. **Resources.** Same deposit placer as the generator: iron 1.5 % of land on hills / mountains; oil 0.7 % of land, of
   which at most 2.5 % of the desert / swamp / tundra tiles (so a map with little of those gets no dense oil fields)
   and the rest spread over plains, plus up to 0.4 % more inside known onshore oil provinces (no North Sea provinces:
   that oil is offshore); fertile 3 % on plains near coasts, lakes and major rivers, plus extra in farmland deltas.
   Seeded from the map id, so the output is reproducible.
8. **Spawns.** Each map lists 18-40 real countries or regions with a city looked up by name in Natural Earth's
   populated places. The spawn tile is the nearest free land tile to the city of the best terrain within 8 tiles:
   plains / forest / hills first, then desert, then tundra / swamp; mountains only if there is nothing else within 16
   tiles (a capital on mountains, 5 people per tile, would start crippled; Rome, Denver, Quito, La Paz, Xi'an, ... are
   moved a few tiles off the range). Capitals are at least 28 tiles apart (the game's largest minimum spawn distance
   is 26; the build warns otherwise, and a city was swapped where the real capitals are too close: France at Lyon on
   the world map, Estonia at Tartu on Europe, Lebanon at Tripoli and Jordan at Ma'an on the Middle East).
   The list is then put in **spread-out order**: the most populous major power first (`m(...)` in `defs.ts`), then
   again and again a spawn far from all those already chosen (of the spawns at least 0.6 x the largest such distance
   away, a major power if any, else the most populous). So any first N spawns are spread over the whole map, e.g. the
   first 10 on the world map: Japan, Mexico, Egypt, Argentina, Indonesia, United Kingdom, South Africa, Nigeria,
   Australia, United States.
9. **Presets** per map: single player (a few nations, 5-8 by land area, and many tribes to conquer for a quick game)
   and multiplayer (10 nations, players + AI, and fewer tribes).

### Rebuild

```
npx vite-node scripts/maps/build.ts              # all maps
npx vite-node scripts/maps/build.ts -- europe    # some maps (the rest of the manifest is kept)
```

The source layers are downloaded once (with `curl`) into `/tmp/borderfall-mapdata` (outside the repo). Output:
`src/maps/data/<id>.ts`, `src/maps/manifest.ts`, `src/maps/manifest.json`, and previews
`/tmp/borderfall-shots/worldmap-<id>.png` (terrain colours, resources tinted, spawns as red squares). The build is
byte-for-byte reproducible. A whole build takes about a minute.

To add a map, add an entry to `scripts/maps/defs.ts` (projection, frame, target land tiles, spawns) and rebuild.

## Blob format

gzip of: `'BFM1'`, u16 width, u16 height, u32 land tiles, u32 terrain section length, terrain RLE, resource RLE
(little endian; RLE = repeated `u8 value, varint (run - 1)` over the row-major tile array). Decoded by
`decodeWorldMapBlob` in `src/sim/worldmaps.ts` (uses `atob` and `DecompressionStream('gzip')`, available in every
current browser and in Node 18+).

## API (`src/sim/worldmaps.ts`)

```ts
listWorldMaps(): readonly WorldMapInfo[]         // menu order
getWorldMap(id): WorldMapInfo | undefined
isWorldMapId(id): boolean
worldMapSpawns(id): { name: string; tile: number }[]   // real nations at their capitals; land, unique
loadWorldMap(id): Promise<MapData>               // fresh MapData, like generateMap's result

interface WorldMapInfo {
  id: string; name: string; description: string;
  width: number; height: number; landTiles: number;
  recommendedNations: number;   // = presets.singlePlayer.nations (suggested aiCount)
  recommendedTribes: number;    // = presets.singlePlayer.tribes (suggested tribeCount)
  presets: {
    singlePlayer: { nations: number; tribes: number };  // few nations, many tribes
    multiplayer: { nations: number; tribes: number };   // 10 nations (humans count), fewer tribes
  };
  spawns: { name: string; tile: number }[];   // 18-40, spread-out order (any first N are spread over the map)
}
```

`loadWorldMap` returns new arrays every call (the decoded tiles are cached, a reload takes ~20 ms, the first load
~50-150 ms). Terrain and resources are set, `coastal` and `landTileCount` come from `computeCoastAndLand`, nothing is
owned or built, no fallout: exactly the state `generateMap` hands to `createGame`. Each map's data module is imported
lazily (`import()`); in the single-file build they are inlined like everything else.

## How the game uses them (done; DESIGN.md section 12)

1. `GameSettings.map` is `{ kind: 'generated', type, size }` or `{ kind: 'world', id }` (`setup.ts` validates the id).
   Multiplayer sends it with the other settings; both sides load the same baked map, so it stays deterministic.
2. `createGame(settings, map?, opts?)` is synchronous: the client (`main.ts`) and any multiplayer client do
   `const map = await loadWorldMap(id)` first and pass it in. A world map consumes no rng calls (the generator
   does), which is fine because every client does the same. The compact modifier uses `compactWorldMap` (half the
   width and height) and `compactWorldTile` for the spawns.
3. Spawns: AI nation k takes spawn k (`worldMapSpawns(id)`, spread-out order) with its real name; it starts there
   (`state.spawnPoints`, nearest valid tile if that one is taken or too close), unless random spawn is on. More AI
   nations than spawns: the rest get the usual names and spots. Tribes spawn as usual in the leftover space. The
   human picks a start as usual.
4. Setup screen and lobby: the map picker shows the generated types and every world map with a preview drawn from
   the map data (`src/client/mapThumbs.ts`). Defaults: 8 AI nations in single player, about 10 nations in
   multiplayer (`setup.MULTIPLAYER_NATIONS`), 300 tribes on a world map (compact: by its land). The per-map
   `presets` here are not used by the game any more (kept in the manifest).
5. Size class: `state.mapClass` = `setup.sizeClassForLand(landTiles)` (small < 400k, medium < 850k, large < 1.6M,
   else huge) for world and compact maps; it sets the start radius and building spacing.
6. Credits: show the Natural Earth attribution above.
