// Offline tests: the scoring rules, then the whole script against a fake Panorama build browser
// (60 Hz frames, a fake game network that answers each search with one fixed batch, a details pane
// that fills in over a few frames, snippets, scrolling).
//   node tools/test_filter.mjs
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const SRC = fs.readFileSync(new URL("../src/bot_build_filter.js", import.meta.url), "utf8")
    .replace("var HERO_IDS = {}; /*@HERO_IDS@*/", 'var HERO_IDS = {"hero_inferno": 1, "hero_haze": 13};')
    .replace("var ABILITY_IMAGES = []; /*@ABILITY_IMAGES@*/", 'var ABILITY_IMAGES = [["upgrade_toxic_bullets", "s2r://panorama/images/items/weapon/toxic_bullets_psd.vtex"], ["haze_toxic_bullets_dup", "s2r://panorama/images/hud/abilities/wrong_psd.vtex"]];');
let failures = 0;
async function test(name, fn) {
    try { await fn(); console.log("ok   " + name); } catch (e) { failures++; console.log("FAIL " + name + "\n     " + (e.stack || e.message).split("\n").slice(0, 8).join("\n     ")); }
}

// ------------------------------------------------------------------ sample builds
const BOT_DESC = (hero, n) => `Highest win rate ${hero} build based on ${n} matches. Data-driven item order, updated daily. More builds at statlockerz.gg`;
const SAMPLES = [
    { key: "1|Haze 58.3% WR", author: "1", name: "Haze 58.3% WR", desc: BOT_DESC("Haze", "12,403"), annotations: ["+WR 3.1%", "+wr 2.4%", "Win rate: 55%"] },
    { key: "2|Haze Meta Build", author: "2", name: "Haze Meta Build", desc: BOT_DESC("Haze", "9,812"), annotations: [] },
    { key: "3|Best Haze", author: "3", name: "Best Haze", desc: BOT_DESC("Haze", "20,155"), annotations: [] },
    { key: "4|Haze bullet spam", author: "4", name: "Haze bullet spam", desc: "My main build, I stream it on twitch.tv/hazeenjoyer and post vods on youtube.com/@haze. Rush Toxic Bullets, then go fire rate. wr is fine", annotations: ["core", "buy after 10k", "+20% fire rate"] },
    { key: "5|Spirit Haze (fun)", author: "5", name: "Spirit Haze (fun)", desc: "Not a serious build. Lots of spirit, dagger spam. Win rate is probably bad lol", annotations: [] },
    { key: "6|Haze vs melee", author: "6", name: "Haze vs melee", desc: "", annotations: ["+12% WR vs melee heroes", "+WR 4%"] },
    { key: "7|Tank Haze", author: "7", name: "Tank Haze", desc: "Check out deadlockmeta.net for more!", annotations: ["sell later", "1.5k souls"] },
    { key: "0|Default Haze Build", author: "0", name: "Default Haze Build", desc: "Default build by Valve. Visit deadlock.com", annotations: [] }
];
const HUMANS = ["Haze bullet spam", "Spirit Haze (fun)", "Tank Haze", "Default Haze Build"];
const copy = (a) => a.map((x) => ({ ...x }));

const box = { globalThis: {} };
box.globalThis = box;
vm.runInNewContext(SRC, box);
const F = box.BotBuildFilter;

await test("websites: stats sites count, socials and sentences do not", () => {
    assert.deepEqual([...F.websites("more at statlockerz.gg and https://www.deadlockmeta.net/haze")].sort(), ["deadlockmeta.net", "statlockerz.gg"]);
    assert.deepEqual([...F.websites("twitch.tv/me youtube.com/@me discord.gg/abc x.com/me")], []);
    assert.deepEqual([...F.websites("see site [dot] com")], ["site.com"]);
    assert.deepEqual([...F.websites("buy at 3.5k souls, v1.2, e.g. Toxic Bullets. dagger spam. Win rate")], []);
});
await test("win-rate text: needs a number or the actual words", () => {
    assert.equal(F.scoreText({ name: "x", desc: "wr is fine, my wr went up", annotations: ["+20% fire rate", "+15% weapon damage", "core wr item"] }).score, 0);
    assert.equal(F.scoreText({ name: "x", desc: "", annotations: ["+WR 3%", "Win rate: 54%"] }).score, 3);
});
await test("scoreList flags bot builds, keeps human and Valve builds", () => {
    const r = F.scoreList(SAMPLES, {});
    assert.deepEqual(SAMPLES.filter((b) => r[b.key].bot).map((b) => b.author), ["1", "2", "3", "6"]);
});
await test("one person reusing their own description is not a template bot", () => {
    const d = "My usual setup for this hero, buy the core first then flex depending on the enemy team comp and lane";
    const r = F.scoreList([1, 2, 3].map((i) => ({ key: "9|b" + i, author: "9", name: "b" + i, desc: d, annotations: [] })), {});
    assert.ok(!r["9|b1"].bot);
});

