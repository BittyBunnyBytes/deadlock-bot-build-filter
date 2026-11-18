# Bot Build Filter (Deadlock)

Hides auto-generated "win rate bot" builds from the **Public** tab of the build browser.

A build is scored on what these bots have in common:

| Signal | Points |
|---|---|
| Plugs a website (stats sites; Twitch/YouTube/Discord/X/TikTok/etc. links do **not** count) | +2 |
| Same website plugged by several accounts in the list | +1 |
| Templated description shared (near-identically) with 2+ other builds in the list | +2 |
| Stock bot phrasing ("data-driven", "based on 12,000 matches", "updated daily", "more builds at…") | +1 to +2 |
| Win-rate talk with a number or the actual words ("58% WR", "win rate") in the description / name | +1 each |
| Item notes that read like "+WR 3.1%", "Win rate: 54%" (2+ notes / 1 note) | +3 / +1 |
| The account already posted a bot build this session | +3 |

A score of **3 or more** counts as a bot build. Valve's default builds, your active build, your favourites
and the My Builds tab are never touched.

## In game

With the filter **ON**, the Public tab shows the mod's own list in place of the game's. It uses the
game's own row layout and styles, so it looks and works the same: click a row to select it, then
**Use**; double-click a row; favourite a build with the star.

- **No bot builds.** Bot builds are left out. Rows still being checked are slightly dimmed.
- **Scroll for more.** The game sends one fixed batch per search and rebuilds its own list on every
  search, so the mod keeps its own list. Near the bottom it runs another search (common build words,
  then about 200 shop item names) and adds the human builds it finds.
- **Rate limiting** (one request per search):
  - up to 3 back to back, then one every 4 s (15 a minute at most), at least 1.5 s apart;
  - at most 150 an hour across every build browser opened in the game session;
  - doubling back-off, up to 60 s, when a search comes back empty or late.

  The bottom row shows when the next search is allowed. Builds whose list text already marks them as
  bots, or whose account was caught, are dropped without being previewed.
- **Picking a build** that isn't in the game's current results loads it with one search by build ID,
  then the game's own details pane and Use Build take over.

The tab-bar control:
- **Bot filter: ON · N builds**: click to turn the filter OFF and get the game's own list back, with
  suspected builds tagged `BOT?`. Hover a tag to see why the build was flagged.
- **⟳ … · pause** while the mod loads; **Paused · resume** after you click a build during it.
  Previewing builds is off by default (see below). While your cursor is on the details pane (or on the game's
  list, when that is the one showing), nothing is previewed. Clicking a build pauses checking; the
  label then offers **resume**.

**Author records and favourites.** Each row shows the author's wins and losses on the hero
(`30W 22L`) and the build's favourite count (`★ 48.2k`). The game never shows favourite counts, so
these come from deadlock-api.com too, with one request per hero for its 400 most favourited builds.
Builds outside those show `★ <N`, meaning fewer than the least of them. The record colour means:

| Colour | Meaning |
|---|---|
| Red | `0W 0L`: no recorded games on this hero |
| Orange | under 42% wins over 5+ games |
| Green | 55%+ wins over 10+ games |

Hover the record for the details. The game only shares hero records with friends, so records come
from deadlock-api.com's public match data, which doesn't cover every match. `0W 0L` therefore means
"none recorded". Mod scripts can't reach the network, so the mod opens a tiny page in a hidden 1-pixel game web view:
[`relay/stats.html`](relay/stats.html), served by this repo's GitHub Pages. The page asks
deadlock-api.com for up to 30 authors at once and passes the answer back through its title. The request goes from your own PC: your
client sends the API the account IDs of the build authors on screen, plus your IP address.

