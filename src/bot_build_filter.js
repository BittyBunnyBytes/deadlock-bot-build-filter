"use strict";
// Bot Build Filter: hides auto-generated "winrate bot" builds from Deadlock's public build browser
// and keeps the public list full of human-made builds, with more loading as you scroll.
//
// Some sites run bots that publish builds assembled purely from item win rates. They are easy to spot:
//   - the description plugs a website (a stats site, not a creator's Twitch/YouTube/Discord),
//   - many of them share the same templated description,
//   - item annotations are generic machine text like "+WR 3.2%" or "Win rate: 54%".
// Each public build is scored on those signals; builds that reach THRESHOLD are bot builds.
//
// The public list. The game network answers a build search with one fixed batch (the request has
// no paging) and the stock list is rebuilt from scratch by every search, so it cannot be appended
// to. With the filter on, the Public tab shows the mod's own list in the stock list's place, drawn
// with the game's own row layout and styles: the human builds of the normal list, then more, found
// by extra searches (common words, then shop item names) whenever you scroll near the bottom.
// Searches go through a rate limiter (a small burst, then one every few seconds, an hourly cap and
// back-off when the network looks busy) so the account never sends more than a person clicking
// around would. Picking a row loads it through the game's own "search by BuildID" when it is not
// in the current stock results, so the details pane and "Use Build" are the stock game doing its
// normal thing.
//
// The player comes first: any build the player clicks pauses background checking (the tab-bar
// control offers to resume), and scrolling to the bottom is what asks for more.
//
// Where the text comes from:
//   - rows: name and author ({s:selected_hero_build_name}, {d:build_creator}); the description too,
//     when the game sets it on the row,
//   - the details pane: description, build id and item annotations ({s:mod_annotation}) of the
//     previewed build. Rows are previewed one by one to read them (Public tab only, which never
//     changes your active build). Only annotations set on an item panel itself count: dialog
//     variables are inherited from parent panels, and a value left on a parent is not this build's.
// Filter off: the stock list, every build visible, bot builds tagged "BOT?" with the reasons.
(function () {
    var TAG = "[BotBuildFilter] ";

    // Shop item names, filled in by tools/build.py from the game's localization (search words).
    var ITEM_NAMES = []; /*@ITEM_NAMES@*/
    // { hero class: hero id }, filled in by tools/build.py from the game's scripts/heroes.vdata.
    var HERO_IDS = {}; /*@HERO_IDS@*/
    // [[ability/item key, icon path], ...], filled in by tools/build.py from scripts/abilities.vdata (tag
    // icons: an item's shop icon, as the game's tag picker shows it). Likelier tags come first.
    var ABILITY_IMAGES = []; /*@ABILITY_IMAGES@*/
    var STANDARD_TAGS = ["weapon", "vitality", "spirit", "damage", "utility", "healing", "crowd_control", "mobility",
                         "melee", "headshots", "debuff", "complexity_1", "complexity_2", "complexity_3"];

    // ------------------------------------------------------------------ settings
    var CONFIG = {
        threshold: 3,             // score at which a build counts as a bot build
        autoScan: true,           // preview public rows automatically to read descriptions/annotations
        scanMaxRows: 120,         // at most this many rows per pass
        settleFrames: 2,          // a preview counts once the details pane reads the same on this many frames in a row
        learnAuthors: true,       // once an account posted a bot build (by its own text), its other builds count as bot builds
        fill: true,               // show our own public list (bots out, more on scroll); false: filter the stock list in place
        minRows: 25,              // keep loading (rate-limited) until the list has this many human builds
        batchMinNew: 6,           // one "load more" keeps searching until it added this many builds (or used batchMaxSearches)
        batchMaxSearches: 3,
        scrollMarginPx: 500,      // "near the bottom": this close to the end of the list
        // Search words, tried in order, then ITEM_NAMES. Words people put in build names; not the ones bots use.
        searchWords: ["spirit", "gun", "weapon", "melee", "tank", "hybrid", "carry", "support", "fun", "bullet",
                      "burst", "sustain", "lane", "ult", "late", "early", "crit", "headshot", "dps", "beginner",
                      "guide", "season", "new", "my", "build", "brawl", "roam", "solo", "duo", "fast", "easy",
                      "ranked", "pro", "updated", "patch", "core", "flex", "anti", "counter", "aggressive"],
        // Rate limiting of searches (each is one request to the game network).
        rate: {
            burst: 3,             // searches allowed back to back
            refillSeconds: 4,     // then one more every this many seconds (15 a minute at most)
            minSpacingSeconds: 1.5,
            perHour: 150,         // hard cap per hour, across every build browser opened this game session
            backoffMaxSeconds: 60 // empty or timed-out answers double the wait, up to this
        },
        searchTimeoutSeconds: 8,
        poolReuseSeconds: 1800,   // a hero's list is kept this long within a game session
        // Each author's wins and losses on this hero, from deadlock-api.com (public match data it has
        // recorded). Fetched through the game's web view, many authors per request.
        authorStats: true,
        stats: {
            // The lookup page (relay/stats.html of this repo, served by GitHub Pages). "" = try a data: URL
            // instead (the game's web view does not run those, so records then stay off).
            relayUrl: "https://bittybunnybytes.github.io/deadlock-bot-build-filter/relay/stats.html",
            batch: 100,           // authors per request
            favsLimit: 400,       // favourites: the hero's this many most favourited builds (one request)
            minSpacingSeconds: 2, // between requests (the API allows 100 a second; this stays far below)
            timeoutSeconds: 15,
            reuseSeconds: 1800    // records are kept this long within a game session
        }
    };
    // Links to these do not count as "plugging a website": creators link their socials.
    var SOCIAL_DOMAINS = [
        "twitch.tv", "youtube.com", "youtu.be", "twitter.com", "x.com", "discord.gg", "discord.com",
        "discordapp.com", "tiktok.com", "instagram.com", "reddit.com", "kick.com", "facebook.com",
        "fb.com", "bsky.app", "threads.net", "patreon.com", "ko-fi.com", "linktr.ee", "steamcommunity.com",
        "steampowered.com", "medal.tv", "streamlabs.com", "github.com"
    ];
    var TLDS = "com|gg|net|io|app|org|co|pro|xyz|info|site|tools|lol|me|fyi|dev|ai|win|stats|online|live|top|cc|tv|so|wiki|club|world|space|fun|plus|zone|guide|ws|us|uk|de|fr|ru|eu|ly|to|sh|tech|best|link";

    // ------------------------------------------------------------------ text signals (pure; no panels)
    var RE_URL = /\bhttps?:\/\/[^\s<>"']+|\bwww\.[a-z0-9-]+\.[a-z]{2,}[^\s<>"']*/gi;
    // A plain dot must touch both sides ("spam. Win rate" is a sentence, not spam.win); the disguised
    // forms ("site [dot] com", "site(.)gg") may have spaces.
    var RE_DOMAIN = new RegExp("\\b((?:[a-z0-9-]+\\.)*[a-z0-9][a-z0-9-]{0,62})(?:\\.|\\s*(?:\\[\\.\\]|\\(\\.\\)|\\[dot\\]|\\(dot\\))\\s*|\\s+dot\\s+)(" + TLDS + ")\\b(?![a-z0-9-])", "gi");
    // Win-rate talk: a number with a win-rate word next to it ("58% WR", "win rate 54%"), or the
    // words "win rate"/"winrate". A bare "wr" without a number is too common in normal writing to count.
    var RE_WR = /\b(?:win\s*-?\s*rates?|winrates?)\b|\d+(?:[.,]\d+)?\s*%\s*(?:win|w\/?r)\b|\bw\/?r\s*[:=]?\s*\d+(?:[.,]\d+)?\s*%/i;
    // An item note that is machine win-rate text: "+WR 3.1%", "+3.1% WR", "Win rate: 54%", "WR +2%".
    var RE_ANNOTATION_WR = /[+-]?\s*\d+(?:[.,]\d+)?\s*%\s*(?:wr|w\/r|win\s*-?\s*rate|winrate)\b|\b(?:wr|w\/r|win\s*-?\s*rate|winrate)\s*[:=]?\s*[+-]?\s*\d+(?:[.,]\d+)?\s*%|\+\s*wr\s*[+-]?\s*\d/i;
    var TEMPLATE_PHRASES = [
        /\bdata[- ]?driven\b/i,
        /\bbased on (?:the )?(?:last |over |more than )?[\d,.]+\s*k?\+?\s*(?:matches|games|players)/i,
        /\b(?:highest|best|top)[- ](?:win[- ]?rate|wr|performing)\b/i,
        /\bauto(?:matically|[- ])?\s*(?:generated|updated|created)\b/i,
        /\b(?:generated|created|built) (?:by|from|using|with) (?:our|an?|the)?\s*(?:ai|algorithm|bot|data|stats|statistics|tool)/i,
        /\bstatistically\b/i,
        /\banaly[sz](?:ed|is of) (?:over |more than )?[\d,.]+\s*k?\+?/i,
        /\bupdated (?:daily|hourly|weekly|every (?:day|hour|patch))\b/i,
        /\bsample size\b/i,
        /\b(?:from|across|over) [\d,.]+\s*k?\+? (?:ranked )?(?:matches|games)\b/i,
        /\b(?:ai|machine)[- ](?:generated|optimi[sz]ed|powered)\b/i,
        /\bmore (?:builds|stats|data) (?:at|on)\b/i,
        /\b(?:find|get|see|check)(?: out)? (?:more|all|other|the best|live|updated) (?:builds|stats|tier lists?)\b/i,
        /\bfor (?:more|all|other|live|updated) (?:builds|stats)\b/i
    ];

    function socialDomain(host) {
        host = host.toLowerCase().replace(/^www\./, "");
        for (var i = 0; i < SOCIAL_DOMAINS.length; i++) {
            var s = SOCIAL_DOMAINS[i];
            if (host === s || host.slice(-(s.length + 1)) === "." + s) return true;
        }
        return false;
    }
    // Website domains (not socials) mentioned in a text, lower-case, deduplicated.
    function websites(text) {
        var out = {}, m;
        text = String(text || "");
        RE_URL.lastIndex = 0;
        while ((m = RE_URL.exec(text))) {
            var host = m[0].replace(/^https?:\/\//i, "").split(/[\/?#:]/)[0].toLowerCase();
            if (host && !socialDomain(host)) out[host.replace(/^www\./, "")] = true;
        }
        RE_DOMAIN.lastIndex = 0;
        while ((m = RE_DOMAIN.exec(text))) {
            var name = m[1].toLowerCase(), tld = m[2].toLowerCase();
            if (/^\d+$/.test(name)) continue;
            var h = name + "." + tld;
            if (!socialDomain(h)) out[h.replace(/^www\./, "")] = true;
        }
        return Object.keys(out);
    }
    // A description boiled down to its template: numbers, links and punctuation gone.
    function templateOf(text) {
        return String(text || "").toLowerCase()
            .replace(RE_URL, " ")
            .replace(/\d+(?:[.,]\d+)?/g, "#")
            .replace(/[^a-z#]+/g, " ")
            .replace(/\s+/g, " ").trim();
    }
    function shingles(t) {
        var w = t.split(" "), out = {};
        for (var i = 0; i + 2 < w.length; i++) out[w[i] + " " + w[i + 1] + " " + w[i + 2]] = true;
        return out;
    }
    function similarity(a, b) {
        var inter = 0, na = 0, nb = 0, k;
        for (k in a) { na++; if (b[k]) inter++; }
        for (k in b) nb++;
        return na + nb - inter > 0 ? inter / (na + nb - inter) : 0;
    }
    function quote(s) { s = String(s); return "\"" + (s.length > 40 ? s.slice(0, 37) + "..." : s) + "\""; }

    // Score one build from its own text. `b`: { name, desc, annotations[] }.
    function scoreText(b) {
        var score = 0, reasons = [], desc = b.desc || "", name = b.name || "";
        var sites = websites(desc + " \n " + name);
        if (sites.length) { score += 2; reasons.push("plugs a website: " + sites.slice(0, 3).join(", ")); }
        if (RE_WR.test(name)) { score += 1; reasons.push("win rate in the name: " + quote(name)); }
        var wrDesc = desc.match(RE_WR);
        if (wrDesc) { score += 1; reasons.push("win rate in the description: " + quote(wrDesc[0])); }
        var phrases = [];
        for (var i = 0; i < TEMPLATE_PHRASES.length; i++) { var pm = desc.match(TEMPLATE_PHRASES[i]); if (pm) phrases.push(pm[0]); }
        if (phrases.length) { score += Math.min(2, phrases.length); reasons.push("stock bot phrasing: " + phrases.slice(0, 3).map(quote).join(", ")); }
        var notes = (b.annotations || []).filter(function (a) { return RE_ANNOTATION_WR.test(a); });
        if (notes.length >= 2) { score += 3; reasons.push(notes.length + " item notes are win-rate text, e.g. " + notes.slice(0, 2).map(quote).join(", ")); }
        else if (notes.length === 1) { score += 1; reasons.push("an item note is win-rate text: " + quote(notes[0])); }
        return { score: score, reasons: reasons, sites: sites };
    }

    // Score a whole list: each build's own text, plus what it shares with the others (the same template
    // description, the same plugged website from several accounts) and accounts already caught.
    // builds: [{ key, author, name, desc, annotations }]; botAuthors: { author: reason }.
    function scoreList(builds, botAuthors) {
        var res = {}, templates = [], siteAuthors = {};
        builds.forEach(function (b) {
            var r = scoreText(b);
            res[b.key] = r;
            r.own = r.score;
            r.sites.forEach(function (s) { (siteAuthors[s] = siteAuthors[s] || {})[b.author] = true; });
            var t = templateOf(b.desc);
            if (t.length >= 30 && t.split(" ").length >= 6) templates.push({ key: b.key, author: b.author, t: t, sh: shingles(t) });
        });
        // Look-alike descriptions: three or more builds from two or more accounts with near-identical text
        // (one person reusing their own description across builds is not a bot).
        templates.forEach(function (a) {
            var twins = 0, accounts = {};
            templates.forEach(function (b) { if (a !== b && (a.t === b.t || similarity(a.sh, b.sh) >= 0.6)) { twins++; accounts[b.author] = true; } });
            delete accounts[a.author];
            if (twins >= 2 && Object.keys(accounts).length >= 1) { res[a.key].score += 2; res[a.key].reasons.push("same templated description as " + twins + " other builds"); }
        });
        builds.forEach(function (b) {
            var r = res[b.key];
            var shared = r.sites.filter(function (s) { return Object.keys(siteAuthors[s]).length >= 2; });
            if (shared.length) { r.score += 1; r.reasons.push(shared[0] + " is plugged by several accounts here"); }
            if (botAuthors && botAuthors[b.author] && b.author !== "0") { r.score += 3; r.reasons.push("this account posted other bot builds"); }
            r.bot = r.score >= CONFIG.threshold && b.author !== "0";
        });
        return res;
    }

    // ------------------------------------------------------------------ the mod's own tags: "Annotated", "L>R"
    // L>R: the build says in which order to buy (in its name, description, category notes or item notes).
    var RE_ORDER = /\bL\s*(?:-+>|=+>|>+|→|to)\s*R\b|\bleft\s*(?:-+>|=+>|>|→|to)\s*right\b|\b(?:buy|build|item|purchase|upgrade)(?:ing)?\s+order\b|\bin (?:this |that |the )?order\b|\bfollow (?:the |this |my )?(?:build |order |items? )?(?:from )?(?:left|in order|order)\b|\btop\s*(?:-+>|>|→|to)\s*bottom\b/i;
    var RE_NUMBERED_NOTE = /^\s*(?:#\s*\d{1,2}|\d{1,2}\s*(?:st|nd|rd|th)\b|\d{1,2}\s*[.):-](?!\d)|\(\d{1,2}\))/i;
    function styleTags(b) {
        var notes = b.annotations || [];
        var numbered = notes.filter(function (a) { return RE_NUMBERED_NOTE.test(a); }).length;
        var text = (b.name || "") + "\n" + (b.desc || "") + "\n" + (b.cats || "") + "\n" + notes.join("\n");
        return { annotated: notes.length > 0, ordered: RE_ORDER.test(text) || numbered >= 3 };
    }

    // Exposed for the offline tests (tools/test_filter.mjs); harmless in game.
    var api = { scoreText: scoreText, scoreList: scoreList, websites: websites, templateOf: templateOf, styleTags: styleTags, CONFIG: CONFIG };
    try { if (typeof globalThis !== "undefined") globalThis.BotBuildFilter = api; } catch (e) {}
    if (typeof $ === "undefined" || !$.GetContextPanel) return;

    // ------------------------------------------------------------------ panel helpers
    function log(s) { try { $.Msg(TAG + s); } catch (e) {} }
    function valid(p) { try { return !!(p && p.IsValid && p.IsValid()); } catch (e) { return false; } }
    function byClass(p, cls) { try { return p.FindChildrenWithClassTraverse(cls)[0] || null; } catch (e) { return null; } }
    function child(p, id) { try { return p.FindChildTraverse(id); } catch (e) { return null; } }
    function digits(s) { return String(s || "").replace(/[^0-9]/g, ""); }
    function click(p) { try { $.DispatchEvent("Activated", p, "mouse"); return true; } catch (e) { return false; } }
    function now() { return Date.now() / 1000; }
    function firstOfType(p, type) {
        if (!valid(p)) return null;
        if (p.paneltype === type) return p;
        var n = p.GetChildCount();
        for (var i = 0; i < n; i++) { var hit = firstOfType(p.GetChild(i), type); if (hit) return hit; }
        return null;
    }
    function loc(fmt, panel) {
        try {
            var s = $.Localize(fmt, panel);
            if (s === undefined || s === null) return "";
            s = String(s);
            return /\{[a-z](?::[a-z])*:[a-z_]+\}/.test(s) ? "" : s;
        } catch (e) { return ""; }
    }
    function plain(s) { return String(s || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").trim(); }
    function delay(seconds) { return new Promise(function (resolve) { $.Schedule(seconds, resolve); }); }
    function nextFrame() { return delay(0); }
    function tooltip(panel, text) {
        panel.SetPanelEvent("onmouseover", function () { try { $.DispatchEvent("UIShowTextTooltip", panel, text); } catch (e) {} });
        panel.SetPanelEvent("onmouseout", function () { try { $.DispatchEvent("UIHideTextTooltip", panel); } catch (e) {} });
    }
    function label(parent, text, size, color) {
        var l = $.CreatePanel("Label", parent, "");
        l.text = text || "";
        l.style.fontSize = (size || 16) + "px";
        l.style.color = color || "#FFEFD7";
        return l;
    }
    // Checks every frame, up to `seconds`.
    async function waitFor(test, seconds) {
        var end = Date.now() + seconds * 1000;
        do {
            if (!alive) return false;
            try { if (test()) return true; } catch (e) {}
            await nextFrame();
        } while (Date.now() < end);
        return false;
    }

    // ------------------------------------------------------------------ stock panels
    var popup = $.GetContextPanel();
    while (valid(popup) && popup.paneltype !== "PopupBuildBrowser") popup = popup.GetParent();
    if (!valid(popup)) { log("build browser popup not found"); return; }
    var selector = child(popup, "HeroBuildSelector");
    var tabBar = byClass(selector, "HeroSelectorTabContainer");
    var main = byClass(selector, "MainContainer");
    var list = child(selector, "HeroBuildList");
    var details = child(selector, "BuildDetails");
    var searchEntry = child(selector, "SearchTextEntry");
    if (!selector || !tabBar || !list || !details) { log("the build browser layout is not what this version expects; doing nothing"); return; }
    var canFill = !!(main && searchEntry && CONFIG.fill);

    // Old copies (development reloads).
    try { popup.FindChildrenWithClassTraverse("BbfControl").forEach(function (p) { p.DeleteAsync(0); }); } catch (e) {}

    // ------------------------------------------------------------------ session memory (lives on the popup manager)
    // Keys carry a version: v2 dropped what v1 learned from inherited (not the build's own) item notes.
    var memoryPanel = popup.GetParent();
    function recall(key, fallback) {
        try { var v = JSON.parse(memoryPanel.GetAttributeString(key, "") || "null"); return v === null ? fallback : v; } catch (e) { return fallback; }
    }
    function keep(key, value) { try { memoryPanel.SetAttributeString(key, JSON.stringify(value)); } catch (e) {} }
    var state = recall("bbf2_state", { on: true });
    var known = recall("bbf2_known", {});        // "author|name" -> { author, desc, annotations, id }
    var botAuthors = recall("bbf2_bot_authors", {});
    function saveKnown() {
        var keys = Object.keys(known);
        if (keys.length > 2500) keys.slice(0, keys.length - 2500).forEach(function (k) { delete known[k]; });
        keep("bbf2_known", known);
    }

    // ------------------------------------------------------------------ state of this popup
    var alive = true, busy = false, stopWork = false, paused = false, progress = "";
    var userSearch = false;      // the player typed in the search box: their results, filtered in place
    var userLoading = false;     // a build the player picked is being loaded
    var currentFilter = [];      // the mod's tags picked in the tag picker
    var stockIsDefault = true;   // the stock list holds the normal (unsearched) public list
    var heroKey = "";            // name of Valve's default build row: tells heroes apart for the pool cache
    var pool = null;             // { at, entries: [entry], term: next search word index, exhausted }
    var selectedKey = null;      // build picked in our list
    var lastResult = {}, hiddenCount = 0, flaggedCount = 0;

    // ------------------------------------------------------------------ reading the stock list and the details pane
    function keyOf(author, name) { return String(author) + "|" + name; }
    function publicMode() { return selector.BHasClass("ShowPublicBuilds") && !selector.BHasClass("ShowMyBuilds"); }
    function loading() { return selector.BHasClass("BuildsLoading"); }
    // Item notes are only in the details pane, so a build counts as read once it has been previewed.
    function unread(r) { return r.author !== "0" && (!known[r.key] || known[r.key].annotations === null); }
    // The row classes worth carrying over to our copy of a row.
    var ROW_CLASSES = ["DefaultBuild", "Favorite", "DailyFavorite", "WeeklyFavorite", "ObsoleteBuild", "ActiveBuild", "ShowFavoriteCount", "MyBuild"];
    function rowClasses(panel) { return ROW_CLASSES.filter(function (c) { return panel.BHasClass(c); }); }
    // The stock rows, re-read at most every 100 ms (several parts of a tick ask for them).
    var rowsMemo = null;
    function rows() {
        var n = 0, first = null;
        try { n = list.GetChildCount(); first = n ? list.GetChild(0) : null; } catch (e) {}
        if (rowsMemo && rowsMemo.n === n && rowsMemo.first === first && Date.now() - rowsMemo.at < 100) return rowsMemo.val;
        var val = readRowsNow(n);
        rowsMemo = { n: n, first: first, at: Date.now(), val: val };
        return val;
    }
    function forgetRows() { rowsMemo = null; }
    function readRowsNow(n) {
        var out = [];
        for (var i = 0; i < n; i++) {
            var row = list.GetChild(i);
            if (!valid(row) || !row.BHasClass("HeroBuildListItem")) continue;
            var name = loc("{s:selected_hero_build_name}", row), author = digits(loc("{d:build_creator}", row));
            if (!name) continue;
            var k = keyOf(author, name), desc = plain(loc("{s:selected_hero_build_description}", row));
            if (desc && !known[k]) { known[k] = { author: author, desc: desc, annotations: null }; sharedCache = null; version++; }
            out.push({ panel: row, key: k, name: name, author: author });
        }
        return out;
    }
    function detailsId() { return Number(digits(loc("{d:selected_hero_build_id}", details))) || 0; }
    function detailsName() { return loc("{s:selected_hero_build_name}", details); }
    // The item notes of the previewed build. A panel's dialog variables include its parents', so a
    // note counts only where it is set on the panel itself (it differs from its parent's value).
    function annotationsOf(root) {
        var seen = {}, out = [], stack = [{ p: root, inherited: plain(loc("{s:mod_annotation}", root)) }], visited = 0;
        while (stack.length && visited < 4000) {
            var it = stack.pop(), p = it.p;
            visited++;
            if (!valid(p)) continue;
            var a = plain(loc("{s:mod_annotation}", p));
            if (a && a !== it.inherited && !seen[a]) { seen[a] = true; out.push(a); }
            var n = 0;
            try { n = p.GetChildCount(); } catch (e) {}
            for (var i = 0; i < n; i++) stack.push({ p: p.GetChild(i), inherited: a });
        }
        return out;
    }
    // Item notes live on the item panels of the build's item list; read only that part of the pane.
    function notesRoot() { return child(details, "ShopModsBuild") || child(details, "ModListContainer") || details; }
    function readDetails() {
        return { id: detailsId(), name: detailsName(), desc: plain(loc("{s:selected_hero_build_description}", details)), annotations: annotationsOf(notesRoot()) };
    }
    // The text of the build's item categories (their names and notes, e.g. "Follow this left -> right"),
    // read once a preview has settled. Item names are left out.
    function categoriesOf(root) {
        var out = [], seen = {}, stack = [root], visited = 0;
        while (stack.length && visited < 3000) {
            var p = stack.pop();
            visited++;
            if (!valid(p)) continue;
            if (p.paneltype === "Label") {
                var t = plain(p.text);
                if (t && t.length >= 4 && t.length < 300 && !seen[t] && !tagIcon(t)) { seen[t] = true; out.push(t); }
                continue;
            }
            var n = 0;
            try { n = p.GetChildCount(); } catch (e) {}
            for (var i = 0; i < n; i++) stack.push(p.GetChild(i));
        }
        return out.join("\n").slice(0, 1500);
    }
    // Read the details pane once it has settled: the same reading on settleFrames frames in a row (the
    // item list fills in a moment after the name). Notes identical to the previous build's are likely
    // still the old item panels, so those get a few more frames to prove themselves.
    var prevNotes = "";
    async function readSettled(name) {
        var last = null, same = 0;
        for (var f = 0; f < 30; f++) {
            await nextFrame();
            if (detailsName() !== name) { last = null; same = 0; continue; }   // cheap check first
            var d = readDetails();
            if (d.name !== name) { last = null; same = 0; continue; }
            var sig = d.id + "\n" + d.desc + "\n" + d.annotations.join("\n");
            same = last === sig ? same + 1 : 1;
            last = sig;
            var notes = d.annotations.join("\n");
            var need = notes && notes === prevNotes ? CONFIG.settleFrames + 4 : CONFIG.settleFrames;
            if (same >= need) { prevNotes = notes; return d; }
        }
        return null;
    }
    function remember(r, d) {
        if (d.cats === undefined) d.cats = categoriesOf(notesRoot());
        known[r.key] = { author: r.author, desc: d.desc, annotations: d.annotations, id: d.id, cats: d.cats };
        sharedCache = null;
        version++;
    }
    // Whatever the details pane shows (picked by the player in the stock list) is remembered against its row.
    var lastDetailsId = -1;
    function learnFromDetails(rowList) {
        var id = detailsId();
        if (!id || id === lastDetailsId || busy) return;
        var name = detailsName(), match = null;
        for (var i = 0; i < rowList.length; i++) {
            if (rowList[i].name === name) {
                if (match) { match = null; break; }   // two rows with that name: cannot tell which one
                match = rowList[i];
            }
        }
        lastDetailsId = id;
        if (match && (!known[match.key] || known[match.key].annotations === null)) {
            var r = match;
            readSettled(name).then(function (d) { if (d && d.id === id) { remember(r, d); saveKnown(); } });
        }
    }

    // ------------------------------------------------------------------ scoring
    // A note that shows up on builds from several accounts is not anyone's own note (left over in a
    // reused panel, or a game-wide value): it is ignored.
    var sharedCache = null;
    var version = 0;             // bumps whenever anything that can change a verdict changes
    function sharedNotes() {
        if (sharedCache) return sharedCache;
        var by = {}, out = {};
        Object.keys(known).forEach(function (k) {
            var e = known[k];
            (e.annotations || []).forEach(function (a) { (by[a] = by[a] || {})[e.author || k.split("|")[0]] = true; });
        });
        Object.keys(by).forEach(function (a) { if (Object.keys(by[a]).length >= 3) out[a] = true; });
        return (sharedCache = out);
    }
    function inputOf(key, author, name) {
        var k = known[key] || {}, shared = sharedNotes();
        return { key: key, author: author, name: name, desc: k.desc || "",
                 annotations: (k.annotations || []).filter(function (a) { return !shared[a]; }) };
    }
    // Rows worth previewing: unread, and not already settled as bot builds by their list text or account.
    function worthReading(r) {
        if (!unread(r)) return false;
        if (CONFIG.learnAuthors && botAuthors[r.author]) return false;
        return scoreText(inputOf(r.key, r.author, r.name)).score < CONFIG.threshold;
    }
    function learnAuthors(builds, result) {
        if (!CONFIG.learnAuthors) return;
        var changed = false;
        builds.forEach(function (b) {
            var v = result[b.key];
            if (v && v.bot && v.own >= CONFIG.threshold && b.author && b.author !== "0" && !botAuthors[b.author]) { botAuthors[b.author] = b.name; changed = true; }
        });
        if (changed) { keep("bbf2_bot_authors", botAuthors); version++; }
    }
    function ownTagsOf(key, author, name) {
        var k = known[key];
        if (!k || k.annotations === null || author === "0") return null;
        var shared = sharedNotes();
        return styleTags({ name: name, desc: k.desc, cats: k.cats, annotations: (k.annotations || []).filter(function (a) { return !shared[a]; }) });
    }
    // The tag filter picked in the tag picker (kept on the root panel, which the picker popup shares).
    var rootPanel = null;
    function tagFilter() {
        try {
            if (!rootPanel) { rootPanel = popup; while (valid(rootPanel.GetParent())) rootPanel = rootPanel.GetParent(); }
            var v = rootPanel.GetAttributeString("bbf3_tag_filter", "");
            return v ? v.split(",") : [];
        } catch (e) { return []; }
    }
    function passesFilter(filter, key, author, name) {
        if (!filter.length) return true;
        var t = ownTagsOf(key, author, name);
        return !!t && filter.every(function (f) { return t[f]; });
    }
    function verdicts(items) {
        var input = items.map(function (r) { return inputOf(r.key, r.author, r.name); });
        var result = scoreList(input, CONFIG.learnAuthors ? botAuthors : null);
        learnAuthors(input, result);
        return result;
    }

    // ------------------------------------------------------------------ previewing rows
    // Stops (and pauses all checking) as soon as the details pane shows a build it did not pick: the
    // player clicked something.
    var ourId = -1;
    function playerClicked() { return ourId !== -1 && detailsId() !== ourId; }
    function pause(why) { if (!paused) log("paused: " + (why || "the player picked a build")); paused = true; stopWork = true; ourId = -1; }
    // The player's click can land just before ours and be covered by it: put their pick back.
    async function yieldTo(name) {
        pause();
        await waitFor(function () { return false; }, 0.1);
        if (detailsName() === name) return;
        var r = rows().filter(function (x) { return x.name === name; })[0];
        if (r) click(r.panel);
    }
    // While the cursor is on the stock list (when it is the one showing) or on the details pane, no
    // preview is started: a click by the player can then never be covered by one of ours.
    function hovered(p) { try { return !!(p && p.BHasHoverStyle && p.BHasHoverStyle()); } catch (e) { return false; } }
    function playerBusy() { return hovered(details) || (!listOn() && hovered(list)); }
    async function readRows(todo, what) {
        ourId = detailsId();
        for (var i = 0; i < todo.length; i++) {
            while (playerBusy() && !stopWork && !paused && alive) {
                progress = "Waiting for the cursor";
                drawControl();
                await nextFrame();
            }
            if (stopWork || paused || !alive || !publicMode() || loading()) return false;
            if (playerClicked()) { pause(); return false; }
            var r = todo[i];
            if (!valid(r.panel) || loc("{s:selected_hero_build_name}", r.panel) !== r.name) continue;   // row reused meanwhile
            progress = (what || "Checking") + " " + (i + 1) + "/" + todo.length;
            drawControl();
            var before = detailsId(), beforeName = detailsName(), foreign = null;
            click(r.panel);
            // Any other build showing up meanwhile is the player's click.
            await waitFor(function () {
                var n = detailsName();
                if (n && n !== r.name && n !== beforeName) { foreign = n; return true; }
                var id = detailsId();
                return id && id !== before && n === r.name;
            }, 1.0);
            if (foreign) { await yieldTo(foreign); return false; }
            if (detailsName() !== r.name) { pause(); return false; }
            var d = await readSettled(r.name);
            if (!d || d.name !== r.name) { var other = detailsName(); if (other && other !== r.name) await yieldTo(other); else pause(); return false; }
            remember(r, d);
            ourId = lastDetailsId = d.id;
        }
        ourId = -1;
        return true;
    }

    // ------------------------------------------------------------------ rate-limited searches
    // Every search is one request to the game network. A token bucket keeps it to what a person
    // clicking around would send; an hourly cap (shared by every browser opened this session) and a
    // back-off on empty/timed-out answers sit on top.
    var R = CONFIG.rate;
    var bucket = { tokens: R.burst, at: now(), nextAt: 0, backoff: 0, backoffUntil: 0 };
    var searchLog = recall("bbf2_search_log", []);
    function rateWait() {
        var t = now();
        bucket.tokens = Math.min(R.burst, bucket.tokens + (t - bucket.at) / R.refillSeconds);
        bucket.at = t;
        searchLog = searchLog.filter(function (s) { return t - s < 3600; });
        var w = Math.max(0, bucket.nextAt - t, bucket.backoffUntil - t, bucket.tokens >= 1 ? 0 : (1 - bucket.tokens) * R.refillSeconds);
        if (searchLog.length >= R.perHour) w = Math.max(w, searchLog[0] + 3600 - t);
        return w;
    }
    var rateNote = "";
    // Background searches (loading more) give up as soon as our list is not showing; the player's own
    // pick (loading a build by ID) does not.
    async function takeToken(background) {
        for (;;) {
            if (!alive || stopWork || (background && !listOn())) return false;
            var w = rateWait();
            if (w <= 0) break;
            rateNote = searchLog.length >= R.perHour ? "hourly search limit reached, next in " + Math.ceil(w / 60) + " min" : "next search in " + Math.ceil(w) + "s";
            drawControl(); drawMore();
            await delay(Math.min(w, 0.5));
        }
        rateNote = "";
        bucket.tokens -= 1;
        bucket.nextAt = now() + R.minSpacingSeconds;
        searchLog.push(now());
        keep("bbf2_search_log", searchLog);
        return true;
    }
    function backoff(ok) {
        if (ok) { bucket.backoff = 0; return; }
        bucket.backoff = Math.min(R.backoffMaxSeconds, Math.max(5, bucket.backoff * 2));
        bucket.backoffUntil = now() + bucket.backoff;
        log("search came back empty or late; waiting " + bucket.backoff + "s before the next one");
    }
    // Runs one stock search; the search box is emptied again afterwards (the results stay), so the
    // game's tabs and the player's own searches never see our words.
    // The game reads the search box a moment after the refresh request, so our text stays in it until
    // the answer is in; it is then emptied again (the results stay), so the game's tabs and the player's
    // own searches never see our words.
    var ourText = null;
    async function search(text, isId) {
        if (!await takeToken(!isId)) return null;
        if (!isId && !listOn()) return null;
        stockIsDefault = false;
        ourText = String(text);
        searchEntry.text = ourText;
        try { $.DispatchEvent("CitadelBuildBrowserRefresh", selector, true); } catch (e) { clearOurText(); return null; }
        await waitFor(loading, 0.6);
        var done = await waitFor(function () { return !loading(); }, CONFIG.searchTimeoutSeconds);
        await nextFrame();
        clearOurText();
        forgetRows();
        var got = done ? rows() : [];
        if (!isId) backoff(done && got.length > 0);
        return done ? got : null;
    }
    function clearOurText() {
        if (ourText !== null && String(searchEntry.text || "") === ourText) searchEntry.text = "";
        ourText = null;
    }
    // Back to the normal list (one request). The game's My Builds tab is a filter over the same results,
    // so it needs the normal list to show your own, favourited and active builds.
    function restoreStock() {
        if (stockIsDefault || !searchEntry) return;
        stockIsDefault = true;
        ourText = null;
        searchEntry.text = "";
        try { $.DispatchEvent("CitadelBuildBrowserClearSearch", selector); } catch (e) {}
    }

    // ------------------------------------------------------------------ control in the tab bar
    var control = $.CreatePanel("Panel", tabBar, "");
    control.AddClass("BbfControl");
    control.style.flowChildren = "right";
    control.style.verticalAlign = "center";
    control.style.marginLeft = "12px";
    control.style.padding = "4px 10px";
    control.style.borderRadius = "4px";
    control.style.backgroundColor = "#00000066";
    var toggleLabel = label(control, "", 16);
    toggleLabel.style.verticalAlign = "center";
    var filterLabel = label(control, "", 16, "#9fd8ff");
    filterLabel.style.marginLeft = "10px";
    filterLabel.style.verticalAlign = "center";
    filterLabel.SetPanelEvent("onactivate", function () { try { tagFilter(); rootPanel.SetAttributeString("bbf3_tag_filter", ""); } catch (e) {} });
    var statusLabel = label(control, "", 16, "#c8b28a");
    statusLabel.style.marginLeft = "10px";
    statusLabel.style.verticalAlign = "center";
    toggleLabel.SetPanelEvent("onactivate", function () { setOn(!state.on); });
    // Busy: pause. Paused: resume. Idle: check again.
    statusLabel.SetPanelEvent("onactivate", function () {
        if (busy) { pause("paused from the control"); return; }
        paused = false; stopWork = false;
        if (listOn()) { verifyList(); } else scanStock(true);
    });
    tooltip(toggleLabel, "Bot Build Filter: takes public builds generated from win rates out of the list (they plug a website, share a templated description, and annotate items with \"+WR x%\") and loads more human builds as you scroll.<br>Click to switch to the game's own list with suspected builds tagged BOT?.");
    tooltip(statusLabel, "Builds are previewed once to read their description and item notes (your active build is not changed). Clicking any build pauses this.");
    function drawControl() {
        var count = listOn() && pool ? "  ·  " + shownEntries().length + " builds" : flaggedCount ? (state.on ? "  ·  " + hiddenCount + " hidden" : "  ·  " + flaggedCount + " tagged") : "";
        toggleLabel.text = "Bot filter: " + (state.on ? "ON" : "OFF") + count;
        toggleLabel.style.color = state.on ? "#9be7a9" : "#FFEFD7";
        var pending = pendingCount();
        statusLabel.text = busy ? "⟳ " + (progress || "Working") + (rateNote ? " · " + rateNote : "") + "  ·  pause"
            : paused ? "Paused" + (pending ? " · " + pending + " unchecked" : "") + "  ·  resume"
            : pending ? "Check " + pending + " unchecked" : "";
        statusLabel.style.color = busy ? "#e8c66a" : paused ? "#ff9f6a" : "#c8b28a";
        filterLabel.text = currentFilter.length ? "Tags: " + currentFilter.map(function (f) { return f === "ordered" ? "L>R" : "Annotated"; }).join(" + ") + "  ×" : "";
        filterLabel.style.visibility = currentFilter.length && publicMode() ? "visible" : "collapse";
        statusLabel.style.visibility = publicMode() && statusLabel.text ? "visible" : "collapse";
        if (stats.state === "failed" && !stats.toldUser) { stats.toldUser = true; tooltip(toggleLabel, "Author records (W/L) are unavailable: " + stats.note + "."); }
    }
    function pendingCount() {
        if (listOn() && pool) return pool.entries.filter(function (e) { return e.author !== "0" && (!known[e.key] || known[e.key].annotations === null); }).length;
        return rows().filter(worthReading).length;
    }

    // ------------------------------------------------------------------ the stock list, filtered in place (filter off, or the player's own search)
    function markRow(row, verdict) {
        var p = row.panel, tag = byClass(p, "BbfTag");
        var flagged = !!(verdict && verdict.bot);
        // The game reuses row panels for other builds, so every row is re-decided on every pass.
        // Hidden with the game's own class for that: it only hides a row in the Public tab and leaves the
        // My Builds rules (own, favourited, active builds) alone. Only a class we added is ever removed.
        var protectedRow = p.BHasClass("ActiveBuild") || p.BHasClass("Favorite");
        var hide = (flagged || !passesFilter(currentFilter, row.key, row.author, row.name)) && state.on && !protectedRow;
        if (hide) { if (!p.BHasClass("HidePublic")) { p.AddClass("HidePublic"); p.SetAttributeString("bbf_hid", "1"); } }
        else if (p.GetAttributeString("bbf_hid", "") === "1") { p.RemoveClass("HidePublic"); p.SetAttributeString("bbf_hid", ""); }
        if (flagged && !hide) {
            if (!tag) {
                tag = label(byClass(p, "nameRow") || p, "BOT?", 13, "#ff8a6a");
                tag.AddClass("BbfTag");
                tag.AddClass("BbfControl");
                tag.style.marginLeft = "8px";
                tag.style.verticalAlign = "center";
            }
            tag.style.visibility = "visible";
            tooltip(tag, "Looks like an automated win-rate build (score " + verdict.score + "):<br>• " + verdict.reasons.join("<br>• "));
        } else if (tag) tag.style.visibility = "collapse";
    }
    var applySig = "";
    function apply() {
        var rowList = rows();
        learnFromDetails(rowList);
        // Nothing to redo when the same rows are showing and nothing that decides a verdict changed.
        var sig = version + "|" + state.on + "|" + publicMode() + "|" + rowList.map(function (r) { return r.key + (r.panel.BHasClass("ActiveBuild") ? "*" : "") + (r.panel.BHasClass("Favorite") ? "+" : ""); }).join("\n");
        if (sig === applySig) return rowList;
        applySig = sig;
        lastResult = verdicts(rowList);
        hiddenCount = 0; flaggedCount = 0;
        rowList.forEach(function (r) {
            var v = lastResult[r.key];
            if (r.author === "0" && !heroKey && stockIsDefault) heroKey = r.name;
            if (v && v.bot) {
                flaggedCount++;
                if (state.on && publicMode() && !r.panel.BHasClass("ActiveBuild") && !r.panel.BHasClass("Favorite")) hiddenCount++;
            }
            markRow(r, v);
            if (r.author !== "0") statsLabels({}, r.panel, r.author, r.name, byClass(r.panel, "nameRow") || r.panel, null);
        });
        return rowList;
    }
    // Check the rows of the stock list as it is, then put back the build the player was looking at.
    async function scanStock(all) {
        if (busy || !publicMode() || loading()) return;
        var todo = rows().filter(function (r) { return r.author !== "0" && (all || worthReading(r)); }).slice(0, CONFIG.scanMaxRows);
        if (!todo.length) { apply(); return; }
        busy = true; stopWork = false; paused = false;
        var startId = detailsId();
        try {
            await readRows(todo, "Checking");
        } finally {
            busy = false; progress = "";
            saveKnown();
            if (!paused && startId && detailsId() !== startId && publicMode()) {
                var back = rows().filter(function (r) { return known[r.key] && known[r.key].id === startId; })[0];
                if (back) { click(back.panel); lastDetailsId = startId; }
            }
            apply(); render();
            log((paused ? "paused while checking; " : "checked the list; ") + flaggedCount + " builds look automated");
        }
    }

    // ------------------------------------------------------------------ author records + favourites (deadlock-api.com)
    // The game only shares hero records with friends and never shows favourite counts, so both come
    // from deadlock-api.com. Panorama scripts cannot reach the network, but the game's web view can:
    // a tiny page (relay/stats.html, served by GitHub Pages) asks the API and hands the answer back
    // through its title, in chunks: "BBF1|<request>|<i>/<n>|<chunk>" (or "|ok|" for a one-part
    // answer from older copies of the page, or "|err|<why>").
    //   stats: { cmd: "stats", ids, hero } -> "account:wins:matches,..."
    //   favs:  { cmd: "favs", hero, limit } -> "min:<least favourites listed>,author:namehash:favs:weekly,..."
    //          for the hero's most favourited builds (namehash: fnv1a of the build name, 8 hex digits).
    var STATS_PAGE = '<!doctype html><meta charset="utf-8"><title>BBF</title><script>(function(){' +
        'var API="https://api.deadlock-api.com/v1/";' +
        'function fnv(s){var h=0x811c9dc5;for(var i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)>>>0}return("0000000"+h.toString(16)).slice(-8)}' +
        'function send(r,s){var n=Math.max(1,Math.ceil(s.length/3500)),i=0;if(n===1){document.title="BBF1|"+r+"|ok|"+s;return}' +
        '(function next(){if(i>=n)return;document.title="BBF1|"+r+"|"+i+"/"+n+"|"+s.slice(i*3500,(i+1)*3500);i++;setTimeout(next,15)})()}' +
        'function fail(r,e){document.title="BBF1|"+r+"|err|"+((e&&e.message)||e)}' +
        'function get(u){return fetch(u).then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.json()})}' +
        'function run(){var P;try{P=JSON.parse(decodeURIComponent(location.hash.slice(1)))}catch(e){return}' +
        'if(P.cmd==="favs"){get(API+"builds?hero_id="+P.hero+"&only_latest=true&sort_by=favorites&sort_direction=desc&limit="+(P.limit|0||400)).then(function(a){' +
        'var o=[],min=-1;for(var i=0;i<a.length;i++){var b=a[i],h=b.hero_build||{},f=b.num_favorites|0;min=min<0?f:Math.min(min,f);o.push(h.author_account_id+":"+fnv(String(h.name||""))+":"+f+":"+(b.num_weekly_favorites|0))}' +
        'send(P.r,"min:"+min+","+o.join(","))}).catch(function(e){fail(P.r,e)});return}' +
        'get(API+"players/hero-stats?account_ids="+P.ids.join(",")+"&hero_ids="+P.hero).then(function(a){var o=[];' +
        'for(var i=0;i<a.length;i++){var x=a[i];if(x.hero_id==P.hero)o.push(x.account_id+":"+(x.wins|0)+":"+(x.matches_played|0))}' +
        'send(P.r,o.join(","))}).catch(function(e){fail(P.r,e)})}' +
        'window.addEventListener("hashchange",run);run()})()<\/script>';
    function fnv(s) {
        var h = 0x811c9dc5;
        for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
        return ("0000000" + h.toString(16)).slice(-8);
    }
    var SC = CONFIG.stats;
    var stats = { heroId: 0, heroName: "", data: {}, state: "off", note: "", req: 0, cur: null, parts: null, sentAt: 0, nextAt: 0, fails: 0, view: null };
    var favs = { data: null, min: -1, tried: 0 };   // "author|namehash" -> [favourites, weekly]
    function heroFromDefaultName(name) {
        if (!name) return null;
        var probe = $.CreatePanel("Panel", popup, ""), hit = null;
        probe.style.visibility = "collapse";
        Object.keys(HERO_IDS).some(function (cls) {
            var heroName = loc("#" + cls, probe);
            if (!heroName || heroName.charAt(0) === "#") return false;
            probe.SetDialogVariable("hero_name", heroName);
            if (loc("#Citadel_HeroBuilds_DefaultHeroBuild", probe) === name || loc("#Citadel_HeroBuilds_BeginnerHeroBuild", probe) === name) {
                hit = { id: HERO_IDS[cls], name: heroName };
                return true;
            }
            return false;
        });
        try { probe.DeleteAsync(0); } catch (e) {}
        return hit;
    }
    function statsKey() { return "bbf3_stats_" + stats.heroId; }
    function favsKey() { return "bbf3_favs_" + stats.heroId; }
    function startStats() {
        if (!CONFIG.authorStats || stats.state !== "off" || !heroKey) return;
        var hero = heroFromDefaultName(heroKey);
        if (!hero) { stats.state = "failed"; stats.note = "could not tell which hero this is"; return; }
        stats.heroId = hero.id; stats.heroName = hero.name;
        var kept = recall(statsKey(), null);
        if (kept && now() - kept.at < SC.reuseSeconds) stats.data = kept.data || {};
        var keptFavs = recall(favsKey(), null);
        if (keptFavs && now() - keptFavs.at < SC.reuseSeconds) { favs.data = keptFavs.data; favs.min = keptFavs.min; }
        stats.state = "ready";
        version++;
    }
    function statsView() {
        if (valid(stats.view)) return stats.view;
        var holder = $.CreatePanel("Panel", popup, "");
        holder.AddClass("BbfControl");
        holder.style.width = "1px"; holder.style.height = "1px"; holder.style.opacity = "0";
        stats.view = $.CreatePanel("CitadelHTMLPanel", holder, "");
        stats.view.style.width = "100%"; stats.view.style.height = "100%";
        $.RegisterEventHandler("HTMLTitle", stats.view, function (panel, title) { try { onStatsTitle(String(title)); } catch (e) { statsFailed("answer could not be read"); } });
        $.RegisterEventHandler("HTMLURLChanged", stats.view, function (panel, url) { if (String(url).indexOf("http://error/") === 0) statsFailed("the web view could not open the page"); });
        return stats.view;
    }
    function statsUrl(cmd) {
        var hash = "#" + encodeURIComponent(JSON.stringify(cmd));
        return (SC.relayUrl ? SC.relayUrl.split("#")[0] : "data:text/html;charset=utf-8," + encodeURIComponent(STATS_PAGE)) + hash;
    }
    function send(cmd) {
        stats.req++;
        cmd.r = stats.req;
        stats.cur = cmd;
        stats.parts = null;
        stats.state = "waiting";
        stats.sentAt = now();
        try { statsView().SetURL(statsUrl(cmd)); }
        catch (e) { statsFailed("the game's web view is not available"); }
    }
    function onStatsTitle(title) {
        if (title.indexOf("BBF1|") !== 0 || stats.state !== "waiting") return;
        var a = title.indexOf("|", 5), b = a < 0 ? -1 : title.indexOf("|", a + 1);
        if (b < 0 || Number(title.slice(5, a)) !== stats.req) return;
        var kind = title.slice(a + 1, b), body = title.slice(b + 1);
        if (kind === "err") { statsFailed(body || "request failed"); return; }
        if (kind === "ok") { finish(body); return; }
        var slash = kind.indexOf("/"), i = Number(kind.slice(0, slash)), n = Number(kind.slice(slash + 1));
        if (!(n > 0) || !(i >= 0 && i < n)) return;
        if (!stats.parts || stats.parts.length !== n) stats.parts = new Array(n);
        stats.parts[i] = body;
        stats.sentAt = now();
        for (var k = 0; k < n; k++) if (stats.parts[k] === undefined) return;
        finish(stats.parts.join(""));
    }
    function finish(body) {
        var cmd = stats.cur;
        var recs = body ? body.split(",") : [];
        if (cmd.cmd === "favs") {
            favs.data = {};
            recs.forEach(function (rec) {
                var f = rec.split(":");
                if (f[0] === "min") favs.min = Number(f[1]);
                else if (f.length === 4) favs.data[f[0] + "|" + f[1]] = [Number(f[2]) || 0, Number(f[3]) || 0];
            });
            keep(favsKey(), { at: now(), data: favs.data, min: favs.min });
            log("favourites: " + Object.keys(favs.data).length + " most favourited builds");
        } else {
            cmd.ids.forEach(function (id) { stats.data[id] = { w: 0, m: 0 }; });   // asked about and not listed: no recorded games
            recs.forEach(function (rec) {
                var f = rec.split(":");
                if (f.length === 3) stats.data[f[0]] = { w: Number(f[1]) || 0, m: Number(f[2]) || 0 };
            });
            keep(statsKey(), { at: now(), data: stats.data });
        }
        stats.state = "ready"; stats.fails = 0; stats.cur = null; stats.parts = null; stats.note = "";
        stats.nextAt = now() + SC.minSpacingSeconds;
        version++;
    }
    function statsFailed(why) {
        if (stats.cur && stats.cur.cmd === "favs") favs.tried++;
        stats.fails++;
        stats.note = why;
        stats.cur = null; stats.parts = null;
        log("author records: " + why);
        // A few failures in a row: give up for this browser (the cause will not go away by itself).
        stats.state = stats.fails >= 3 ? "failed" : "ready";
        stats.nextAt = now() + SC.minSpacingSeconds * Math.pow(4, stats.fails);
    }
    // Favourites first (one request per hero), then records for the authors on screen we lack.
    var statsAuthorsVersion = -1, statsWant = [];
    function statsTick(authorsOf) {
        if (stats.state === "off") startStats();
        if (stats.state === "waiting" && now() - stats.sentAt > SC.timeoutSeconds) statsFailed("no answer from deadlock-api.com");
        if (stats.state !== "ready" || now() < stats.nextAt) return;
        if (!favs.data && favs.tried < 2) { send({ cmd: "favs", hero: stats.heroId, limit: SC.favsLimit }); return; }
        if (statsAuthorsVersion !== version) {
            statsAuthorsVersion = version;
            var seen = {};
            statsWant = [];
            authorsOf().forEach(function (a) { if (a && a !== "0" && !stats.data[a] && !seen[a]) { seen[a] = true; statsWant.push(a); } });
        }
        if (statsWant.length) { send({ cmd: "stats", ids: statsWant.slice(0, SC.batch), hero: stats.heroId }); statsWant = statsWant.slice(SC.batch); }
    }
    function compact(n) {
        if (!(n >= 0)) return "";
        if (n < 1000) return String(n);
        if (n < 100000) return (Math.floor(n / 100) / 10) + "k";
        return Math.floor(n / 1000) + "k";
    }
    // Favourites of a build: the API's count when it is among the most favourited, "fewer than the
    // least of those" otherwise; null while unknown.
    function favInfo(author, name) {
        if (!favs.data || !author || author === "0") return null;
        var f = favs.data[author + "|" + fnv(name)];
        if (f) return { n: f[0], w: f[1] };
        return favs.min > 0 ? { below: favs.min } : null;
    }
    // The record and favourite labels of a row (ours or the game's). `refs` caches the label panels.
    function statsLabels(refs, row, author, name, anchor, before) {
        if (!refs.box || !valid(refs.box)) {
            refs.box = byClass(row, "BbfStats");
            if (!refs.box) {
                refs.box = $.CreatePanel("Panel", anchor, "");
                refs.box.AddClass("BbfStats"); refs.box.AddClass("BbfControl");
                refs.box.style.flowChildren = "right";
                refs.box.style.verticalAlign = "center";
                refs.box.style.marginRight = "8px";
                refs.box.style.marginLeft = "8px";
                if (before && before.GetParent() === anchor) { try { anchor.MoveChildBefore(refs.box, before); } catch (e) {} }
                var rec = label(refs.box, "", 15, "#d8cbb4"); rec.AddClass("BbfRecord"); rec.style.verticalAlign = "center";
                var fv = label(refs.box, "", 15, "#c8b28a"); fv.AddClass("BbfFav"); fv.style.verticalAlign = "center"; fv.style.marginLeft = "10px";
            }
            refs.rec = byClass(refs.box, "BbfRecord"); refs.fav = byClass(refs.box, "BbfFav");
        }
        var d = author && author !== "0" ? stats.data[author] : null, fi = favInfo(author, name);
        var sig = (d ? d.w + "/" + d.m : "-") + "|" + (fi ? (fi.below ? "<" + fi.below : fi.n + "/" + fi.w) : "-") + "|" + stats.heroName;
        if (refs.box.GetAttributeString("bbf_sig", "") === sig) return;
        refs.box.SetAttributeString("bbf_sig", sig);
        if (d) {
            var l = Math.max(0, d.m - d.w), rate = d.m ? d.w / d.m : 0;
            refs.rec.text = d.w + "W " + l + "L";
            refs.rec.style.color = d.m === 0 ? "#ff8a6a" : d.m >= 5 && rate < 0.42 ? "#ffb36a" : d.m >= 10 && rate >= 0.55 ? "#9be7a9" : "#d8cbb4";
            refs.rec.style.visibility = "visible";
            tooltip(refs.rec, "The author's record on " + (stats.heroName || "this hero") + ": " + d.w + " wins, " + l + " losses" +
                (d.m ? " (" + Math.round(rate * 100) + "% of " + d.m + " matches)" : "") +
                ".<br>From the public matches deadlock-api.com has recorded; it does not have every match, so 0W 0L means none recorded, not necessarily never played.");
        } else refs.rec.style.visibility = "collapse";
        if (fi) {
            refs.fav.text = fi.below ? "★ <" + compact(fi.below) : "★ " + compact(fi.n);
            refs.fav.style.visibility = "visible";
            tooltip(refs.fav, fi.below ? "Fewer than " + fi.below + " favourites (not among this hero's " + Object.keys(favs.data).length + " most favourited builds)."
                : fi.n + " favourites" + (fi.w ? ", " + fi.w + " this week" : "") + ".<br>From deadlock-api.com.");
        } else refs.fav.style.visibility = "collapse";
    }

    // ------------------------------------------------------------------ our public list
    var ownList = null, moreRow = null, moreLabel = null;
    if (canFill) {
        // Created in this layout's context: snippets are looked up in the layout file of a panel's
        // context, and `main` belongs to the build selector's own layout, which has no BbfRow.
        ownList = $.CreatePanelWithCurrentContext(main);
        ownList.AddClass("BbfList");
        ownList.AddClass("BbfControl");
        main.MoveChildAfter(ownList, list);
        moreRow = $.CreatePanel("Panel", ownList, "");
        var snippetOk = false;
        try { snippetOk = moreRow.BLoadLayoutSnippet("BbfMore") !== false; } catch (e) {}
        moreLabel = child(moreRow, "BbfMoreLabel");
        if (!snippetOk || !moreLabel) {
            // Without our snippets there is no list to draw: filter the stock list in place instead.
            log("layout snippets not found; filtering the game's list in place instead");
            try { ownList.DeleteAsync(0); } catch (e) {}
            ownList = null; moreRow = null; moreLabel = null; canFill = false;
        } else {
            moreRow.SetPanelEvent("onactivate", function () { if (!busy) { paused = false; stopWork = false; loadMore("asked"); } });
        }
    }
    function listOn() { return !!(ownList && state.on && publicMode() && !userSearch); }
    function setOn(on) {
        state.on = on;
        keep("bbf2_state", state);
        if (!on) { if (busy) pause("filter switched off"); restoreStock(); }
        apply(); render(); drawControl();
    }
    var listWidth = 0;
    function fitList() {
        var scale = ownList.actualuiscale_x || 1;
        var width = Math.round((main.actuallayoutwidth - details.actuallayoutwidth) / scale);
        if (width > 0 && width !== listWidth) { listWidth = width; ownList.style.width = width + "px"; }
    }

    // entry: { key, author, name, id, desc, classes[] }
    function poolKey() { return "bbf3_pool_" + heroKey; }
    function savePool() { if (pool && heroKey) { pool.at = now(); keep(poolKey(), pool); } }
    function ensurePool() {
        if (pool) return;
        var kept = heroKey ? recall(poolKey(), null) : null;
        pool = kept && now() - kept.at < CONFIG.poolReuseSeconds ? kept : { at: now(), entries: [], term: 0, exhausted: false };
        version++;
    }
    // The build's tags (up to three): standard tags, abilities or items. The tag panel only shows a
    // name ({s:tag_name}) and an icon; the icon is found by name from the game's own data.
    var tagIcons = null;
    var OWN_TAGS = { annotated: { name: "Annotated", icon: "s2r://panorama/images/bot_build_filter/tag_annotated.vsvg", tip: "Annotated: its items carry notes." },
                     ordered: { name: "L>R", icon: "s2r://panorama/images/bot_build_filter/tag_ordered.vsvg", tip: "L>R: the build says which order to buy in." } };
    function tagIcon(name) {
        if (!tagIcons) {
            tagIcons = {};
            var probe = $.CreatePanel("Panel", popup, "");
            probe.style.visibility = "collapse";
            ABILITY_IMAGES.forEach(function (e) { var n = loc("#" + e[0], probe); if (n && n.charAt(0) !== "#" && !tagIcons[n]) tagIcons[n] = e[1]; });
            STANDARD_TAGS.forEach(function (k) { var n = loc("#citadel_build_tag_" + k, probe); if (n && n.charAt(0) !== "#") tagIcons[n] = "s2r://panorama/images/builds/citadel_build_tag_" + k + ".vsvg"; });
            try { probe.DeleteAsync(0); } catch (e) {}
        }
        return tagIcons[name] || "";
    }
    var tagDumped = false;
    function tagName(t) {
        var name = loc("{s:tag_name}", t);
        if (!name) {
            var l = child(t, "TagLabel"), txt = l ? String(l.text || "") : "";
            if (txt && txt.charAt(0) !== "#" && txt.indexOf("{") < 0) name = txt;
        }
        return name;
    }
    // Once per session: what a stock tag panel offers a script (to improve tag copying later).
    function dumpTag(t, name) {
        if (tagDumped || recall("bbf3_tag_dumped", false)) return;
        tagDumped = true;
        keep("bbf3_tag_dumped", true);
        var img = child(t, "TagImage"), keys = [];
        try { for (var k in img) keys.push(k); } catch (e) {}
        var l = child(t, "TagLabel");
        log("debug tag: name=" + JSON.stringify(name) + " label=" + JSON.stringify(l ? String(l.text) : null) + " empty=" + t.BHasClass("Empty") +
            " image keys=" + keys.slice(0, 60).join(","));
    }
    function tagsOf(panel) {
        var out = [];
        for (var i = 1; i <= 3; i++) {
            var t = child(panel, "BuildTag" + i);
            if (!valid(t) || t.BHasClass("Empty")) continue;
            var name = tagName(t);
            dumpTag(t, name);
            if (name) out.push(name);
        }
        return out;
    }
    // Our rows' tag chips are plain panels (BbfTagChip): an icon when the name is known, else the name.
    function drawTags(refs, tags, own) {
        var list = tags.slice(0, 3).map(function (n) { return { name: n, icon: tagIcon(n), tip: n, own: false }; });
        // Three chips at most, like the game: the build's own tags first, ours in the slots left over.
        if (own) ["annotated", "ordered"].forEach(function (k) { if (own[k] && list.length < 3) list.push({ name: OWN_TAGS[k].name, icon: OWN_TAGS[k].icon, tip: OWN_TAGS[k].tip, own: true }); });
        var sig = list.map(function (t) { return t.name; }).join("|");
        if (refs.tagSig === sig) return;
        refs.tagSig = sig;
        for (var i = 0; i < refs.tags.length; i++) {
            var chip = refs.tags[i], t = list[i];
            if (!t) { chip.panel.style.visibility = "collapse"; continue; }
            chip.panel.style.visibility = "visible";
            chip.panel.SetHasClass("BbfOwnTag", t.own);
            var icon = t.icon;
            if (icon && chip.img) { try { chip.img.SetImage(icon); } catch (e) { icon = ""; } }
            if (chip.img) chip.img.style.visibility = icon ? "visible" : "collapse";
            if (chip.label) { chip.label.text = t.name; chip.label.style.visibility = icon ? "collapse" : "visible"; }
            tooltip(chip.panel, t.tip);
        }
    }
    function entryFor(r) {
        var k = known[r.key] || {};
        return { key: r.key, author: r.author, name: r.name, id: k.id || 0, desc: k.desc || "", classes: rowClasses(r.panel), tags: tagsOf(r.panel) };
    }
    // Add stock rows that are not bot builds; `front` puts new ones before what is already listed
    // (the normal list leads; Valve's default builds always go last when shown).
    function addRows(rowList, front) {
        var have = {}, added = [], result = verdicts(rowList);
        pool.entries.forEach(function (e) { have[e.key] = e; });
        rowList.forEach(function (r) {
            var e = have[r.key];
            if (e) { var k = known[r.key]; if (k && k.id) e.id = k.id; if (k) e.desc = k.desc || e.desc; e.classes = rowClasses(r.panel); var tg = tagsOf(r.panel); if (tg.length) e.tags = tg; return; }
            if (result[r.key] && result[r.key].bot) return;
            e = entryFor(r);
            have[r.key] = e;
            added.push(e);
        });
        if (front) pool.entries = added.concat(pool.entries); else pool.entries = pool.entries.concat(added);
        version++;
        return added.length;
    }
    // What the list shows: pool entries that are not (or no longer) bot builds, Valve's default builds last.
    var shownCache = null, shownVersion = -1;
    function shownEntries() {
        if (!pool) return [];
        if (shownCache && shownVersion === version) return shownCache;
        var result = verdicts(pool.entries);
        var out = pool.entries.filter(function (e) { return !result[e.key].bot && passesFilter(currentFilter, e.key, e.author, e.name); });
        shownVersion = version;
        return (shownCache = out.filter(function (e) { return e.author !== "0"; }).concat(out.filter(function (e) { return e.author === "0"; })));
    }
    function nextTerm() {
        var words = CONFIG.searchWords.concat(ITEM_NAMES);
        if (pool.term >= words.length) { pool.exhausted = true; return null; }
        return words[pool.term++];
    }

    // Preview the unchecked builds of the stock list as it is now, and fold the results into the pool.
    async function verifyCurrent(what) {
        var todo = rows().filter(worthReading).slice(0, CONFIG.scanMaxRows);
        if (todo.length) await readRows(todo, what);
        saveKnown();
    }
    // Opening: the normal list's human builds first, checked; then enough loading to fill a screen.
    async function verifyList() {
        if (busy || !listOn() || loading()) return;
        busy = true; stopWork = false; paused = false;
        try {
            if (!stockIsDefault) { restoreStock(); await waitFor(loading, 0.6); await waitFor(function () { return !loading(); }, CONFIG.searchTimeoutSeconds); }
            ensurePool();
            addRows(rows(), true); render();
            await verifyCurrent("Checking");
            addRows(rows(), true);
            savePool();
            var checked = pool.entries.filter(function (e) { return known[e.key] && known[e.key].annotations !== null; });
            log("checked " + checked.length + " builds; item notes found on " + checked.filter(function (e) { return known[e.key].annotations.length; }).length +
                ", L>R on " + checked.filter(function (e) { var t = ownTagsOf(e.key, e.author, e.name); return t && t.ordered; }).length);
        } catch (e) { log("verify: " + e); pause("an error while checking"); }
        finally { busy = false; progress = ""; render(); }
        if (!paused && shownEntries().length < CONFIG.minRows) loadMore("fill");
    }
    // One "load more": search until batchMinNew new builds were added (or batchMaxSearches searches).
    async function loadMore(why) {
        if (busy || !listOn() || paused) return;
        ensurePool();
        if (pool.exhausted) { drawMore(); return; }
        busy = true; stopWork = false;
        selectedKey = null;   // previews are about to move the details pane
        var added = 0, searches = 0;
        try {
            while (searches < CONFIG.batchMaxSearches && added < CONFIG.batchMinNew && !stopWork && !paused && listOn()) {
                var term = nextTerm();
                if (term === null) break;
                searches++;
                progress = "Loading more (\"" + term + "\")";
                drawControl(); drawMore();
                var got = await search(term);
                if (!got) continue;
                // Rows whose text or account already marks them as bots are dropped without a preview.
                await verifyCurrent("Loading more: checking");
                added += addRows(rows(), false);
                savePool();
                render();
            }
        } catch (e) { log("load more: " + e); pause("an error while loading more"); }
        finally {
            busy = false; progress = "";
            savePool();
            render();
            log("load more (" + why + "): +" + added + " builds from " + searches + " searches, " + shownEntries().length + " listed");
        }
        if (!paused && !pool.exhausted && listOn() && shownEntries().length < CONFIG.minRows) $.Schedule(0.1, function () { if (alive) loadMore("fill"); });
    }

    // ------------------------------------------------------------------ picking builds in our list
    function stockRowFor(e) { return rows().filter(function (r) { return r.key === e.key; })[0] || null; }
    var pickSeq = 0;
    async function load(e) {
        var seq = ++pickSeq;
        selectedKey = e.key;
        render();
        if (busy) { pause(); await waitFor(function () { return !busy; }, 12); }
        stopWork = false;   // background work stays paused; this search is the player's own
        var row = stockRowFor(e);
        if (!row && e.id) {
            busy = true; userLoading = true;
            progress = "Loading " + e.name;
            drawControl();
            try { await search(e.id, true); } finally { busy = false; userLoading = false; progress = ""; }
            row = stockRowFor(e);
        }
        if (seq !== pickSeq) return null;
        if (!row) { log("could not load " + e.name); if (selectedKey === e.key) selectedKey = null; render(); return null; }
        if (!(e.id && detailsId() === e.id)) {
            click(row.panel);
            await waitFor(function () { return detailsName() === e.name; }, 1.5);
        }
        lastDetailsId = detailsId();
        drawControl();
        return row;
    }
    async function use(e) {
        var row = await load(e);
        if (!row) return;
        var button = firstOfType(row.panel, "CitadelButton");   // the stock row's own "Use Build"
        if (button) click(button);
        else try { $.DispatchEvent("CitadelBuildBrowserPopupConfirmBuild", selector); } catch (err) {}
    }
    async function favourite(e) {
        var row = await load(e);
        var star = row ? child(row.panel, "FavoriteIcon") : null;
        if (!star) return;
        click(star);
        var on = e.classes.indexOf("Favorite") < 0;
        e.classes = e.classes.filter(function (c) { return c !== "Favorite"; });
        if (on) e.classes.push("Favorite");
        version++;
        savePool();
        render();
    }

    // ------------------------------------------------------------------ drawing our list
    var ownRows = {}, ownRefs = {};
    function makeRow(e) {
        var r = $.CreatePanel("Panel", ownList, "");
        r.BLoadLayoutSnippet("BbfRow");
        var refs = { tags: [], tagSig: null, info: byClass(r, "InfoContainer") || r, star: child(r, "FavoriteIcon"), nameArea: child(r, "BuildNameArea"), desc: null, cls: "" };
        for (var i = 1; i <= 3; i++) {
            var chip = child(r, "BuildTag" + i);
            if (chip) refs.tags.push({ panel: chip, img: child(chip, "TagImage"), label: child(chip, "TagLabel") });
        }
        ownRefs[e.key] = refs;
        r.AddClass("PublicBuild");
        r.SetDialogVariable("selected_hero_build_name", e.name);
        r.SetDialogVariable("obsolete_tag", "");
        try { var av = child(r, "AuthorAvatar"); if (av && e.author && e.author !== "0") av.SetAccountID(Number(e.author)); } catch (err) {}
        r.SetPanelEvent("onactivate", function () { load(e); });
        r.SetPanelEvent("ondblclick", function () { use(e); });
        var useButton = firstOfType(r, "CitadelButton");
        if (useButton) useButton.SetPanelEvent("onactivate", function () { use(e); });
        var star = child(r, "FavoriteIcon");
        if (star) star.SetPanelEvent("onactivate", function () { favourite(e); });
        return r;
    }
    function syncRow(r, e, live) {
        var refs = ownRefs[e.key];
        if (live) { var tg = tagsOf(live.panel); if (tg.length) e.tags = tg; }
        drawTags(refs, e.tags || [], ownTagsOf(e.key, e.author, e.name));
        if (e.author !== "0") statsLabels(refs, r, e.author, e.name, refs.info, refs.star);
        var want = live ? rowClasses(live.panel) : e.classes.slice();
        if (e.key === selectedKey) want.push("Selected");
        if (e.author !== "0" && (!known[e.key] || known[e.key].annotations === null)) want.push("BbfUnchecked");
        var cls = want.join(" ");
        if (refs.cls !== cls) {
            refs.cls = cls;
            ROW_CLASSES.concat(["Selected", "BbfUnchecked"]).forEach(function (c) { r.SetHasClass(c, want.indexOf(c) >= 0); });
        }
        if (e.desc && refs.desc !== e.desc && refs.nameArea) {
            refs.desc = e.desc;
            tooltip(refs.nameArea, e.desc.length > 500 ? e.desc.slice(0, 500) + "..." : e.desc);
        }
    }
    var renderSig = "";
    function render() {
        drawControl();
        if (!ownList) return;
        var on = listOn() && !!pool;
        ownList.SetHasClass("BbfShown", on);
        if (!on) { renderSig = ""; return; }
        fitList();
        // Rows are only re-synced when something they show changed.
        var stock = rows(), live = {};
        stock.forEach(function (r) { live[r.key] = r; });
        var sig = version + "|" + selectedKey + "|" + stock.map(function (r) { return r.key + (r.panel.BHasClass("ActiveBuild") ? "*" : "") + (r.panel.BHasClass("Favorite") ? "+" : ""); }).join("\n");
        if (sig === renderSig) { drawMore(); return; }
        renderSig = sig;
        var entries = shownEntries(), wanted = {};
        var prev = null;
        entries.forEach(function (e, i) {
            wanted[e.key] = true;
            var r = ownRows[e.key];
            if (!valid(r)) { r = makeRow(e); ownRows[e.key] = r; }
            syncRow(r, e, live[e.key]);
            // Keep list order: each row right after the previous one (the first one at the top).
            if (ownList.GetChild(i) !== r) {
                if (prev) ownList.MoveChildAfter(r, prev);
                else ownList.MoveChildBefore(r, ownList.GetChild(0));
            }
            prev = r;
        });
        Object.keys(ownRows).forEach(function (k) { if (!wanted[k]) { try { ownRows[k].DeleteAsync(0); } catch (err) {} delete ownRows[k]; delete ownRefs[k]; } });
        if (prev) ownList.MoveChildAfter(moreRow, prev);
        drawMore();
    }
    function drawMore() {
        if (!moreRow || !moreLabel || !pool) return;
        var text;
        if (busy && progress.indexOf("Loading more") === 0) text = progress + (rateNote ? "  ·  " + rateNote : "") + "...";
        else if (rateNote) text = "Waiting: " + rateNote;
        else if (pool.exhausted) text = "That's every build the searches found";
        else if (paused) text = "Paused. Click to load more builds";
        else text = "Scroll down or click to load more builds";
        moreLabel.text = text;
        moreRow.SetHasClass("BbfLoading", busy);
    }
    // Near the bottom of our list (or the list does not fill the view yet).
    function nearBottom() {
        var h = ownList.actuallayoutheight, ch = ownList.contentheight, y = ownList.scrolloffset_y;
        if (!(h > 0) || typeof ch !== "number" || typeof y !== "number") return false;
        var scale = ownList.actualuiscale_y || 1;
        return ch <= h || ch - h - Math.abs(y) < CONFIG.scrollMarginPx * scale;
    }

    // ------------------------------------------------------------------ main loop
    var ticks = 0, listSignature = "", autoScannedFor = "", wasListOn = false;
    function tick() {
        if (!valid(popup) || !valid(control)) { alive = false; return; }
        try {
            // The player typed in the search box: show their results, filtered in place.
            if (searchEntry) {
                var text = String(searchEntry.text || "");
                if (!userSearch && text && text !== ourText) { userSearch = true; stockIsDefault = false; if (busy) pause("the player searched"); render(); }
                else if (userSearch && !text) { userSearch = false; render(); }
            }
            var f = tagFilter();
            if (f.join(",") !== currentFilter.join(",")) { currentFilter = f; version++; }
            // Leaving our list (My Builds, filter off, the player's search): background work stops now.
            if (busy && !listOn() && !userLoading && ownList) stopWork = true;
            if (!busy && !loading() && ticks++ % 2 === 0) {
                var rowList = apply();
                var sig = rowList.map(function (r) { return r.key; }).join("\n");
                if (sig !== listSignature) listSignature = sig;
                if (listOn()) {
                    // Opening (or coming back to the Public tab): fold in the normal list and check it.
                    // The hero is told by Valve's default build row; without one the list still works, uncached.
                    if (!wasListOn && (heroKey || ticks > 8)) { wasListOn = true; $.Schedule(0.05, function () { if (alive) verifyList(); }); }
                    else if (wasListOn && !pool) verifyList();
                    else if (wasListOn && pool && !paused && !pool.exhausted && nearBottom()) loadMore("scrolled");
                } else {
                    wasListOn = false;
                    // My Builds filters the current results: give it the normal list back.
                    if (!publicMode() && !userSearch) restoreStock();
                    if (stockIsDefault && rowList.length && publicMode() && sig !== autoScannedFor) {
                        // A new list (another hero or search): a pause from the last one is over.
                        if (paused && autoScannedFor) paused = false;
                        autoScannedFor = sig;
                        if (CONFIG.autoScan && state.on && rowList.some(worthReading))
                            $.Schedule(0.3, function () { if (alive && listSignature === sig && !paused && !busy && !listOn()) scanStock(false); });
                    }
                }
            }
            if (CONFIG.authorStats && publicMode()) {
                statsTick(function () { return listOn() && pool ? shownEntries().slice(0, 300).map(function (e) { return e.author; }) : rows().map(function (r) { return r.author; }); });
            }
            render();
        } catch (e) { log("tick: " + e); }
        $.Schedule(0.25, tick);
    }
    log("ready (" + Object.keys(botAuthors).length + " bot accounts known this session, " + ITEM_NAMES.length + " item names)");
    $.Schedule(0.0, tick);
})();