// ------------------------------------------------------------------ fake Panorama + game network
const FRAME = 1 / 60;
let clock = 0;
let timers = [];
class P {
    constructor(type, parent, id) {
        this.paneltype = type; this.id = id || ""; this.children = []; this.classes = new Set(); this.vars = {};
        this.style = {}; this.attrs = {}; this.events = {}; this.text = ""; this.parent = null; this.alive = true;
        this.actuallayoutwidth = 1000; this.actualuiscale_x = 1; this.actualuiscale_y = 1;
        this.ctx = parent ? parent.ctx : "popup";   // which layout file's snippets this panel can load
        if (parent) parent.add(this);
    }
    add(c) { c.parent = this; this.children.push(c); return c; }
    IsValid() { return this.alive; }
    GetParent() { return this.parent; }
    GetChild(i) { return this.children[i]; }
    GetChildCount() { return this.children.length; }
    BHasClass(c) { return this.classes.has(c); }
    AddClass(c) { this.classes.add(c); }
    RemoveClass(c) { this.classes.delete(c); }
    SetHasClass(c, on) { on ? this.AddClass(c) : this.RemoveClass(c); }
    SetPanelEvent(n, f) { this.events[n] = f; }
    SetAttributeString(k, v) { this.attrs[k] = v; }
    GetAttributeString(k, d) { return k in this.attrs ? this.attrs[k] : d; }
    SetDialogVariable(k, v) { this.vars[k] = v; }
    SetAccountID() {}
    MoveChildAfter(c, after) { this.children = this.children.filter((x) => x !== c); this.children.splice(this.children.indexOf(after) + 1, 0, c); }
    MoveChildBefore(c, before) { this.children = this.children.filter((x) => x !== c); const i = this.children.indexOf(before); this.children.splice(i < 0 ? 0 : i, 0, c); }
    DeleteAsync() { this.alive = false; if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
    RemoveAndDeleteChildren() { this.children.forEach((c) => (c.alive = false)); this.children = []; }
    FindChildTraverse(id) { for (const c of this.children) { if (c.id === id) return c; const h = c.FindChildTraverse(id); if (h) return h; } return null; }
    FindChildrenWithClassTraverse(cls) { const out = []; const walk = (p) => p.children.forEach((c) => { if (c.classes.has(cls)) out.push(c); walk(c); }); walk(this); return out; }
    BLoadLayoutSnippet(name) {
        if (this.ctx !== "popup") return false;   // like Panorama: only our layout file has our snippets
        if (name === "BbfRow") {
            this.AddClass("HeroBuildListItem");
            const area = new P("Panel", this, "BuildNameArea");
            const nameRow = new P("Panel", area, ""); nameRow.AddClass("nameRow");
            const tags = new P("Panel", nameRow, ""); tags.AddClass("BuildTagContainer");
            for (let i = 1; i <= 3; i++) {
                const t = new P("Panel", tags, "BuildTag" + i); t.AddClass("BbfTagChip");
                const img = new P("Image", t, "TagImage"); img.SetImage = (src) => { img.src = src; };
                new P("Label", t, "TagLabel");
            }
            const n = new P("Label", nameRow, ""); n.AddClass("BuildName");
            new P("CitadelButton", area, "");
            const right = new P("Panel", this, "RightPanel");
            const info = new P("Panel", right, ""); info.AddClass("InfoContainer");
            new P("Panel", info, "FavoriteIcon");
            new P("CitadelAvatarImage", info, "AuthorAvatar");
        } else if (name === "BbfMore") {
            this.AddClass("BbfMore");
            new P("Label", this, "BbfMoreLabel");
        }
        return true;
    }
    // scrolling (our list): 50px per row, 800px view
    BHasHoverStyle() { return !!this.hover; }
    get actuallayoutheight() { return this.classes.has("BbfList") ? 800 : 0; }
    get contentheight() { return this.classes.has("BbfList") ? this.children.length * 50 : 0; }
}
function lookup(panel, name) { for (let p = panel; p; p = p.parent) if (name in p.vars) return p.vars[name]; return undefined; }

const PAGE = 10;   // builds per search answer
// author records the fake deadlock-api.com knows (hero 13 = Haze): account -> [wins, matches]
const RECORDS = { 4: [30, 52], 5: [1, 9], 7: [12, 20] };
// the hero's most favourited builds the fake API knows: [author, name, favourites, weekly]
const FAVS = [["4", "Haze bullet spam", 48213, 120], ["7", "Tank Haze", 1234, 3], ["1", "Haze 58.3% WR", 900, 0]];
function fnv(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return ("0000000" + h.toString(16)).slice(-8); }
function makeBrowser({ db, defaultList, rowsHaveDescription = false, activeName = null, src = SRC, emptyAnswers = false, webView = "ok", apiLatency = 0 }) {
    db.forEach((b, i) => { b.id = b.id || 1000 + i; });
    const ev = { log: [], previews: [], activated: [], used: [], favs: [], searches: [], searchTimes: [], statReqs: [] };
    const handlers = [];
    const manager = new P("Panel", null, "PopupManager");
    const popup = new P("PopupBuildBrowser", manager, "");
    const selector = new P("CitadelHeroBuildsSelector", popup, "HeroBuildSelector");
    selector.ctx = "selector";   // the selector loads its own layout file; its insides belong to that
    selector.AddClass("ShowPublicBuilds");
    const tabs = new P("Panel", selector, ""); tabs.AddClass("HeroSelectorTabContainer");
    const searchEntry = new P("TextEntry", selector, "SearchTextEntry");
    const main = new P("Panel", selector, ""); main.AddClass("MainContainer");
    const list = new P("Panel", main, "HeroBuildList");
    const details = new P("CitadelBuildDetails", main, "BuildDetails");
    details.actuallayoutwidth = 400;
    const mods = new P("CitadelShopModsBuild", details, "ShopModsBuild");
    const favs = new Set(db.filter((b) => b.fav0).map((b) => b.name));
    const fillList = (builds) => {
        list.RemoveAndDeleteChildren();
        builds.forEach((b) => {
            const row = new P("Panel", list, ""); row.AddClass("HeroBuildListItem"); row.AddClass("PublicBuild");
            new P("Panel", row, "").AddClass("nameRow");
            const use = new P("CitadelButton", row, ""); use.build = b; use.isUse = true;
            const star = new P("Panel", row, "FavoriteIcon"); star.build = b; star.isStar = true;
            row.vars.selected_hero_build_name = b.name;
            row.vars.build_creator = b.author;
            if (typeof b.fav === "number") row.vars.favorite_count = String(b.fav);
            if (rowsHaveDescription) row.vars.selected_hero_build_description = b.desc;
            row.build = b;
            if (b.name === activeName) row.AddClass("ActiveBuild");
            if (b.author === "0") row.AddClass("DefaultBuild");
            if (b.mine) { row.AddClass("MyBuild"); row.RemoveClass("PublicBuild"); }
            if (b.obsolete) row.AddClass("ObsoleteBuild");
            if (favs.has(b.name)) row.AddClass("Favorite");
            const tagBox = new P("Panel", row.children[0], ""); tagBox.AddClass("BuildTagContainer");
            for (let i = 1; i <= 3; i++) { const tg = new P("CitadelBuildTag", tagBox, "BuildTag" + i); if (b.tags && b.tags[i - 1]) tg.vars.tag_name = b.tags[i - 1]; else tg.AddClass("Empty"); }
        });
    };
    const show = (b) => {
        details.vars.selected_hero_build_id = String(b.id);
        details.vars.selected_hero_build_name = b.name;
        details.vars.selected_hero_build_description = b.desc;
        timers.push({ at: clock + 2 * FRAME, f: () => {
            if (details.vars.selected_hero_build_id !== String(b.id)) return;
            mods.RemoveAndDeleteChildren();
            (b.annotations || []).forEach((a) => { const m = new P("Panel", mods, ""); m.vars.mod_annotation = a; });
            for (let i = 0; i < 3; i++) new P("Panel", mods, "");
        } });
    };
    const runSearch = () => {
        selector.AddClass("BuildsLoading");
        // Like the game: the request is built a couple of frames later, from what the box says then.
        timers.push({ at: clock + 2 * FRAME, f: () => {
        const t = String(searchEntry.text || "").trim().toLowerCase();
        ev.searches.push(t); ev.searchTimes.push(clock);
        timers.push({ at: clock + 0.3, f: () => {
            let res;
            if (!t) res = defaultList;
            else if (/^\d+$/.test(t)) res = db.filter((b) => String(b.id) === t);
            else res = emptyAnswers ? [] : db.filter((b) => b.name.toLowerCase().includes(t)).slice(0, PAGE);
            fillList(res);
            selector.RemoveClass("BuildsLoading");
        } });
        } });
    };
    fillList(defaultList);
    const $ = {
        GetContextPanel: () => popup,
        Msg: (s) => ev.log.push(s),
        Schedule: (s, f) => timers.push({ at: clock + Math.max(s, FRAME), f }),
        Localize: (fmt, panel) => {
            const tokens = { "#hero_haze": "Haze", "#hero_inferno": "Infernus", "#Citadel_HeroBuilds_DefaultHeroBuild": "Default {s:hero_name} Build", "#Citadel_HeroBuilds_BeginnerHeroBuild": "Beginner {s:hero_name} Build",
                "#upgrade_toxic_bullets": "Toxic Bullets", "#haze_toxic_bullets_dup": "Toxic Bullets", "#citadel_build_tag_spirit": "Spirit", "#citadel_build_tag_weapon": "Weapon" };
            if (fmt.charAt(0) === "#") fmt = tokens[fmt] || fmt;
            return fmt.replace(/\{[sdi]:([a-z_]+)\}/g, (m, n) => { const v = lookup(panel, n); return v === undefined ? m : String(v); });
        },
        RegisterEventHandler: (name, panel, fn) => handlers.push({ name, panel, fn }),
        DispatchEvent: (name, panel) => {
            if (name === "Activated" && panel.isUse) { ev.used.push(panel.build.name); return; }
            if (name === "Activated" && panel.isStar) { favs.has(panel.build.name) ? favs.delete(panel.build.name) : favs.add(panel.build.name); ev.favs.push(panel.build.name); return; }
            if (name === "Activated" && panel.build) {
                if (!selector.BHasClass("ShowPublicBuilds")) ev.activated.push(panel.build.name);
                ev.previews.push(panel.build.name);
                timers.push({ at: clock + 2 * FRAME, f: () => show(panel.build) });
            }
            if (name === "CitadelBuildBrowserRefresh") runSearch();
            if (name === "CitadelBuildBrowserClearSearch") { searchEntry.text = ""; runSearch(); }
        },
        CreatePanelWithCurrentContext: (parent) => { const p = new P("Panel", parent, ""); p.ctx = "popup"; return p; },
        CreatePanel: (type, parent, id) => {
            const p = new P(type, parent, id);
            if (type === "CitadelHTMLPanel") p.SetURL = (url) => {
                const cmd = JSON.parse(decodeURIComponent(url.slice(url.indexOf("#") + 1)));
                ev.statReqs.push({ at: clock, n: cmd.ids ? cmd.ids.length : cmd.authors ? cmd.authors.length : 0, cmd: cmd.cmd || "stats", hero: cmd.hero, page: url.split("#")[0] });
                const fire = (name, arg) => handlers.filter((h) => h.panel === p && h.name === name).forEach((h) => h.fn(p, arg));
                const cmdPeek = JSON.parse(decodeURIComponent(url.slice(url.indexOf("#") + 1)));
                timers.push({ at: clock + 0.4 + (cmdPeek.cmd === "builds" ? cmdPeek.authors.length * apiLatency : 0), f: () => {
                    if (webView === "blocked") return fire("HTMLURLChanged", "http://error/");
                    if (webView === "silent") return;
                    let body;
                    if (cmd.cmd === "load") body = STORE.bbf_settings || "";
                    else if (cmd.cmd === "save") { STORE.bbf_settings = JSON.stringify(cmd.settings); body = "saved"; }
                    else if (cmd.cmd === "builds") {
                        ev.apiAuthors = (ev.apiAuthors || []).concat(cmd.authors);
                        body = JSON.stringify(db.filter((b) => cmd.authors.includes(b.author) && !b.apiMissing && !b.apiFails)
                            .map((b) => { const f = FAVS.find((x) => x[0] === b.author && x[1] === b.name); return [b.author, b.apiName || b.name, b.id, typeof b.apiFav === "number" ? b.apiFav : f ? f[2] : 7, f ? f[3] : 0, b.desc || "", b.annotations || [], b.cats || "", b.updated || 0]; })
                            .concat(db.filter((b) => cmd.authors.includes(b.author) && b.apiFails).map((b) => ["!", b.author])));
                    }
                    else if (cmd.cmd === "favs") body = "min:" + Math.min(...FAVS.map((f) => f[2])) + "," + FAVS.map((f) => f[0] + ":" + fnv(f[1]) + ":" + f[2] + ":" + f[3]).join(",") + "," + "x".repeat(0);
                    else body = cmd.ids.filter((id) => RECORDS[id] && cmd.hero === 13).map((id) => id + ":" + RECORDS[id][0] + ":" + RECORDS[id][1]).join(",");
                    // like the page: chunks of at most 40 characters here (3500 there), arriving out of order
                    const n = Math.max(1, Math.ceil(body.length / 40)), parts = [];
                    for (let i = 0; i < n; i++) parts.push("BBF1|" + cmd.r + "|" + i + "/" + n + "|" + body.slice(i * 40, (i + 1) * 40));
                    parts.reverse().forEach((p) => fire("HTMLTitle", p));
                } });
            };
            return p;
        }
    };
    const FakeDate = { now: () => clock * 1000 };
    const api = { manager, popup, selector, list, details, tabs, searchEntry, main, ev, show };
    api.start = () => vm.runInNewContext(src, { $, globalThis: {}, Promise, JSON, Object, Math, Number, String, RegExp, Date: FakeDate });
    api.own = () => main.children.find((c) => c.classes.has("BbfList"));
    api.shown = () => { const o = api.own(); return o && o.classes.has("BbfShown") ? o.children.filter((r) => !r.classes.has("BbfMore")).map((r) => r.vars.selected_hero_build_name) : null; };
    api.ownRow = (name) => api.own().children.find((r) => r.vars.selected_hero_build_name === name);
    api.scrollToBottom = () => { const o = api.own(); o.scrolloffset_y = -(o.contentheight - o.actuallayoutheight); };
    api.scrollTop = () => { api.own().scrolloffset_y = 0; };
    return api;
}
async function advance(seconds) {
    const end = clock + seconds;
    for (;;) {
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > end) break;
        const t = timers.shift();
        clock = Math.max(clock, t.at);
        t.f();
        await new Promise((r) => setImmediate(r));
    }
    clock = end;
}
// What the stock stylesheet shows: Public tab = PublicBuild rows without HidePublic; My Builds = own,
// favourited, active and default builds. An inline visibility style overrides both.
const visible = (b) => b.list.children.filter((r) => {
    if (r.style.visibility === "collapse") return false;
    if (r.style.visibility === "visible") return true;
    if (b.selector.BHasClass("ShowMyBuilds")) return ["ActiveBuild", "MyBuild", "DefaultBuild", "Favorite"].some((c) => r.classes.has(c));
    return r.classes.has("PublicBuild") && !r.classes.has("HidePublic");
}).map((r) => r.build.name);
const ctl = (b) => b.tabs.children.find((c) => c.classes.has("BbfControl"));
const labels = (b) => ctl(b).children.map((c) => c.text);
const part = (b, cls) => ctl(b).children.find((c) => c.classes.has(cls));
const STORE = {};   // the lookup page's browser storage (survives browsers, like Steam's web profile)
function reset() { clock = 0; timers = []; for (const k in STORE) delete STORE[k]; }
const PREVIEW = SRC.replace("previewChecks: false,", "previewChecks: true,");      // old behaviour: read builds by previewing them
const IN_PLACE = PREVIEW.replace("fill: true,", "fill: false,");
const IN_PLACE_API = SRC.replace("fill: true,", "fill: false,");
function bigDb(n, start = 100, word = "spirit") {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ key: `${start + i}|${word} build ${i}`, author: String(start + i), name: `${word} build ${i}`, desc: "a normal build number " + i, annotations: i % 4 ? [] : ["core"] });
    return out;
}

