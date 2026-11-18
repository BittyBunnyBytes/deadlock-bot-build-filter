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
        autoScan: true,           // check builds automatically (through deadlock-api.com; previews only if previewChecks)
        // Read builds by previewing them in the details pane (visible, and heavy for the game). Off: build
        // texts come from deadlock-api.com in the background; the "Check" button can still preview on demand.
        previewChecks: false,
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
            batch: 30,            // authors per records request (the API's per-player query is heavy)
            favsLimit: 400,       // favourites: the hero's this many most favourited builds (one request)
            buildsBatch: 40,      // authors per build-text request
            minSpacingSeconds: 2, // between requests (the API allows 100 a second; this stays far below)
            timeoutSeconds: 30,
            topLimit: 150,        // builds fetched when a sort asks for a new search
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
    // v3: older copies hold builds "read" from the details pane, whose item notes the game never exposes.
    var known = recall("bbf3_known", {});        // "author|name" -> { author, desc, annotations, id, cats, fav, wfav, updated, src }
    var botAuthors = recall("bbf3_bot_authors", {});
    function saveKnown() {
        var keys = Object.keys(known);
        if (keys.length > 2500) keys.slice(0, keys.length - 2500).forEach(function (k) { delete known[k]; });
        keep("bbf3_known", known);
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
        if (!CONFIG.previewChecks) return;   // texts come from deadlock-api.com; reading the pane costs a frame
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
    // Only notes read from panels are suspect; deadlock-api.com's notes are each build's own (and the same
    // "+WR 3%" on many accounts is exactly what a bot farm looks like).
    function sharedNotes() {
        if (sharedCache) return sharedCache;
        var by = {}, out = {};
        Object.keys(known).forEach(function (k) {
            var e = known[k];
            if (e.src === "api") return;
            (e.annotations || []).forEach(function (a) { (by[a] = by[a] || {})[e.author || k.split("|")[0]] = true; });
        });
        Object.keys(by).forEach(function (a) { if (Object.keys(by[a]).length >= 3) out[a] = true; });
        return (sharedCache = out);
    }
    function ownNotes(k) {
        if (!k || !k.annotations) return [];
        if (k.src === "api") return k.annotations;
        var shared = sharedNotes();
        return k.annotations.filter(function (a) { return !shared[a]; });
    }
    function inputOf(key, author, name) {
        var k = known[key] || {};
        return { key: key, author: author, name: name, desc: k.desc || "", annotations: ownNotes(k) };
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
        if (changed) { keep("bbf3_bot_authors", botAuthors); version++; }
    }
    function ownTagsOf(key, author, name) {
        var k = known[key];
        if (!k || k.annotations === null || author === "0") return null;
        return styleTags({ name: name, desc: k.desc, cats: k.cats, annotations: ownNotes(k) });
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
    // The player's own picks only wait for the minimum spacing and the hourly cap; the burst allowance
    // and the back-off are for background searches.
    function rateWait(background) {
        var t = now();
        bucket.tokens = Math.min(R.burst, bucket.tokens + (t - bucket.at) / R.refillSeconds);
        bucket.at = t;
        searchLog = searchLog.filter(function (s) { return t - s < 3600; });
        var w = Math.max(0, bucket.nextAt - t);
        if (background) w = Math.max(w, bucket.backoffUntil - t, bucket.tokens >= 1 ? 0 : (1 - bucket.tokens) * R.refillSeconds);
        if (searchLog.length >= R.perHour) w = Math.max(w, searchLog[0] + 3600 - t);
        return w;
    }
    var rateNote = "";
    // Background searches (loading more) give up as soon as our list is not showing; the player's own
    // pick (loading a build by ID) does not.
    async function takeToken(background) {
        for (;;) {
            if (!alive || stopWork || (background && !listOn())) return false;
            var w = rateWait(background);
            if (w <= 0) break;
            rateNote = searchLog.length >= R.perHour ? "hourly search limit reached, next in " + Math.ceil(w / 60) + " min" : "next search in " + Math.ceil(w) + "s";
            drawControl(); drawMore();
            await delay(Math.min(w, 0.5));
        }
        rateNote = "";
        if (background) bucket.tokens -= 1;
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
        if (!isId) searchEntry.style.opacity = "0";   // our words are not the player's business
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
        searchEntry.style.opacity = "1";
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
    toggleLabel.AddClass("BbfToggle");
    toggleLabel.style.verticalAlign = "center";
    var cogLabel = label(control, "⚙", 18, "#FFEFD7");
    cogLabel.AddClass("BbfCog");
    cogLabel.style.marginLeft = "10px";
    cogLabel.style.verticalAlign = "center";
    cogLabel.SetPanelEvent("onactivate", function () { openPanel(settingsOpen() ? null : "settings"); });
    tooltip(cogLabel, "Settings: what to hide, how to sort, what to show on rows.");
    var sortLabel = label(control, "", 16, "#d8cbb4");
    sortLabel.AddClass("BbfSortLabel");
    sortLabel.style.marginLeft = "12px";
    sortLabel.style.verticalAlign = "center";
    sortLabel.SetPanelEvent("onactivate", function () { openPanel(sortOpen() ? null : "sort"); });
    tooltip(sortLabel, "How the list is ordered.");
    var filterLabel = label(control, "", 16, "#9fd8ff");
    filterLabel.AddClass("BbfFilterLabel");
    filterLabel.style.marginLeft = "10px";
    filterLabel.style.verticalAlign = "center";
    filterLabel.SetPanelEvent("onactivate", function () { try { tagFilter(); rootPanel.SetAttributeString("bbf3_tag_filter", ""); } catch (e) {} });
    var statusLabel = label(control, "", 16, "#c8b28a");
    statusLabel.AddClass("BbfStatus");
    statusLabel.style.marginLeft = "10px";
    statusLabel.style.verticalAlign = "center";
    toggleLabel.SetPanelEvent("onactivate", function () { setOn(!state.on); });
    // Busy: pause. Paused: resume (background work only). Idle with unchecked builds: check them in detail.
    statusLabel.SetPanelEvent("onactivate", function () {
        if (busy) { pause("paused from the control"); return; }
        if (paused) { paused = false; stopWork = false; render(); return; }
        if (listOn()) previewCheck(); else scanStock(false);
    });
    tooltip(toggleLabel, "Bot Build Filter: takes public builds generated from win rates out of the list (they plug a website, share a templated description, and annotate items with \"+WR x%\") and loads more human builds as you scroll.<br>Click to switch to the game's own list with suspected builds tagged BOT?.");
    tooltip(statusLabel, "Build texts come from deadlock-api.com in the background. Builds it does not have yet can be checked here: each is previewed once in the details pane (your active build is not changed). Clicking any build pauses this.");
    function drawControl() {
        var count = listOn() && pool ? "  ·  " + shownEntries().length + " builds" : flaggedCount ? (state.on ? "  ·  " + hiddenCount + " hidden" : "  ·  " + flaggedCount + " tagged") : "";
        toggleLabel.text = "Bot filter: " + (state.on ? "ON" : "OFF") + count;
        toggleLabel.style.color = state.on ? "#9be7a9" : "#FFEFD7";
        var pending = pendingCount();
        statusLabel.text = topState.busy || topState.wanted ? "⟳ Searching: " + sortName(S.sort).toLowerCase() + "…"
            : busy ? "⟳ " + (progress || "Working") + (rateNote ? " · " + rateNote : "") + "  ·  pause"
            : paused ? "Paused  ·  resume"
            : pending ? "Check " + pending + " in detail" : "";
        statusLabel.style.color = busy ? "#e8c66a" : paused ? "#ff9f6a" : "#c8b28a";
        sortLabel.text = "Sort: " + sortName(S.sort) + " ▾";
        sortLabel.style.visibility = listOn() ? "visible" : "collapse";
        filterLabel.text = currentFilter.length ? "Tags: " + currentFilter.map(function (f) { return f === "ordered" ? "L>R" : "Annotated"; }).join(" + ") + "  ×" : "";
        filterLabel.style.visibility = currentFilter.length && publicMode() ? "visible" : "collapse";
        statusLabel.style.visibility = publicMode() && statusLabel.text ? "visible" : "collapse";
        if (stats.state === "failed" && !stats.toldUser) { stats.toldUser = true; tooltip(toggleLabel, "Author records (W/L) are unavailable: " + stats.note + "."); }
    }
    function pendingCount() {
        if (listOn() && pool) return pool.entries.filter(function (e) { return e.author !== "0" && (!known[e.key] || known[e.key].annotations === null) && apiAsked[e.author]; }).length;
        return rows().filter(function (r) { return worthReading(r) && (!CONFIG.previewChecks ? apiAsked[r.author] : true); }).length;
    }

    // ------------------------------------------------------------------ settings (the ⚙ panel) and sorting
    // Kept for the game session on the popup manager, and across sessions in the lookup page's browser
    // storage (the game gives mods no files to write): "load" once, "save" after a change.
    var DEFAULTS = {
        hideBots: true, strictness: "normal", learnAccounts: true,
        sort: "game",
        hideOutdated: false, minGames: 0, minWinRate: 0, minFavs: 0, maxAgeDays: 0,
        showRecord: true, showFavs: true, showTags: true,
        autoLoad: true, pace: "normal"
    };
    var SORTS = [
        ["game", "Game order", "As the game listed them, then the builds found while scrolling."],
        ["favs", "Most favourited", "Builds with the most favourites first."],
        ["trending", "Trending", "Most favourites this week first."],
        ["updated", "Latest updated", "Most recently updated builds first."],
        ["played", "Most played", "Authors with the most games on this hero first."],
        ["wins", "Most wins", "Authors with the most wins on this hero first."],
        ["winrate", "Best win rate", "Authors with the best win rate on this hero first (5+ games)."]
    ];
    function sortName(id) { for (var i = 0; i < SORTS.length; i++) if (SORTS[i][0] === id) return SORTS[i][1]; return SORTS[0][1]; }
    function cleanSettings(v) {
        var out = {};
        Object.keys(DEFAULTS).forEach(function (k) { out[k] = v && typeof v[k] === typeof DEFAULTS[k] ? v[k] : DEFAULTS[k]; });
        return out;
    }
    var S = cleanSettings(recall("bbf3_settings", null) || { hideBots: state.on !== false });
    var settingsState = { loaded: false, tried: false, saveWanted: false, since: Date.now() };
    // Automatic loading waits for the saved settings (they may turn it off), at most a few seconds.
    function settingsReady() {
        return settingsState.loaded || !CONFIG.authorStats || stats.state === "failed" || Date.now() - settingsState.since > 5000;
    }
    function applySettings() {
        state.on = S.hideBots;
        CONFIG.threshold = { relaxed: 4, normal: 3, strict: 2 }[S.strictness] || 3;
        CONFIG.learnAuthors = S.learnAccounts;
        R.burst = S.pace === "gentle" ? 2 : 3;
        R.refillSeconds = S.pace === "gentle" ? 8 : 4;
        version++;
    }
    // A sort that is not the game's order asks deadlock-api for this hero's builds in that order (once per
    // order and list); the author sorts get the most favourited builds as a wider pool to rank.
    var TOP_SORT = { favs: "favorites", trending: "weekly_favorites", updated: "updated_at", played: "favorites", wins: "favorites", winrate: "favorites" };
    var topState = { wanted: null, busy: false, done: {} };
    function sortSearch() {
        var by = TOP_SORT[S.sort];
        if (!by || !canFill) return;
        if (pool && pool.topDone && pool.topDone[by]) { scrollToTop(); return; }
        if (pool) { pool.topDone = pool.topDone || {}; pool.topDone[by] = true; }
        topState.wanted = by;
        scrollToTop();
    }
    function scrollToTop() { try { if (ownList) ownList.ScrollToTop(); } catch (e) {} }
    function changeSetting(k, v) {
        var sortChanged = k === "sort" && S.sort !== v;
        S[k] = v;
        keep("bbf3_settings", S);
        settingsState.saveWanted = true;
        if (k === "hideBots") { setOn(v); }
        applySettings();
        if (sortChanged) sortSearch();
        drawSettings();
        render();
    }
    // Why a build is hidden by the player's settings ("" = it is not). Data still loading never hides.
    function hiddenBySettings(e) {
        if (e.author === "0") return "";
        if (S.hideOutdated && e.classes.indexOf("ObsoleteBuild") >= 0) return "outdated";
        var k = known[e.key];
        if (S.minFavs > 0 && k && typeof k.fav === "number" && k.fav < S.minFavs) return "favourites";
        if (S.maxAgeDays > 0 && k && k.updated && now() - k.updated > S.maxAgeDays * 86400) return "not updated";
        var d = stats.data[e.author];
        if (S.minGames > 0 && d && d.m < S.minGames) return "author's games";
        if (S.minWinRate > 0 && d && d.m >= 5 && d.w * 100 < S.minWinRate * d.m) return "author's win rate";
        return "";
    }
    function sortValue(e) {
        var k = known[e.key] || {}, d = stats.data[e.author];
        switch (S.sort) {
            case "favs": return typeof k.fav === "number" ? k.fav : -1;
            case "trending": return typeof k.wfav === "number" ? k.wfav : -1;
            case "updated": return k.updated || -1;
            case "played": return d ? d.m : -1;
            case "wins": return d ? d.w : -1;
            case "winrate": return d && d.m >= 5 ? d.w / d.m : -1;
        }
        return 0;
    }
    function sortEntries(list) {
        if (S.sort === "game") return list;
        var withIndex = list.map(function (e, i) { return { e: e, i: i, v: sortValue(e) }; });
        withIndex.sort(function (a, b) { return (b.v - a.v) || (a.i - b.i); });
        return withIndex.map(function (x) { return x.e; });
    }

    // The panels: built once, in this layout's context (so our styles apply), over the build list.
    var panelHost = main || selector, settingsPanel = null, sortPanel = null, openName = null;
    function settingsOpen() { return openName === "settings"; }
    function sortOpen() { return openName === "sort"; }
    function openPanel(name) {
        openName = name;
        if (name === "settings" && !settingsPanel) buildSettings();
        if (name === "sort" && !sortPanel) buildSort();
        if (settingsPanel) settingsPanel.SetHasClass("BbfOpen", name === "settings");
        if (sortPanel) sortPanel.SetHasClass("BbfOpen", name === "sort");
        drawSettings();
    }
    var settingRows = [];
    function newPanel(cls) {
        var p = $.CreatePanelWithCurrentContext(panelHost);
        p.AddClass(cls); p.AddClass("BbfControl");
        return p;
    }
    function textLabel(parent, cls, text) { var l = $.CreatePanel("Label", parent, ""); l.AddClass(cls); l.text = text; return l; }
    function section(parent, title) { textLabel(parent, "BbfSetSection", title); }
    function settingRow(parent, title, desc) {
        var row = $.CreatePanel("Panel", parent, "");
        row.AddClass("BbfSetRow");
        var line = $.CreatePanel("Panel", row, "");
        line.AddClass("BbfSetLine");
        textLabel(line, "BbfSetTitle", title);
        var control = $.CreatePanel("Panel", line, "");
        control.AddClass("BbfSetControl");
        if (desc) textLabel(row, "BbfSetDesc", desc);
        return control;
    }
    function toggleRow(parent, key, title, desc) {
        var control = settingRow(parent, title, desc);
        var pill = textLabel(control, "BbfPill", "");
        pill.SetPanelEvent("onactivate", function () { changeSetting(key, !S[key]); });
        settingRows.push(function () { pill.text = S[key] ? "ON" : "OFF"; pill.SetHasClass("BbfPillOn", !!S[key]); });
    }
    function choiceRow(parent, key, title, desc, options) {
        var control = settingRow(parent, title, desc);
        control.AddClass("BbfChoices");
        options.forEach(function (o) {
            var c = textLabel(control, "BbfChoice", o[1]);
            c.SetPanelEvent("onactivate", function () { changeSetting(key, o[0]); });
            if (o[2]) tooltip(c, o[2]);
            settingRows.push(function () { c.SetHasClass("BbfChoiceOn", S[key] === o[0]); });
        });
    }
    function buildSettings() {
        settingsPanel = newPanel("BbfSettings");
        var head = $.CreatePanel("Panel", settingsPanel, "");
        head.AddClass("BbfSetHead");
        textLabel(head, "BbfSetHeadTitle", "Bot Build Filter settings");
        var close = textLabel(head, "BbfSetClose", "×");
        close.SetPanelEvent("onactivate", function () { openPanel(null); });
        var body = $.CreatePanel("Panel", settingsPanel, "");
        body.AddClass("BbfSetBody");

        section(body, "Bot builds");
        toggleRow(body, "hideBots", "Hide bot builds", "Builds generated from win-rate data: they plug a website, copy the same description, or note items with \"+WR 3%\".");
        choiceRow(body, "strictness", "How strict", "Strict catches more bots but may hide a few real builds.",
            [["relaxed", "Relaxed", "Only obvious bots."], ["normal", "Normal"], ["strict", "Strict", "Hides anything that looks automated."]]);
        toggleRow(body, "learnAccounts", "Remember bot accounts", "Once an account posts a bot build, hide its other builds too.");

        section(body, "Hide builds that…");
        toggleRow(body, "hideOutdated", "…are outdated", "Builds the game marks [OUTDATED]: items in them changed since they were made.");
        choiceRow(body, "minGames", "…whose author played this hero less than", "Uses public match data (deadlock-api.com). 0 games often means they never played the hero.",
            [[0, "Off"], [1, "1 game"], [5, "5"], [10, "10"], [25, "25"], [50, "50"]]);
        choiceRow(body, "minWinRate", "…whose author's win rate is below", "Only judged once the author has 5 or more recorded games on this hero.",
            [[0, "Off"], [40, "40%"], [45, "45%"], [50, "50%"], [55, "55%"]]);
        choiceRow(body, "minFavs", "…have fewer favourites than", "",
            [[0, "Off"], [10, "10"], [100, "100"], [1000, "1k"], [10000, "10k"]]);
        choiceRow(body, "maxAgeDays", "…were not updated within", "",
            [[0, "Off"], [7, "a week"], [30, "a month"], [90, "3 months"], [180, "6 months"], [365, "a year"]]);

        section(body, "Sort");
        choiceRow(body, "sort", "Order the list by", "Builds still loading their data go last.", SORTS.map(function (x) { return [x[0], x[1], x[2]]; }));

        section(body, "Show on each build");
        toggleRow(body, "showRecord", "The author's record", "Wins and losses on this hero, e.g. 30W 22L.");
        toggleRow(body, "showFavs", "Favourites", "How many players favourited the build.");
        toggleRow(body, "showTags", "Tags", "The build's tags, plus Annotated and L>R.");

        section(body, "Loading");
        toggleRow(body, "autoLoad", "Load more builds when scrolling", "Off: only when you click the bottom of the list.");
        choiceRow(body, "pace", "Search pace", "Each search is one request to the game's servers.",
            [["normal", "Normal", "Up to 15 searches a minute."], ["gentle", "Gentle", "Up to 7 a minute."]]);

        var foot = $.CreatePanel("Panel", settingsPanel, "");
        foot.AddClass("BbfSetFoot");
        var reset = textLabel(foot, "BbfSetButton", "Reset to defaults");
        reset.SetPanelEvent("onactivate", function () { Object.keys(DEFAULTS).forEach(function (k) { S[k] = DEFAULTS[k]; }); changeSetting("hideBots", true); });
        var done = textLabel(foot, "BbfSetButton", "Done");
        done.AddClass("BbfSetButtonMain");
        done.SetPanelEvent("onactivate", function () { openPanel(null); });
    }
    function buildSort() {
        sortPanel = newPanel("BbfSortMenu");
        SORTS.forEach(function (x) {
            var item = $.CreatePanel("Panel", sortPanel, "");
            item.AddClass("BbfSortItem");
            textLabel(item, "BbfSortName", x[1]);
            textLabel(item, "BbfSortDesc", x[2]);
            item.SetPanelEvent("onactivate", function () { changeSetting("sort", x[0]); openPanel(null); });
            settingRows.push(function () { item.SetHasClass("BbfChoiceOn", S.sort === x[0]); });
        });
    }
    function drawSettings() { settingRows.forEach(function (f) { f(); }); }
    applySettings();

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
        var sig = version + "|" + state.on + "|" + publicMode() + "|" + listOn() + "|" + rowList.map(function (r) { return r.key + (r.panel.BHasClass("ActiveBuild") ? "*" : "") + (r.panel.BHasClass("Favorite") ? "+" : ""); }).join("\n");
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
            // While our list covers the stock one, its rows need no tags or labels.
            if (listOn()) return;
            markRow(r, v);
            if (r.author !== "0") statsLabels({}, r.panel, r.author, r.name, byClass(r.panel, "nameRow") || r.panel, null);
        });
        return rowList;
    }
    // Check the rows of the stock list as it is, then put back the build the player was looking at.
    async function scanStock(all) {
        if (busy || !publicMode() || loading()) return;
        var todo = rows().filter(function (r) { return r.author !== "0" && (all || worthReading(r)) && (CONFIG.previewChecks || all || apiAsked[r.author]); }).slice(0, CONFIG.scanMaxRows);
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
        'if(P.cmd==="load"){var v="";try{v=localStorage.getItem("bbf_settings")||""}catch(e){}send(P.r,v);return}' +
        'if(P.cmd==="save"){try{localStorage.setItem("bbf_settings",JSON.stringify(P.settings))}catch(e){}send(P.r,"saved");return}' +
        'function tuple(b){var h=b.hero_build||{},d=h.details||{},c=d.mod_categories||[],notes=[],cats=[];' +
        'for(var j=0;j<c.length;j++){cats.push((c[j].name||"")+" "+(c[j].description||""));var m=c[j].mods||[];for(var k=0;k<m.length;k++)if(m[k].annotation)notes.push(String(m[k].annotation).slice(0,80))}' +
        'return[String(h.author_account_id),String(h.name||""),h.hero_build_id|0,b.num_favorites|0,b.num_weekly_favorites|0,String(h.description||"").slice(0,400),notes.slice(0,30),cats.join("\\n").slice(0,400),h.last_updated_timestamp|0]}' +
        'if(P.cmd==="top"){get(API+"builds?hero_id="+P.hero+"&only_latest=true&sort_by="+P.sort+"&sort_direction=desc&limit="+(P.limit|0||150)).then(function(l){send(P.r,JSON.stringify(l.map(tuple)))}).catch(function(e){fail(P.r,e)});return}' +
        'if(P.cmd==="builds"){var out=[],q=P.authors.slice(),busy=0;function one(){if(!q.length){if(!busy)send(P.r,JSON.stringify(out));return}var a=q.shift();busy++;' +
        'get(API+"builds?hero_id="+P.hero+"&author_id="+a+"&only_latest=true").then(function(l){for(var i=0;i<l.length;i++)out.push(tuple(l[i]))})' +
        '.catch(function(){out.push(["!",String(a)])}).then(function(){busy--;one()})}for(var w=0;w<6;w++)one();return}' +
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
    var apiAsked = {};           // authors whose builds for this hero were asked of deadlock-api.com (this session)
    var apiFails = {};           // failed asks per author
    function normName(n) { return String(n || "").replace(/\s+/g, " ").trim().toLowerCase(); }
    // The game's spelling of a build's name wins (trailing spaces or case can differ).
    function keyForApi(author, name) {
        var want = author + "|" + normName(name), hit = null;
        (pool ? pool.entries : []).concat(rows()).some(function (e) { if (e.author + "|" + normName(e.name) === want) { hit = e.key; return true; } return false; });
        return hit || keyOf(author, name);
    }
    // A build tuple from the lookup page: [author, name, id, favourites, weekly, description, notes, category text, updated].
    function storeApiBuild(b) {
        // The API's copy is the build's own text; it replaces anything read from the details pane.
        known[keyForApi(b[0], b[1])] = { author: b[0], desc: plain(b[5]), annotations: b[6] || [], cats: b[7] || "", id: b[2], fav: b[3], wfav: b[4], updated: b[8] || 0, src: "api" };
    }
    // Builds in our list from authors the API answered for, but which it did not return: logged (a few per
    // session) with the API's names for that author, to tell a missing build from a name that differs.
    var unmatchedReported = 0;
    function reportUnmatched(authors, apiNames) {
        if (unmatchedReported >= 3 || !pool) return;
        pool.entries.forEach(function (e) {
            if (unmatchedReported >= 3 || authors.indexOf(e.author) < 0 || (known[e.key] && known[e.key].src === "api")) return;
            unmatchedReported++;
            log("not on deadlock-api: \"" + e.name + "\" by " + e.author + "; it has " + JSON.stringify((apiNames[e.author] || []).slice(0, 5)));
        });
    }
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
        apiAsked = recall("bbf3_api_asked_" + stats.heroId, {});
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
        $.RegisterEventHandler("HTMLURLChanged", stats.view, function (panel, url) { if (String(url).indexOf("http://error/") === 0) statsFailed("the web view could not open the page", true); });
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
        catch (e) { statsFailed("the game's web view is not available", true); }
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
        if (cmd.cmd === "top") {
            var tuples = JSON.parse(body || "[]"), addedTop = 0;
            tuples.forEach(function (b) { storeApiBuild(b); apiAsked[b[0]] = apiAsked[b[0]] || false; });
            if (pool) addedTop = addApiEntries(tuples);
            log("sorted search (" + cmd.sort + "): " + tuples.length + " builds from deadlock-api, " + addedTop + " new to the list");
            topState.busy = false;
            sharedCache = null;
            saveKnown(); savePool();
            scrollToTop();
        } else if (cmd.cmd === "load") {
            settingsState.loaded = true;
            try {
                if (body) { S = cleanSettings(JSON.parse(body)); keep("bbf3_settings", S); applySettings(); if (state.on !== S.hideBots) setOn(S.hideBots); drawSettings(); log("settings loaded"); }
            } catch (e) { log("settings: saved copy unreadable"); }
        } else if (cmd.cmd === "save") {
            // nothing to do
        } else if (cmd.cmd === "builds") {
            var got = 0, failed = {}, apiNames = {};
            JSON.parse(body || "[]").forEach(function (b) {
                if (b[0] === "!") { failed[b[1]] = true; return; }
                storeApiBuild(b);
                (apiNames[b[0]] = apiNames[b[0]] || []).push(b[1]);
                got++;
            });
            reportUnmatched(cmd.authors, apiNames);
            // An author the API failed on is asked again once, then left (no endless retries).
            cmd.authors.forEach(function (a) {
                if (!failed[a]) { apiAsked[a] = true; return; }
                apiFails[a] = (apiFails[a] || 0) + 1;
                if (apiFails[a] >= 2) apiAsked[a] = true;
            });
            keep("bbf3_api_asked_" + stats.heroId, apiAsked);
            sharedCache = null;
            saveKnown();
            log("build texts: " + got + " builds from " + cmd.authors.length + " authors");
        } else if (cmd.cmd === "favs") {
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
    // A page that cannot load at all will not start working: three of those switch the lookups off for
    // this browser. A slow or failed answer only means waiting longer before the next request.
    function statsFailed(why, fatal) {
        if (stats.cur && stats.cur.cmd === "favs") favs.tried++;
        if (stats.cur && stats.cur.cmd === "top") topState.busy = false;
        stats.fails++;
        stats.note = why;
        stats.cur = null; stats.parts = null;
        log("lookup (" + why + ")" + (fatal ? "" : ", trying again later"));
        if (fatal) stats.fatal = (stats.fatal || 0) + 1;
        stats.state = (stats.fatal || 0) >= 3 ? "failed" : "ready";
        stats.nextAt = now() + Math.min(120, SC.minSpacingSeconds * Math.pow(3, Math.min(stats.fails, 5)));
    }
    // Favourites first (one request per hero), then records for the authors on screen we lack.
    var statsAuthorsVersion = -1, statsWant = [];
    function statsTick(authorsOf) {
        if (stats.state === "off") startStats();
        // A batch of authors' builds takes longer (several API calls); chunks arriving reset the clock.
        var limit = stats.cur && stats.cur.cmd === "builds" ? SC.timeoutSeconds + stats.cur.authors.length : SC.timeoutSeconds;
        if (stats.state === "waiting" && now() - stats.sentAt > limit) statsFailed("no answer from deadlock-api.com in " + Math.round(limit) + "s");
        if (stats.state !== "ready" || now() < stats.nextAt) return;
        // Saved settings first (once), a pending save, then build texts, then authors' records.
        if (!settingsState.tried) { settingsState.tried = true; send({ cmd: "load" }); return; }
        if (settingsState.saveWanted) { settingsState.saveWanted = false; send({ cmd: "save", settings: S }); return; }
        if (topState.wanted) { var t = topState.wanted; topState.wanted = null; topState.busy = true; send({ cmd: "top", hero: stats.heroId, sort: t, limit: SC.topLimit }); return; }
        var need = buildsWanted();
        if (need.length) { send({ cmd: "builds", hero: stats.heroId, authors: need.slice(0, SC.buildsBatch) }); return; }
        if (statsAuthorsVersion !== version) {
            statsAuthorsVersion = version;
            var seen = {};
            statsWant = [];
            authorsOf().forEach(function (a) { if (a && a !== "0" && !stats.data[a] && !seen[a]) { seen[a] = true; statsWant.push(a); } });
        }
        if (statsWant.length) { send({ cmd: "stats", ids: statsWant.slice(0, SC.batch), hero: stats.heroId }); statsWant = statsWant.slice(SC.batch); }
    }
    var buildsWantCache = null, buildsWantVersion = -1;
    function buildsWanted() {
        if (buildsWantVersion === version && buildsWantCache) return buildsWantCache.filter(function (a) { return !apiAsked[a]; });
        buildsWantVersion = version;
        var seen = {}, out = [];
        var items = listOn() && pool ? pool.entries : rows();
        items.forEach(function (e) {
            if (e.author && e.author !== "0" && !apiAsked[e.author] && !seen[e.author] && (!known[e.key] || known[e.key].annotations === null)) { seen[e.author] = true; out.push(e.author); }
        });
        return (buildsWantCache = out);
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
        if (!author || author === "0") return null;
        var k = known[keyOf(author, name)];
        if (k && typeof k.fav === "number") return { n: k.fav, w: k.wfav || 0 };
        if (!favs.data) return null;
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
        var d = S.showRecord && author && author !== "0" ? stats.data[author] : null, fi = S.showFavs ? favInfo(author, name) : null;
        var sig = (d ? d.w + "/" + d.m : "-") + "|" + (fi ? (fi.below ? "<" + fi.below : fi.n + "/" + fi.w) : "-") + "|" + stats.heroName + "|" + S.showRecord + S.showFavs;
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
        if (S.hideBots !== on) { S.hideBots = on; keep("bbf3_settings", S); settingsState.saveWanted = true; drawSettings(); }
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
        if (!S.showTags) { tags = []; own = null; }
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
    // Builds found through deadlock-api (a sorted search): entries like the stock ones, without a stock row
    // yet (picking one loads it by id). Returns how many were new.
    function addApiEntries(tuples) {
        var have = {}, n = 0;
        pool.entries.forEach(function (e) { have[e.author + "|" + normName(e.name)] = true; });
        tuples.forEach(function (b) {
            var nk = b[0] + "|" + normName(b[1]);
            if (have[nk] || !b[0] || b[0] === "0") return;
            have[nk] = true;
            pool.entries.push({ key: keyOf(b[0], b[1]), author: b[0], name: b[1], id: b[2], desc: plain(b[5]), classes: [], tags: [], api: true });
            n++;
        });
        version++;
        return n;
    }
    // What the list shows: pool entries that are not (or no longer) bot builds, Valve's default builds last.
    var shownCache = null, shownVersion = -1, hiddenBySettingsCount = 0;
    function shownEntries() {
        if (!pool) return [];
        if (shownCache && shownVersion === version) return shownCache;
        var result = verdicts(pool.entries);
        hiddenBySettingsCount = 0;
        var out = pool.entries.filter(function (e) {
            if (result[e.key].bot || !passesFilter(currentFilter, e.key, e.author, e.name)) return false;
            if (hiddenBySettings(e)) { hiddenBySettingsCount++; return false; }
            return true;
        });
        shownVersion = version;
        return (shownCache = sortEntries(out.filter(function (e) { return e.author !== "0"; })).concat(out.filter(function (e) { return e.author === "0"; })));
    }
    function nextTerm() {
        var words = CONFIG.searchWords.concat(ITEM_NAMES);
        if (pool.term >= words.length) { pool.exhausted = true; return null; }
        return words[pool.term++];
    }

    // Preview the unchecked builds of the stock list as it is now, and fold the results into the pool.
    async function verifyCurrent(what) {
        if (!CONFIG.previewChecks) return;   // build texts come from deadlock-api.com instead
        var todo = rows().filter(worthReading).slice(0, CONFIG.scanMaxRows);
        if (todo.length) await readRows(todo, what);
        saveKnown();
    }
    // The "Check" button: preview the unchecked builds of the stock list now (the player asked for it).
    async function previewCheck() {
        if (busy || !listOn()) return;
        busy = true; stopWork = false; paused = false;
        try {
            // The stock results may hold a search by now: preview the normal list's builds.
            if (!stockIsDefault) { restoreStock(); await waitFor(loading, 0.6); await waitFor(function () { return !loading(); }, CONFIG.searchTimeoutSeconds); forgetRows(); }
            var todo = rows().filter(worthReading).slice(0, CONFIG.scanMaxRows);
            if (todo.length) await readRows(todo, "Checking");
            saveKnown(); addRows(rows(), false); savePool();
        } catch (e) { log("check: " + e); }
        finally { busy = false; progress = ""; }
        // Put back the build the player had picked in our list.
        var sel = selectedKey && pool ? pool.entries.filter(function (x) { return x.key === selectedKey; })[0] : null;
        if (sel && detailsName() !== sel.name) await load(sel);
        render();
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
            var withText = pool.entries.filter(function (e) { return known[e.key] && known[e.key].annotations !== null; });
            log("list opened: " + pool.entries.length + " builds, texts known for " + withText.length + " (item notes on " +
                withText.filter(function (e) { return known[e.key].annotations.length; }).length + ")");
        } catch (e) { log("verify: " + e); pause("an error while checking"); }
        finally { busy = false; progress = ""; render(); }
        if (!paused && !(pool && pool.dry) && shownEntries().length < CONFIG.minRows) fillWhenReady();
    }
    // One "load more": search until batchMinNew new builds were added (or batchMaxSearches searches).
    async function loadMore(why) {
        if (busy || !listOn() || paused) return;
        ensurePool();
        if (pool.exhausted) { drawMore(); return; }
        busy = true; stopWork = false;
        var added = 0, searches = 0, shownId = detailsId();
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
            // A search can move the details pane: put back the build the player picked in our list.
            if (selectedKey && !paused && detailsId() !== shownId) {
                var sel = pool.entries.filter(function (x) { return x.key === selectedKey; })[0];
                var back = sel ? stockRowFor(sel) : null;
                if (back) click(back.panel);
                else if (sel && idOf(sel)) { busy = false; await load(sel); busy = true; }
            }
        } catch (e) { log("load more: " + e); pause("an error while loading more"); }
        finally {
            busy = false; progress = "";
            savePool();
            render();
            log("load more (" + why + "): +" + added + " builds from " + searches + " searches, " + shownEntries().length + " listed");
        }
        // Keep filling a short list, unless a whole batch found nothing new (then scrolling asks for more).
        if (why === "fill" && added === 0) pool.dry = true;
        else if (added > 0) pool.dry = false;
        if (!paused && S.autoLoad && !pool.exhausted && !pool.dry && listOn() && shownEntries().length < CONFIG.minRows) $.Schedule(0.1, function () { if (alive) loadMore("fill"); });
    }
    function fillWhenReady() {
        if (!alive) return;
        if (!settingsReady()) { $.Schedule(0.25, fillWhenReady); return; }
        if (S.autoLoad && !paused && listOn() && pool && !pool.dry && shownEntries().length < CONFIG.minRows) loadMore("fill");
    }

    // ------------------------------------------------------------------ picking builds in our list
    function stockRowFor(e) { return rows().filter(function (r) { return r.key === e.key; })[0] || null; }
    // A build's id may arrive after its entry was made (with its texts from deadlock-api.com).
    function idOf(e) { var k = known[e.key]; return e.id || (k && k.id) || 0; }
    var pickSeq = 0;
    async function load(e) {
        var seq = ++pickSeq;
        selectedKey = e.key;
        render();
        if (busy) { pause(); await waitFor(function () { return !busy; }, 12); }
        stopWork = false;   // background work stays paused; this search is the player's own
        var row = stockRowFor(e), id = idOf(e);
        // Not in the stock results: search for it, by id when known, else by its name.
        if (!row) {
            busy = true; userLoading = true;
            progress = "Loading " + e.name;
            drawControl();
            try { await search(id || e.name, true); } finally { busy = false; userLoading = false; progress = ""; }
            row = stockRowFor(e);
        }
        if (seq !== pickSeq) return null;
        if (!row) { log("could not load " + e.name); if (selectedKey === e.key) selectedKey = null; render(); return null; }
        if (!(id && detailsId() === id)) {
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
    var renderSig = "", madeAt = 0, madeCount = 0;   // new rows made in the current frame
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
        var entries = shownEntries(), wanted = {}, deferred = false;
        if (Date.now() !== madeAt) { madeAt = Date.now(); madeCount = 0; }
        var prev = null;
        entries.forEach(function (e, i) {
            wanted[e.key] = true;
            var r = ownRows[e.key];
            if (!valid(r)) {
                // At most a dozen new rows per pass, so a batch of new builds does not stall a frame.
                if (madeCount >= 12) { deferred = true; return; }
                r = makeRow(e); ownRows[e.key] = r; madeCount++;
            }
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
        if (deferred) renderSig = "";   // the rest next pass
        drawMore();
    }
    function drawMore() {
        if (!moreRow || !moreLabel || !pool) return;
        var text;
        if (busy && progress.indexOf("Loading more") === 0) text = progress + (rateNote ? "  ·  " + rateNote : "") + "...";
        else if (rateNote) text = "Waiting: " + rateNote;
        else if (pool.exhausted) text = "That's every build the searches found";
        else if (paused) text = "Paused. Click to load more builds";
        else text = S.autoLoad ? "Scroll down or click to load more builds" : "Click to load more builds";
        if (hiddenBySettingsCount) text += "  ·  " + hiddenBySettingsCount + " hidden by your settings (⚙)";
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
                    else if (wasListOn && pool && !paused && !pool.exhausted && S.autoLoad && settingsReady() && nearBottom()) loadMore("scrolled");
                    // Builds recognised as bots once their texts arrived can leave the list short: top it up.
                    else if (wasListOn && pool && !paused && !pool.exhausted && !pool.dry && S.autoLoad && settingsReady() && shownEntries().length < CONFIG.minRows) loadMore("fill");
                } else {
                    wasListOn = false;
                    // My Builds filters the current results: give it the normal list back.
                    if (!publicMode() && !userSearch) restoreStock();
                    if (stockIsDefault && rowList.length && publicMode() && sig !== autoScannedFor) {
                        // A new list (another hero or search): a pause from the last one is over.
                        if (paused && autoScannedFor) paused = false;
                        autoScannedFor = sig;
                        if (CONFIG.autoScan && CONFIG.previewChecks && state.on && rowList.some(worthReading))
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