**Saved lookups.** Records, favourites and build texts are saved in the lookup page's browser storage
(Steam's web profile), so they survive game restarts. The page only asks deadlock-api again once an
entry is older than the keep-time in ⚙ settings: records a day, favourites and build texts 6 hours by
default. **Clear now** forgets them all.

**Rate limits.** deadlock-api allows 100 requests a second per IP; the mod stays far below that:
- at most 2 requests at once and 4 a second, with commands at least 2 s apart;
- saved lookups, so most requests are never sent, and sorted account IDs so repeated lookups hit the
  API's CDN cache;
- on `429` or `503` (load shedding) it waits for `Retry-After` (60 s if not given). The wait is
  saved, so a restarted game waits too. Meanwhile the status shows `deadlock-api busy · Ns`;
- a request that timed out (`504`) isn't sent again for 5 minutes, as the API asks.

If the page or the API can't be reached, records stay blank and everything else keeps working.
To use your own copy of the page, set `CONFIG.stats.relayUrl`. To turn records off, set
`CONFIG.authorStats = false`.

**Tags.** The mod's rows show each build's tags like the game's list does, using the game's own icons.

**"Ordered and annotated" tags.** The game's **Search by Tag** picker gets an extra group with two tags of the mod's own:
- **Annotated**: builds whose items carry notes.
- **L>R**: builds that say which order to buy in. That covers "L>R" or "left to right" in the name,
  description or item-category notes, a "buy order", or three or more numbered item notes.

Picking one filters the list. The tab bar shows `Tags: L>R ×`; click it to clear the filter. Matching
rows also carry these tags as chips, in whatever is left of the three tag slots after the build's own tags. The game network can't search by them, so they filter the builds
the mod has already checked. The picker also gets a solid background.

**Sorting.** Click **Sort: … ▾** in the tab bar to pick an order:

| Sort | What comes first |
|---|---|
| Game order | as listed by the game, then builds found while scrolling |
| Most favourited | most favourites |
| Trending | most favourites this week |
| Latest updated | most recently updated |
| Most played | the author's games on this hero |
| Most wins | the author's wins on this hero |
| Best win rate | the author's win rate on this hero, 5+ games |

Most favourited, Trending and Latest updated also search deadlock-api for this hero's top 150
builds in that order (once per order), so the best builds show even if the game never listed them;
the author sorts rank the most favourited builds. Builds still loading their data go last.

**Settings (⚙).** One panel, in plain words:
- **Bot builds:** hide them or not; how strict (Relaxed / Normal / Strict); remember bot accounts.
- **Hide builds that…** are outdated; whose author played this hero fewer than N games; whose
  author's win rate is below N% (judged at 5+ games); have fewer than N favourites; weren't updated
  within a week, month, 3 months, 6 months or a year.
- **Sort.**
- **Show on each build:** the author's record, favourites, tags.
- **Loading:** load more when scrolling; Normal or Gentle search pace.
- **Saved lookups:** how long to keep authors' records (1 hour to a week) and favourites/build texts
  (1 hour to 3 days); Clear now.

Data that's still loading never hides a build. The bottom of the list says how many builds your
settings hide. Settings are kept for the game session and, across sessions, in the lookup page's
browser storage inside Steam's web view, because the game gives mods no file to write.

**Loading without showing anything.** Build texts (description, item notes, category notes,
favourites, last update) come from deadlock-api.com in the background, one small request per author
for this hero. Nothing is previewed in the details pane. Builds deadlock-api doesn't have yet stay
slightly dimmed. **Check N in detail** previews those once, only when you click it.

Typing your own search shows the game's results for it, with bot builds hidden in place.
Only item notes set on the item itself count. Values inherited from parent panels, and notes that
show up on builds from several accounts, are ignored. What the mod learns is kept for the game session.

## Build / install

You need Python 3 and a Deadlock install. The build tool copies small header blocks from the game's
own files, so it has to run against your game. Node is only needed for the tests.

```
python3 tools/build.py [--game .../Deadlock/game/citadel]   # writes dist/*.vpk
node tools/test_filter.mjs      # offline tests (fake build browser)
```

- `dist/bot_build_filter_dir.vpk`: standalone (layout, script, stylesheet).
- `dist/bot_build_filter_buildgem_dir.vpk`: written only when Build Gem is installed. It merges
  Build Gem's browser layout with this filter so both run. Use this one instead of the standalone
  file if you use Build Gem.

Both mods replace `citadel_popup_build_browser`, so this VPK has to load **before** Build Gem's.
Lower pak numbers load first. Add it through Deadlock Mod Manager and order it above Build Gem, or
copy it into `game/citadel/addons/` with a pak number lower than Build Gem's.

Tune `CONFIG` / `SOCIAL_DOMAINS` at the top of `src/bot_build_filter.js` and rebuild.
Console lines are prefixed `[BotBuildFilter]`.