// ------------------------------------------------------------------ in-place mode (the stock list itself)
await test("in place: checks rows, hides bots, puts selection back, never activates", async () => {
    reset();
    const db = copy(SAMPLES);
    const br = makeBrowser({ db, defaultList: db, src: IN_PLACE });
    br.show(db[4]);
    await advance(0.1);
    br.start();
    await advance(5);
    assert.deepEqual(br.ev.activated, []);
    assert.equal(br.details.vars.selected_hero_build_name, "Spirit Haze (fun)");
    assert.deepEqual(visible(br), ["Haze bullet spam", "Spirit Haze (fun)", "Tank Haze", "Default Haze Build"]);
});
await test("in place: inherited and leftover item notes are not the build's own", async () => {
    reset();
    const db = copy(SAMPLES.filter((x) => HUMANS.includes(x.name)));
    db.push({ key: "8|Other human", author: "8", name: "Other human", desc: "melee build", annotations: [] });
    const br = makeBrowser({ db, defaultList: db, src: IN_PLACE });
    br.popup.vars.mod_annotation = "+WR 5.2%";
    br.details.vars.mod_annotation = "Win rate: 61%";
    br.start();
    await advance(5);
    assert.deepEqual(visible(br), db.map((x) => x.name));
});
await test("in place: a click by the player pauses checking and keeps their pick", async () => {
    reset();
    const db = bigDb(40);
    const br = makeBrowser({ db, defaultList: db, src: IN_PLACE });
    br.start();
    await advance(0.8);
    assert.match(part(br, "BbfStatus").text, /Checking \d+\/40/);
    br.list.hover = true;                                                // the cursor moves onto the list...
    timers.push({ at: clock + 5 * FRAME, f: () => br.show(db[30]) });   // ...and the player clicks a row
    timers.push({ at: clock + 1.0, f: () => { br.list.hover = false; } });
    await advance(2);
    assert.equal(br.details.vars.selected_hero_build_name, db[30].name);
    assert.match(part(br, "BbfStatus").text, /Paused  ·  resume/);
    const n = br.ev.previews.length;
    await advance(5);
    assert.equal(br.ev.previews.length, n);
});

// ------------------------------------------------------------------ our public list
await test("list: opens with the normal list's human builds, bots out, Valve default last", async () => {
    reset();
    const db = copy(SAMPLES);
    const br = makeBrowser({ db, defaultList: db });
    br.start();
    await advance(1.5);
    assert.ok(br.shown(), "our list is showing");
    await advance(6);
    const shown = br.shown();
    assert.deepEqual(shown.slice(0, 3), ["Haze bullet spam", "Spirit Haze (fun)", "Tank Haze"]);
    assert.equal(shown[shown.length - 1], "Default Haze Build");
    for (const bot of ["Haze 58.3% WR", "Haze Meta Build", "Best Haze", "Haze vs melee"]) assert.ok(!shown.includes(bot), bot);
    assert.deepEqual(br.ev.activated, []);
    assert.ok(br.ownRow("Haze bullet spam").classes.has("PublicBuild"));
    assert.ok(br.ownRow("Default Haze Build").classes.has("DefaultBuild"));
});
await test("list: fills a short list, then loads more only when scrolled to the bottom (rate limited)", async () => {
    reset();
    const db = copy(SAMPLES).concat(bigDb(120, 100, "spirit"), bigDb(120, 300, "gun"), bigDb(120, 500, "weapon"), bigDb(120, 700, "melee"));
    const br = makeBrowser({ db, defaultList: copy(SAMPLES) });
    br.start();
    await advance(30);
    const afterFill = br.shown().length;
    assert.ok(afterFill >= 25, "filled to " + afterFill);
    const searchesAfterFill = br.ev.searches.length;
    br.scrollTop();
    await advance(20);
    assert.equal(br.ev.searches.length, searchesAfterFill, "no searches while not at the bottom");
    br.scrollToBottom();
    await advance(15);
    assert.ok(br.ev.searches.length > searchesAfterFill, "scrolling to the bottom loads more");
    assert.ok(br.shown().length > afterFill);
    // rate: spacing and the bucket
    const t = br.ev.searchTimes;
    for (let i = 1; i < t.length; i++) assert.ok(t[i] - t[i - 1] >= 1.49, "spacing " + (t[i] - t[i - 1]));
    for (let i = 0; i < t.length; i++) {
        const inMinute = t.filter((x) => x >= t[i] && x < t[i] + 60).length;
        assert.ok(inMinute <= 3 + 15, "searches in a minute: " + inMinute);
    }
});
await test("list: keeps loading while held at the bottom, at most ~15 searches a minute", async () => {
    reset();
    const words = ["spirit", "gun", "weapon", "melee", "tank", "hybrid", "carry", "support", "fun", "bullet", "burst", "sustain", "lane"];
    let db = copy(SAMPLES);
    words.forEach((w, i) => { db = db.concat(bigDb(12, 1000 + i * 100, w)); });
    const br = makeBrowser({ db, defaultList: copy(SAMPLES) });
    br.start();
    for (let i = 0; i < 240; i++) { br.scrollToBottom(); await advance(0.5); }
    const t = br.ev.searchTimes;
    const lastMinute = t.filter((x) => x > clock - 60).length;
    console.log("     (" + t.length + " searches in " + clock.toFixed(0) + "s, " + lastMinute + " in the last minute, " + br.shown().length + " builds listed)");
    assert.ok(lastMinute <= 16, "last minute: " + lastMinute);
});
await test("list: hourly cap stops searching and says so", async () => {
    reset();
    const db = copy(SAMPLES).concat(bigDb(200, 100, "build"));
    const src = SRC.replace("perHour: 150,", "perHour: 6,");
    const br = makeBrowser({ db, defaultList: copy(SAMPLES), src });
    br.start();
    for (let i = 0; i < 120; i++) { br.scrollToBottom(); await advance(0.5); }
    const ids = br.ev.searches.filter((s) => s);   // words and ids, not the empty "restore" query
    assert.ok(ids.length <= 6, "searches: " + ids.length);
    assert.match(br.own().children.find((r) => r.classes.has("BbfMore")).children[0].text + " " + labels(br).join(" "), /hourly search limit/);
});
await test("list: empty answers back off", async () => {
    reset();
    const db = copy(SAMPLES);
    const br = makeBrowser({ db, defaultList: copy(SAMPLES), emptyAnswers: true });
    br.start();
    for (let i = 0; i < 360; i++) { br.scrollToBottom(); await advance(0.5); }
    const t = br.ev.searchTimes.slice(1);
    const gaps = t.slice(1).map((x, i) => x - t[i]);
    assert.ok(gaps.length >= 3 && gaps[gaps.length - 1] >= 20, "gaps " + gaps.map((g) => g.toFixed(1)).join(","));
});
await test("list: picking a build not in the current results loads it by ID; Use and favourite go through the stock row", async () => {
    reset();
    const db = copy(SAMPLES).concat(bigDb(30, 100, "spirit"));
    const br = makeBrowser({ db, defaultList: copy(SAMPLES) });
    br.start();
    await advance(30);
    const target = br.shown().find((n) => /spirit build/.test(n));
    assert.ok(target, "a loaded-more build is listed");
    br.list.RemoveAndDeleteChildren();   // whatever the stock list holds now, the target is not in it
    const row = br.ownRow(target);
    row.events.onactivate();
    await advance(4);
    assert.equal(br.details.vars.selected_hero_build_name, target);
    assert.ok(row.classes.has("Selected"));
    assert.ok(/^\d+$/.test(br.ev.searches[br.ev.searches.length - 1]), "searched by id");
    row.FindChildTraverse("FavoriteIcon").events.onactivate();
    await advance(3);
    assert.deepEqual(br.ev.favs, [target]);
    row.FindChildTraverse("BuildNameArea").children.find((c) => c.paneltype === "CitadelButton").events.onactivate();   // its Use button
    await advance(3);
    assert.deepEqual(br.ev.used, [target]);
    assert.deepEqual(br.ev.activated, []);
});
await test("list: clicking a build while loading more pauses the background work", async () => {
    reset();
    const db = copy(SAMPLES).concat(bigDb(60, 100, "spirit"), bigDb(60, 300, "gun"));
    const br = makeBrowser({ db, defaultList: copy(SAMPLES) });
    br.start();
    await advance(2);
    for (let i = 0; i < 200 && !/Loading more/.test(part(br, "BbfStatus").text); i++) await advance(0.05);   // a load is running
    br.ownRow("Haze bullet spam").events.onactivate();
    await advance(6);
    assert.equal(br.details.vars.selected_hero_build_name, "Haze bullet spam");
    const n = br.ev.searches.length, p = br.ev.previews.length;
    br.scrollTop();
    await advance(10);
    assert.equal(br.ev.searches.length, n);
    assert.equal(br.ev.previews.length, p);
    assert.match(part(br, "BbfStatus").text, /Paused/);
});
await test("list: filter off shows the game's list again (normal results), bots tagged", async () => {
    reset();
    const db = copy(SAMPLES).concat(bigDb(30, 100, "spirit"));
    const br = makeBrowser({ db, defaultList: copy(SAMPLES) });
    br.start();
    await advance(20);
    part(br, "BbfToggle").events.onactivate();
    await advance(3);
    assert.equal(br.shown(), null);
    assert.deepEqual(br.list.children.map((r) => r.build.name), SAMPLES.map((x) => x.name));
    assert.equal(visible(br).length, SAMPLES.length);
});
await test("list: the player's own search shows their results, filtered in place", async () => {
    reset();
    const db = copy(SAMPLES);
    const br = makeBrowser({ db, defaultList: db, rowsHaveDescription: true });
    br.start();
    await advance(8);
    br.searchEntry.text = "haze";
    await advance(1);
    assert.equal(br.shown(), null);
    assert.ok(!visible(br).includes("Haze Meta Build"));
});
await test("My Builds tab: our list hidden, nothing hidden, nothing previewed", async () => {
    reset();
    const db = copy(SAMPLES);
    const br = makeBrowser({ db, defaultList: db, rowsHaveDescription: true });
    br.selector.RemoveClass("ShowPublicBuilds"); br.selector.AddClass("ShowMyBuilds");
    br.start();
    await advance(3);
    assert.equal(br.shown(), null);
    assert.deepEqual(visible(br), ["Default Haze Build"], "vanilla My Builds: own, favourited, active, default");
    assert.equal(br.ev.previews.length, 0);
});

// ------------------------------------------------------------------ author records + favourites
const recText = (row) => { const r = row.FindChildrenWithClassTraverse("BbfRecord")[0]; return r && r.style.visibility !== "collapse" ? r.text : null; };
const favText = (row) => { const r = row.FindChildrenWithClassTraverse("BbfFav")[0]; return r && r.style.visibility !== "collapse" ? r.text : null; };
await test("records: each author's W/L on this hero, 0W 0L when none recorded; favourite counts", async () => {
    reset();
    const db = copy(SAMPLES);
    db.push({ key: "9|Rem first try", author: "9", name: "Rem first try", desc: "never tried this", annotations: [] });
    const br = makeBrowser({ db, defaultList: db });
    br.start();
    await advance(12);
    assert.equal(recText(br.ownRow("Haze bullet spam")), "30W 22L");
    assert.equal(recText(br.ownRow("Spirit Haze (fun)")), "1W 8L");
    assert.equal(recText(br.ownRow("Rem first try")), "0W 0L");
    assert.equal(recText(br.ownRow("Default Haze Build")), null, "no record for Valve's builds");
    assert.equal(favText(br.ownRow("Haze bullet spam")), "★ 48.2k");
    assert.equal(favText(br.ownRow("Tank Haze")), "★ 1.2k");
    assert.equal(favText(br.ownRow("Rem first try")), "★ 7", "every build's own count");
    assert.equal(favText(br.ownRow("Default Haze Build")), null);
    assert.ok(br.ev.statReqs.length >= 2 && br.ev.statReqs.every((r) => (r.cmd === "load" || r.hero === 13) && r.page === "https://bittybunnybytes.github.io/deadlock-bot-build-filter/relay/stats.html"), JSON.stringify(br.ev.statReqs));
    assert.equal(br.ev.statReqs[0].cmd, "load", "saved settings first");
    assert.equal(br.ev.statReqs[1].cmd, "builds", "then build texts");
    assert.ok(br.ev.statReqs.some((r) => r.cmd === "stats" && r.n >= 4), "records batched");
});
await test("records: also on the game's own rows (filter off)", async () => {
    reset();
    const db = copy(SAMPLES);
    const br = makeBrowser({ db, defaultList: db });
    br.start();
    await advance(3);
    part(br, "BbfToggle").events.onactivate();
    await advance(6);
    const row = br.list.children.find((r) => r.build.name === "Tank Haze");
    assert.equal(recText(row), "12W 8L");
    assert.equal(favText(row), "★ 1.2k");
});
await test("records: requests are batched and spaced; more load as more authors appear", async () => {
    reset();
    const db = copy(SAMPLES).concat(bigDb(120, 100, "spirit"), bigDb(120, 300, "gun"));
    const br = makeBrowser({ db, defaultList: copy(SAMPLES) });
    br.start();
    for (let i = 0; i < 120; i++) { br.scrollToBottom(); await advance(0.5); }
    const t = br.ev.statReqs.map((r) => r.at);
    for (let i = 1; i < t.length; i++) assert.ok(t[i] - t[i - 1] >= 1.99, "spacing " + (t[i] - t[i - 1]));
    assert.ok(br.ev.statReqs.every((r) => r.n <= 100));
    assert.equal(br.ev.statReqs.filter((r) => r.cmd === "favs").length, 0, "favourites come with the build texts");
    assert.ok(br.ev.statReqs.filter((r) => r.cmd === "builds").every((r) => r.n <= 40));
    const listed = br.shown().filter((n) => /build \d/.test(n));
    const missing = listed.filter((n) => recText(br.ownRow(n)) !== "0W 0L");
    assert.ok(listed.length >= 15 && !missing.length, "every loaded build got a record; missing " + missing.length + "/" + listed.length + ": " + missing.slice(0, 3).map((n) => n + "=" + recText(br.ownRow(n))).join(", ") + " state " + JSON.stringify(br.ev.statReqs.slice(-3)));
    console.log("     (" + br.ev.statReqs.length + " record requests for " + listed.length + " loaded builds)");
});
await test("records: a web view that cannot open the page gives up after 3 tries, list unaffected", async () => {
    reset();
    const db = copy(SAMPLES);
    const br = makeBrowser({ db, defaultList: db, webView: "blocked" });
    br.start();
    await advance(240);
    assert.equal(br.ev.statReqs.length, 3, "gives up after three failed requests");
    assert.ok(br.ev.log.some((l) => /author records: the web view could not open/.test(l)));
    assert.ok(br.shown().includes("Haze bullet spam"));
    assert.equal(recText(br.ownRow("Haze bullet spam")), null);
});
await test("records: no answer at all times out and retries with growing waits", async () => {
    reset();
    const db = copy(SAMPLES);
    const br = makeBrowser({ db, defaultList: db, webView: "silent" });
    br.start();
    await advance(400);
    const t = br.ev.statReqs.map((r) => r.at);
    assert.equal(t.length, 3);
    assert.ok(t[2] - t[1] > t[1] - t[0]);
});

await test("snippets missing (old layout) -> falls back to filtering the game's list, no errors", async () => {
    reset();
    const db = copy(SAMPLES);
    const src = SRC.replace("$.CreatePanelWithCurrentContext(main)", '$.CreatePanel("Panel", main, "")');
    const br = makeBrowser({ db, defaultList: db, src });
    br.start();
    await advance(6);
    assert.ok(br.ev.log.some((l) => /snippets not found/.test(l)));
    assert.ok(!br.ev.log.some((l) => /TypeError/.test(l)), br.ev.log.filter((l) => /TypeError/.test(l))[0]);
    assert.deepEqual(visible(br), ["Haze bullet spam", "Spirit Haze (fun)", "Tank Haze", "Default Haze Build"]);
});

// ------------------------------------------------------------------ searches, My Builds, tags
await test("load more: the search words actually reach the game network (not an empty box)", async () => {
    reset();
    const db = copy(SAMPLES).concat(bigDb(40, 100, "spirit"), bigDb(40, 300, "gun"));
    const br = makeBrowser({ db, defaultList: copy(SAMPLES) });
    br.start();
    await advance(30);
    const words = br.ev.searches.filter((x) => x);
    assert.ok(words.includes("spirit") && words.includes("gun"), JSON.stringify(br.ev.searches));
    assert.ok(br.shown().some((n) => /spirit build/.test(n)) && br.shown().some((n) => /gun build/.test(n)));
    assert.equal(br.searchEntry.text, "", "the box is empty again");
    assert.equal(br.shown() !== null, true, "our own text is not mistaken for a player search");
});
await test("My Builds after loading more: the normal list comes back with your own and favourited builds", async () => {
    reset();
    const mine = [
        { key: "50|My Haze", author: "50", name: "My Haze", desc: "mine", annotations: [], mine: true },
        { key: "51|Faved Haze", author: "51", name: "Faved Haze", desc: "faved", annotations: [], fav0: true }
    ];
    const def = copy(SAMPLES).concat(mine);
    const db = def.concat(bigDb(40, 100, "spirit"));
    const br = makeBrowser({ db, defaultList: def, activeName: "Haze bullet spam" });
    br.start();
    await advance(30);
    assert.ok(!br.list.children.some((r) => r.build.name === "My Haze"), "the stock list holds search results now");
    br.selector.RemoveClass("ShowPublicBuilds"); br.selector.AddClass("ShowMyBuilds");   // the player opens My Builds
    await advance(3);
    const v = visible(br);
    for (const n of ["My Haze", "Faved Haze", "Haze bullet spam", "Default Haze Build"]) assert.ok(v.includes(n), n + " missing from My Builds: " + v);
    assert.ok(!v.includes("Haze Meta Build"), "public builds do not leak into My Builds");
});
await test("in place: bot rows hidden with HidePublic only; My Builds unaffected", async () => {
    reset();
    const db = copy(SAMPLES).map((b) => (b.author === "2" ? { ...b, fav0: true } : b));
    const br = makeBrowser({ db, defaultList: db, src: IN_PLACE, rowsHaveDescription: true });
    br.start();
    await advance(6);
    assert.ok(!visible(br).includes("Haze 58.3% WR"));
    assert.ok(visible(br).includes("Haze Meta Build"), "a favourited build stays");
    assert.ok(br.list.children.every((r) => !r.style.visibility), "no inline visibility on stock rows");
    br.selector.RemoveClass("ShowPublicBuilds"); br.selector.AddClass("ShowMyBuilds");
    await advance(2);
    assert.deepEqual(visible(br), ["Haze Meta Build", "Default Haze Build"]);
});
await test("tags: our rows show the build's tags (standard, item, unknown -> name)", async () => {
    reset();
    const db = copy(SAMPLES).map((b) => (b.author === "4" ? { ...b, tags: ["Spirit", "Toxic Bullets", "Something New"] } : b.author === "5" ? { ...b, tags: ["Weapon"] } : b));
    const br = makeBrowser({ db, defaultList: db });
    br.start();
    await advance(8);
    const row = br.ownRow("Haze bullet spam");
    const t = [1, 2, 3].map((i) => row.FindChildTraverse("BuildTag" + i));
    assert.deepEqual(t.map((x) => x.FindChildTraverse("TagLabel").text), ["Spirit", "Toxic Bullets", "Something New"]);
    assert.equal(t[0].FindChildTraverse("TagImage").src, "s2r://panorama/images/builds/citadel_build_tag_spirit.vsvg");
    assert.equal(t[1].FindChildTraverse("TagImage").src, "s2r://panorama/images/items/weapon/toxic_bullets_psd.vtex", "the item's shop icon wins a shared name");
    assert.equal(t[2].FindChildTraverse("TagImage").style.visibility, "collapse", "unknown tag: no icon...");
    assert.equal(t[2].FindChildTraverse("TagLabel").style.visibility, "visible", "...its name instead");
    const row5 = br.ownRow("Spirit Haze (fun)");
    assert.equal(row5.FindChildTraverse("BuildTag1").FindChildTraverse("TagLabel").text, "Weapon");
    assert.equal(row5.FindChildTraverse("BuildTag2").style.visibility, "collapse");
});

// ------------------------------------------------------------------ the mod's own tags
await test("styleTags: annotated and L>R detection", () => {
    const T = (b) => JSON.parse(JSON.stringify(F.styleTags(b)));
    assert.deepEqual(T({ name: "x", desc: "", annotations: [] }), { annotated: false, ordered: false });
    assert.equal(T({ name: "x", desc: "", annotations: ["core"] }).annotated, true);
    for (const d of ["Follow this build left -> right.", "buy L>R", "L to R please", "Buy order: as listed", "build them in order", "follow the order"]) assert.equal(T({ name: "x", desc: d, annotations: [] }).ordered, true, d);
    assert.equal(T({ name: "x L->R", desc: "", annotations: [] }).ordered, true);
    assert.equal(T({ name: "x", desc: "", cats: "Early-Mid\nFollow left to right", annotations: [] }).ordered, true);
    assert.equal(T({ name: "x", desc: "", annotations: ["#1", "#2", "#3 Sell"] }).ordered, true, "numbered notes");
    assert.equal(T({ name: "x", desc: "", annotations: ["1st", "2nd"] }).ordered, false, "two numbers are not an order");
    for (const d of ["Lane: Lash to rush", "Fast as boi", "order a pizza", "+20% fire rate, 1.5k souls"]) assert.equal(T({ name: "x", desc: d, annotations: [] }).ordered, false, d);
});
await test("tag filter: picking L>R / Annotated filters the list; our tags show on rows; the × clears it", async () => {
    reset();
    const db = copy(SAMPLES).map((b) => (b.author === "4" ? { ...b, desc: b.desc + " Follow left -> right." } : b.author === "7" ? { ...b, desc: b.desc + " L>R", tags: ["Weapon", "Spirit"] } : b));
    db.push({ key: "8|Plain build", author: "8", name: "Plain build", desc: "nothing special", annotations: [] });
    const br = makeBrowser({ db, defaultList: db });
    br.start();
    await advance(10);
    assert.ok(br.shown().includes("Plain build"));
    // our tags on rows
    const row = br.ownRow("Haze bullet spam");
    const chips = [1, 2, 3].map((i) => row.FindChildTraverse("BuildTag" + i)).filter((c) => c.style.visibility === "visible");
    assert.deepEqual(chips.map((c) => c.FindChildTraverse("TagLabel").text), ["Annotated", "L>R"]);
    assert.equal(chips[1].FindChildTraverse("TagImage").src, "s2r://panorama/images/bot_build_filter/tag_ordered.vsvg");
    // three chips at most: a build with two tags of its own gets only one of ours
    const row7 = br.ownRow("Tank Haze");
    const vis7 = [1, 2, 3].map((i) => row7.FindChildTraverse("BuildTag" + i)).filter((c) => c.style.visibility === "visible");
    assert.deepEqual(vis7.map((c) => c.FindChildTraverse("TagLabel").text), ["Weapon", "Spirit", "Annotated"]);
    br.manager.SetAttributeString("bbf3_tag_filter", "ordered");
    await advance(1);
    assert.deepEqual(br.shown(), ["Haze bullet spam", "Tank Haze"]);
    assert.match(labels(br).join(" "), /Tags: L>R  ×/);
    br.manager.SetAttributeString("bbf3_tag_filter", "annotated");
    await advance(1);
    assert.deepEqual(br.shown(), ["Haze bullet spam", "Tank Haze"]);
    part(br, "BbfFilterLabel").events.onactivate();   // the × on the filter label
    await advance(1);
    assert.ok(br.shown().includes("Plain build"));
});
await test("picker: our group's tags toggle the filter on the root panel and close the picker", async () => {
    reset();
    const PICKER = fs.readFileSync(new URL("../src/bot_build_filter_picker.js", import.meta.url), "utf8");
    const root = new P("Panel", null, "Root");
    const manager = new P("Panel", root, "PopupManager");
    const picker = new P("PopupBuildTagPicker", manager, "");
    const group = new P("Panel", picker, "BbfTags");
    const events = [];
    const $ = { GetContextPanel: () => picker, CreatePanel: (type, parent, id) => { const p = new P(type, parent, id); if (type === "Image") p.SetImage = (src) => { p.src = src; }; return p; },
                DispatchEvent: (name, panel) => events.push(name) };
    vm.runInNewContext(PICKER, { $ });
    const chips = group.children.filter((c) => c.classes.has("BbfPickTag"));
    assert.equal(chips.length, 2);
    assert.ok(chips.every((c) => c.children.length === 1 && c.children[0].paneltype === "Image"), "icon only, no text");
    assert.equal(chips[1].children[0].src, "s2r://panorama/images/bot_build_filter/tag_ordered.vsvg");
    chips[1].events.onactivate();
    assert.equal(root.GetAttributeString("bbf3_tag_filter", ""), "ordered");
    assert.ok(events.includes("UIPopupButtonClicked"));
    chips[0].events.onactivate();
    assert.equal(root.GetAttributeString("bbf3_tag_filter", ""), "ordered,annotated");
    chips[1].events.onactivate();
    assert.equal(root.GetAttributeString("bbf3_tag_filter", ""), "annotated");
});

// ------------------------------------------------------------------ loading builds without showing them
await test("background: build texts come from the API; nothing is previewed; bots still caught; search box hidden meanwhile", async () => {
    reset();
    const db = copy(SAMPLES).concat(bigDb(60, 100, "spirit"));
    db.push({ key: "900|spirit wr bot", author: "900", name: "spirit wr bot", desc: BOT_DESC("Haze", "5,000"), annotations: ["+WR 3%", "+WR 4%"] });
    const br = makeBrowser({ db, defaultList: copy(SAMPLES) });
    const opacities = [];
    const origDispatch = br.selector.AddClass.bind(br.selector);
    br.selector.AddClass = (c) => { if (c === "BuildsLoading") opacities.push(br.searchEntry.style.opacity); origDispatch(c); };
    br.start();
    for (let i = 0; i < 60; i++) { br.scrollToBottom(); await advance(0.5); }
    assert.deepEqual(br.ev.previews, [], "no build was shown in the details pane");
    const shown = br.shown();
    for (const bot of ["Haze 58.3% WR", "Haze Meta Build", "Best Haze", "Haze vs melee", "spirit wr bot"]) assert.ok(!shown.includes(bot), bot + " should be hidden");
    assert.ok(shown.includes("spirit build 3") && shown.includes("Haze bullet spam"));
    assert.ok(opacities.length && opacities.every((o) => o === "0"), "our words are invisible while searching: " + opacities);
    assert.equal(br.searchEntry.style.opacity, "1", "and the box is back afterwards");
    assert.ok(br.ev.statReqs.some((r) => r.cmd === "builds"));
});
await test("background: builds the API lacks stay unchecked; 'Check N in detail' previews them only when clicked", async () => {
    reset();
    const db = copy(SAMPLES).map((b) => (b.author === "6" || b.author === "5" ? { ...b, apiMissing: true } : b));
    const br = makeBrowser({ db, defaultList: db });
    br.start();
    await advance(12);
    assert.deepEqual(br.ev.previews, []);
    assert.ok(br.shown().includes("Haze vs melee"), "not known as a bot yet (its notes are only in the details pane)");
    assert.ok(br.ownRow("Haze vs melee").classes.has("BbfUnchecked"));
    const status = part(br, "BbfStatus");
    for (let i = 0; i < 120 && !/Check/.test(status.text); i++) await advance(0.5);   // filling a short list stops after a dry batch
    assert.match(status.text, /Check 2 in detail/);
    status.events.onactivate();
    await advance(6);
    assert.ok(br.ev.previews.includes("Haze vs melee"));
    assert.ok(!br.shown().includes("Haze vs melee"), "caught once previewed");
});
await test("background: a search does not take away the build the player picked", async () => {
    reset();
    const db = copy(SAMPLES).concat(bigDb(40, 100, "spirit"), bigDb(40, 300, "gun"));
    const br = makeBrowser({ db, defaultList: copy(SAMPLES) });
    // the game shows the first result after each search
    const fill0 = br.list.RemoveAndDeleteChildren.bind(br.list);
    br.start();
    await advance(8);
    br.ownRow("Tank Haze").events.onactivate();
    await advance(2);
    assert.equal(br.details.vars.selected_hero_build_name, "Tank Haze");
    const origSearch = br.selector.RemoveClass.bind(br.selector);
    br.selector.RemoveClass = (c) => { origSearch(c); if (c === "BuildsLoading" && br.list.children[0]) br.show(br.list.children[0].build); };
    // resume (if the pick paused background work) and load more while the pick is shown
    const statusLabel = part(br, "BbfStatus");
    if (/resume/.test(statusLabel.text)) statusLabel.events.onactivate();
    await advance(1);
    br.own().children.find((r) => r.classes.has("BbfMore")).events.onactivate();
    await advance(15);
    assert.ok(br.ev.searches.some((w) => w === "gun" || w === "weapon" || w === "melee" || w === "spirit"), JSON.stringify(br.ev.searches));
    assert.equal(br.details.vars.selected_hero_build_name, "Tank Haze", "the pick is shown again");
    void fill0;
});
await test("background: a big batch of new rows is created over several passes", async () => {
    reset();
    const db = copy(SAMPLES).concat(bigDb(80, 100, "spirit"));
    const def = copy(SAMPLES).concat(bigDb(80, 100, "spirit"));
    const br = makeBrowser({ db, defaultList: def, rowsHaveDescription: true });
    let maxPerFrame = 0, count = 0, lastAt = -1;
    const orig = P.prototype.BLoadLayoutSnippet;
    P.prototype.BLoadLayoutSnippet = function (name) { if (name === "BbfRow") { if (clock !== lastAt) { lastAt = clock; count = 0; } count++; maxPerFrame = Math.max(maxPerFrame, count); } return orig.call(this, name); };
    br.start();
    await advance(10);
    P.prototype.BLoadLayoutSnippet = orig;
    assert.ok(br.shown().length >= 80);
    assert.ok(maxPerFrame <= 12, "rows made in one pass: " + maxPerFrame);
});

// ------------------------------------------------------------------ sorting and settings
function richDb() {
    const db = [
        { key: "4|Haze bullet spam", author: "4", name: "Haze bullet spam", desc: "gun", annotations: [], apiFav: 500, updated: 1790000000 },
        { key: "5|Spirit Haze (fun)", author: "5", name: "Spirit Haze (fun)", desc: "spirit", annotations: [], apiFav: 9000, updated: 1795000000 },
        { key: "7|Tank Haze", author: "7", name: "Tank Haze", desc: "tank", annotations: [], apiFav: 20, updated: 1780000000, obsolete: true },
        { key: "9|Never played", author: "9", name: "Never played", desc: "theory", annotations: [], apiFav: 3, updated: 1794000000 },
        { key: "0|Default Haze Build", author: "0", name: "Default Haze Build", desc: "valve", annotations: [] }
    ];
    return db;
}
const order = (b) => b.shown().filter((n) => n !== "Default Haze Build");
await test("sorting: favourites, latest updated, most played, most wins, win rate", async () => {
    reset(); for (const k in STORE) delete STORE[k];
    const db = richDb();
    const br = makeBrowser({ db, defaultList: db });
    br.start();
    await advance(15);
    assert.deepEqual(order(br), ["Haze bullet spam", "Spirit Haze (fun)", "Tank Haze", "Never played"], "game order");
    part(br, "BbfSortLabel").events.onactivate();   // open the sort menu
    const menu = br.main.children.find((c) => c.classes.has("BbfSortMenu"));
    assert.ok(menu.classes.has("BbfOpen"));
    const pick = (name) => menu.children.find((i) => i.children[0].text === name).events.onactivate();
    pick("Most favourited"); await advance(0.5);
    assert.deepEqual(order(br), ["Spirit Haze (fun)", "Haze bullet spam", "Tank Haze", "Never played"]);
    assert.ok(!menu.classes.has("BbfOpen"), "menu closes");
    assert.match(part(br, "BbfSortLabel").text, /Sort: Most favourited/);
    part(br, "BbfSortLabel").events.onactivate(); pick("Latest updated"); await advance(0.5);
    assert.deepEqual(order(br), ["Spirit Haze (fun)", "Never played", "Haze bullet spam", "Tank Haze"]);
    part(br, "BbfSortLabel").events.onactivate(); pick("Most played"); await advance(0.5);
    assert.deepEqual(order(br), ["Haze bullet spam", "Tank Haze", "Spirit Haze (fun)", "Never played"], "52, 20, 9, 0 games");
    part(br, "BbfSortLabel").events.onactivate(); pick("Most wins"); await advance(0.5);
    assert.deepEqual(order(br), ["Haze bullet spam", "Tank Haze", "Spirit Haze (fun)", "Never played"]);
    part(br, "BbfSortLabel").events.onactivate(); pick("Best win rate"); await advance(0.5);
    assert.deepEqual(order(br), ["Tank Haze", "Haze bullet spam", "Spirit Haze (fun)", "Never played"], "60%, 58%, 11% (5+ games), then none");
    assert.equal(br.shown()[br.shown().length - 1], "Default Haze Build", "Valve's build stays last");
});
function setting(br, title) {
    const panel = br.main.children.find((c) => c.classes.has("BbfSettings"));
    const rowsAll = panel.FindChildrenWithClassTraverse("BbfSetRow");
    const row = rowsAll.find((r) => r.FindChildrenWithClassTraverse("BbfSetTitle")[0].text === title);
    assert.ok(row, "setting row " + title);
    return row;
}
const choose = (br, title, label) => setting(br, title).FindChildrenWithClassTraverse("BbfChoice").find((c) => c.text === label).events.onactivate();
const flip = (br, title) => setting(br, title).FindChildrenWithClassTraverse("BbfPill")[0].events.onactivate();
await test("settings: the ⚙ opens a panel; hiding outdated, low-game and low-win-rate builds; reset", async () => {
    reset(); for (const k in STORE) delete STORE[k];
    const db = richDb();
    const br = makeBrowser({ db, defaultList: db });
    br.start();
    await advance(15);
    part(br, "BbfCog").events.onactivate();
    const panel = br.main.children.find((c) => c.classes.has("BbfSettings"));
    assert.ok(panel.classes.has("BbfOpen"));
    assert.equal(setting(br, "Hide bot builds").FindChildrenWithClassTraverse("BbfPill")[0].text, "ON");
    flip(br, "…are outdated"); await advance(0.5);
    assert.ok(!order(br).includes("Tank Haze"));
    choose(br, "…whose author played this hero less than", "1 game"); await advance(0.5);
    assert.ok(!order(br).includes("Never played"), "0 recorded games");
    choose(br, "…whose author's win rate is below", "50%"); await advance(0.5);
    assert.deepEqual(order(br), ["Haze bullet spam"], "11% over 9 games is hidden");
    assert.match(br.own().children.find((r) => r.classes.has("BbfMore")).children[0].text, /3 hidden by your settings/);
    choose(br, "…have fewer favourites than", "1k"); await advance(0.5);
    assert.deepEqual(order(br), []);
    panel.FindChildrenWithClassTraverse("BbfSetButton").find((b) => b.text === "Reset to defaults").events.onactivate(); await advance(0.5);
    assert.equal(order(br).length, 4);
    flip(br, "The author's record"); await advance(0.5);
    assert.equal(recText(br.ownRow("Haze bullet spam")), null, "record hidden on rows");
    panel.FindChildrenWithClassTraverse("BbfSetButton").find((b) => b.text === "Done").events.onactivate();
    assert.ok(!panel.classes.has("BbfOpen"));
});
await test("settings: saved in the lookup page's storage and loaded by the next build browser", async () => {
    reset(); for (const k in STORE) delete STORE[k];
    const db = richDb();
    let br = makeBrowser({ db, defaultList: db });
    br.start();
    await advance(10);
    part(br, "BbfCog").events.onactivate();
    choose(br, "Order the list by", "Most favourited");
    choose(br, "How strict", "Strict");
    await advance(6);
    assert.ok(STORE.bbf_settings && JSON.parse(STORE.bbf_settings).sort === "favs", "saved: " + STORE.bbf_settings);
    clock = 0; timers = [];                       // a new game session (the page storage stays)
    br = makeBrowser({ db, defaultList: db });   // nothing on the popup manager
    br.start();
    await advance(15);
    assert.match(part(br, "BbfSortLabel").text, /Most favourited/);
    assert.deepEqual(order(br)[0], "Spirit Haze (fun)");
});
await test("settings: with loading on scroll off, scrolling does not search", async () => {
    reset(); for (const k in STORE) delete STORE[k];
    STORE.bbf_settings = JSON.stringify({ autoLoad: false });
    const db = copy(SAMPLES).concat(bigDb(40, 100, "spirit"));
    const br = makeBrowser({ db, defaultList: copy(SAMPLES) });
    br.start();
    for (let i = 0; i < 40; i++) { br.scrollToBottom(); await advance(0.5); }
    assert.deepEqual(br.ev.searches.filter((x) => x), [], "no word searches");
    assert.match(br.own().children.find((r) => r.classes.has("BbfMore")).children[0].text, /Click to load more/);
    br.own().children.find((r) => r.classes.has("BbfMore")).events.onactivate();
    await advance(8);
    assert.ok(br.ev.searches.filter((x) => x).length >= 1, "a click still loads");
});

// ------------------------------------------------------------------ regressions from the bug-fix pass
await test("bugfix: a build clicked in the game's list still gets its texts from the API (no pane reading)", async () => {
    reset();
    const db = copy(SAMPLES);
    const br = makeBrowser({ db, defaultList: db, src: IN_PLACE_API });
    // the player clicks "Haze vs melee" right away (its bot notes are only known to the API)
    br.show(db.find((b) => b.name === "Haze vs melee"));
    br.start();
    await advance(10);
    assert.ok(!visible(br).includes("Haze vs melee"), "flagged from the API's notes");
    assert.ok((br.ev.apiAuthors || []).includes("6"));
    assert.deepEqual(br.ev.previews, []);
});
await test("bugfix: a bot farm's identical '+WR' notes across accounts still count", async () => {
    reset();
    const farm = [10, 11, 12, 13].map((a) => ({ key: a + "|Haze build " + a, author: String(a), name: "Haze build " + a, desc: "", annotations: ["+WR 3.1%", "+WR 2.4%"] }));
    const db = copy(SAMPLES.filter((b) => HUMANS.includes(b.name))).concat(farm);
    const br = makeBrowser({ db, defaultList: db });
    br.start();
    await advance(10);
    for (const f of farm) assert.ok(!br.shown().includes(f.name), f.name);
});
await test("bugfix: common notes like 'Core' on many builds still make them Annotated", async () => {
    reset();
    const db = [1, 2, 3, 4].map((a) => ({ key: (40 + a) + "|Plain " + a, author: String(40 + a), name: "Plain " + a, desc: "x", annotations: ["Core"] }))
        .concat(copy(SAMPLES.filter((b) => b.author === "0")));   // the game's list always ends with Valve's build (tells the hero)
    const br = makeBrowser({ db, defaultList: db });
    br.start();
    await advance(10);
    const chips = [1, 2, 3].map((i) => br.ownRow("Plain 1").FindChildTraverse("BuildTag" + i)).filter((c) => c.style.visibility === "visible");
    assert.deepEqual(chips.map((c) => c.FindChildTraverse("TagLabel").text), ["Annotated"]);
});
await test("bugfix: an author the API fails on is asked at most twice", async () => {
    reset();
    const db = copy(SAMPLES).map((b) => (b.author === "4" ? { ...b, apiFails: true } : b));
    const br = makeBrowser({ db, defaultList: db });
    br.start();
    await advance(60);
    assert.equal((br.ev.apiAuthors || []).filter((a) => a === "4").length, 2);
});
await test("bugfix: a slow 40-author batch is not treated as a failure", async () => {
    reset();
    const db = copy(SAMPLES).concat(bigDb(45, 100, "spirit"));
    const br = makeBrowser({ db, defaultList: db, apiLatency: 0.5 });   // 40 authors -> 20 s
    br.start();
    await advance(60);
    assert.ok(!br.ev.log.some((l) => /no answer/.test(l)), br.ev.log.filter((l) => /no answer/.test(l))[0]);
    assert.ok(br.ev.log.some((l) => /build texts: \d+ builds from 40 authors/.test(l)));
});
await test("bugfix: names that differ in spacing or case still match the API's copy", async () => {
    reset();
    const db = copy(SAMPLES).map((b) => (b.author === "6" ? { ...b, apiName: "  HAZE VS  MELEE " } : b));
    const br = makeBrowser({ db, defaultList: db });
    br.start();
    await advance(10);
    assert.ok(!br.shown().includes("Haze vs melee"), "its API notes were matched to the row");
});
await test("bugfix: in the game's own list, Check previews only the builds it counts", async () => {
    reset();
    const db = copy(SAMPLES).map((b) => (b.author === "5" ? { ...b, apiMissing: true } : b));
    const br = makeBrowser({ db, defaultList: db, src: IN_PLACE_API });
    br.start();
    await advance(10);
    assert.match(part(br, "BbfStatus").text, /Check 1 in detail/);
    part(br, "BbfStatus").events.onactivate();
    await advance(5);
    assert.deepEqual(br.ev.previews, ["Spirit Haze (fun)"]);
});

console.log(failures ? failures + " failed" : "all passed");
process.exit(failures ? 1 : 0);
