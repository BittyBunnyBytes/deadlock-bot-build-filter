#!/usr/bin/env python3
"""Builds the Bot Build Filter VPKs. Standard library only; needs a Deadlock install.

  python3 tools/build.py [--game <.../Deadlock/game/citadel>]

Writes:
  dist/bot_build_filter_dir.vpk           standalone (stock build browser + the filter)
  dist/bot_build_filter_buildgem_dir.vpk  only if Build Gem is installed: Build Gem's browser layout + the filter,
                                          so both mods run (this VPK must load before Build Gem's)

Panorama resources are written the way the game accepts hand-made ones: the resource header and
RED2 block are taken from the game's own compiled files of the same kind, and the DATA block holds
the source text (layouts: CRC32 + u16 0 + XML; scripts: the JavaScript as is).
"""
import argparse, glob, json, os, struct, sys, zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import vpkread  # noqa: E402

SCRIPT_PATH = "panorama/scripts/bot_build_filter/bot_build_filter.vjs_c"
STYLE_PATH = "panorama/styles/bot_build_filter/bot_build_filter.vcss_c"
LAYOUT_PATH = "panorama/layout/popups/citadel_popup_build_browser.vxml_c"
PICKER_PATH = "panorama/layout/popups/citadel_popup_build_tag_picker.vxml_c"
PICKER_SCRIPT_PATH = "panorama/scripts/bot_build_filter/bot_build_filter_picker.vjs_c"
ICON_DIR = "panorama/images/bot_build_filter/"
INCLUDE = '<include src="s2r://%s" />' % SCRIPT_PATH
STYLE_INCLUDES = ['<include src="s2r://panorama/styles/citadel_ui_build_selector.vcss" />',
                  '<include src="s2r://%s" />' % STYLE_PATH]
MOD_NAMES = "resource/localization/citadel_gc_mod_names/citadel_gc_mod_names_english.txt"


def item_names(game):
    """Shop item names (search words for "load more"), from the game's English item-name file."""
    import re
    try:
        text = open(os.path.join(game, MOD_NAMES), encoding="utf-8", errors="replace").read()
    except OSError:
        return []
    out = []
    for key, val in re.findall(r'"(upgrade_[a-z0-9_]+)"\s+"([^"]+)"', text):
        if key.endswith(("_search", "_desc")) or "{" in val or "<" in val or len(val) > 30:
            continue
        if val not in out:
            out.append(val)
    return out


def hero_ids(game):
    """{hero class: hero id} from the game's scripts/heroes.vdata (for the author-record lookup)."""
    import kv3
    try:
        root = kv3.plain(kv3.decode(dict(blocks(stock(game, "scripts/heroes.vdata_c")))[b"DATA"])[0])
    except Exception as e:  # noqa: BLE001
        print("hero ids unavailable:", e)
        return {}
    return {k: v["m_HeroID"] for k, v in root.items()
            if isinstance(v, dict) and isinstance(v.get("m_HeroID"), int) and v["m_HeroID"] > 0 and not v.get("m_bDisabled")}


def ability_images(game):
    """{ability/item key: s2r icon path} for build-tag icons, from scripts/abilities.vdata; only icons
    that exist in the game's files are kept."""
    import kv3
    p = os.path.join(game, "pak01_dir.vpk")
    idx = vpkread.index(p)
    try:
        root = kv3.plain(kv3.decode(dict(blocks(vpkread.read(p, "scripts/abilities.vdata_c", idx)))[b"DATA"])[0])
    except Exception as e:  # noqa: BLE001
        print("ability images unavailable:", e)
        return {}
    out = {}
    for key, v in root.items():
        src = v.get("m_strAbilityImage") if isinstance(v, dict) else None
        if not isinstance(src, str) or not src.startswith("file://{images}/") or key.endswith("_base"):
            continue
        rel, ext = os.path.splitext(src[len("file://{images}/"):])
        compiled = rel + (".vsvg" if ext == ".svg" else "_%s.vtex" % ext[1:])
        if "panorama/images/" + compiled + "_c" in idx[0]:
            out[key] = "s2r://panorama/images/" + compiled
    return out


def inject(xml, snippets):
    """Add our stylesheets, snippets and script to a build-browser layout (stock or Build Gem's)."""
    if INCLUDE in xml:
        return xml
    xml = xml.replace("</styles>", "".join("\t" + i + "\n\t" for i in STYLE_INCLUDES) + "</styles>", 1)
    if "</scripts>" in xml:
        xml = xml.replace("</scripts>", "\t" + INCLUDE + "\n\t</scripts>", 1)
    else:
        xml = xml.replace("</styles>", "</styles>\n\t<scripts>\n\t\t" + INCLUDE + "\n\t</scripts>", 1)
    if "</snippets>" in xml:
        xml = xml.replace("</snippets>", snippets + "\t</snippets>", 1)
    else:
        xml = xml.replace("</scripts>", "</scripts>\n\t<snippets>\n" + snippets + "\t</snippets>", 1)
    return xml


def find_game():
    cands = glob.glob("/run/user/*/doc/*/Deadlock/game/citadel") + glob.glob(os.path.expanduser(
        "~/.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/common/Deadlock/game/citadel")) + glob.glob(os.path.expanduser(
        "~/.local/share/Steam/steamapps/common/Deadlock/game/citadel")) + glob.glob(os.path.expanduser(
        "~/.steam/steam/steamapps/common/Deadlock/game/citadel"))
    for c in cands:
        if os.path.exists(os.path.join(c, "pak01_dir.vpk")):
            return c
    return None


def blocks(d):
    n = struct.unpack_from("<I", d, 12)[0]
    out = []
    for i in range(n):
        p = 16 + 12 * i
        o, s = struct.unpack_from("<II", d, p + 4)
        out.append((d[p:p + 4], d[p + 4 + o:p + 4 + o + s]))
    return out


def resource(version, red2, data):
    """Resource file with two blocks (RED2, DATA), 16-byte aligned like the game's."""
    def pad(n):
        return (n + 15) & ~15
    red_at = pad(16 + 24)
    data_at = pad(red_at + len(red2))
    size = data_at + len(data)
    out = bytearray(size)
    struct.pack_into("<IHHII", out, 0, size, 12, version, 8, 2)
    struct.pack_into("<4sII", out, 16, b"RED2", red_at - 20, len(red2))
    struct.pack_into("<4sII", out, 28, b"DATA", data_at - 32, len(data))
    out[red_at:red_at + len(red2)] = red2
    out[data_at:] = data
    return bytes(out)


def layout_resource(xml, red2):
    xml = xml.encode("utf-8") if isinstance(xml, str) else xml
    return resource(3, red2, struct.pack("<IH", zlib.crc32(xml) & 0xFFFFFFFF, 0) + xml)


def svg_resource(svg, red2):
    svg = svg.encode("utf-8") if isinstance(svg, str) else svg
    return resource(2, red2, struct.pack("<IH", zlib.crc32(svg) & 0xFFFFFFFF, 0) + svg)


def script_resource(js, red2):
    return resource(4, red2, js.encode("utf-8"))


def write_vpk(path, files):
    """VPK v2, every file stored inside the _dir file (archive index 0x7fff)."""
    by_ext = {}
    for name in sorted(files):
        d, base = name.rsplit("/", 1)
        stem, ext = base.rsplit(".", 1)
        by_ext.setdefault(ext, {}).setdefault(d, []).append((stem, name))
    tree, blob = bytearray(), bytearray()
    for ext in sorted(by_ext):
        tree += ext.encode() + b"\0"
        for d in sorted(by_ext[ext]):
            tree += d.encode() + b"\0"
            for stem, name in by_ext[ext][d]:
                data = files[name]
                tree += stem.encode() + b"\0"
                tree += struct.pack("<IHHIIH", zlib.crc32(data) & 0xFFFFFFFF, 0, 0x7FFF, len(blob), len(data), 0xFFFF)
                blob += data
            tree += b"\0"
        tree += b"\0"
    tree += b"\0"
    with open(path, "wb") as f:
        f.write(struct.pack("<IIIIIII", 0x55AA1234, 2, len(tree), len(blob), 0, 0, 0))
        f.write(tree)
        f.write(blob)


def stock(game, name):
    p = os.path.join(game, "pak01_dir.vpk")
    return vpkread.read(p, name, vpkread.index(p))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", default=None, help="Deadlock/game/citadel folder")
    a = ap.parse_args()
    game = a.game or find_game()
    if not game:
        sys.exit("Deadlock not found; pass --game .../Deadlock/game/citadel")

    red_layout = dict(blocks(stock(game, LAYOUT_PATH)))[b"RED2"]
    red_script = dict(blocks(stock(game, "panorama/scripts/async.vts_c")))[b"RED2"]
    red_style = dict(blocks(stock(game, "panorama/styles/popups/citadel_popup_build_browser.vcss_c")))[b"RED2"]

    def src(name):
        return open(os.path.join(ROOT, "src", name), encoding="utf-8").read()
    js = src("bot_build_filter.js")
    names = item_names(game)
    marker = "var ITEM_NAMES = []; /*@ITEM_NAMES@*/"
    if marker not in js:
        sys.exit("ITEM_NAMES marker missing in bot_build_filter.js")
    js = js.replace(marker, "var ITEM_NAMES = " + json.dumps(names) + ";")
    print("search words from item names:", len(names))
    heroes = hero_ids(game)
    marker = "var HERO_IDS = {}; /*@HERO_IDS@*/"
    if marker not in js:
        sys.exit("HERO_IDS marker missing in bot_build_filter.js")
    js = js.replace(marker, "var HERO_IDS = " + json.dumps(heroes, sort_keys=True) + ";")
    print("hero ids:", len(heroes))
    images = ability_images(game)
    marker = "var ABILITY_IMAGES = {}; /*@ABILITY_IMAGES@*/"
    if marker not in js:
        sys.exit("ABILITY_IMAGES marker missing in bot_build_filter.js")
    js = js.replace(marker, "var ABILITY_IMAGES = " + json.dumps(images, sort_keys=True, separators=(",", ":")) + ";")
    print("tag icons:", len(images))
    red_picker = dict(blocks(stock(game, PICKER_PATH)))[b"RED2"]
    red_svg = dict(blocks(stock(game, "panorama/images/builds/citadel_build_tag_spirit.vsvg_c")))[b"RED2"]
    common = {SCRIPT_PATH: script_resource(js, red_script), STYLE_PATH: layout_resource(src("bot_build_filter.css"), red_style),
              PICKER_PATH: layout_resource(src("citadel_popup_build_tag_picker.xml"), red_picker),
              PICKER_SCRIPT_PATH: script_resource(src("bot_build_filter_picker.js"), red_script)}
    for icon in sorted(os.listdir(os.path.join(ROOT, "src", "icons"))):
        if icon.endswith(".svg"):
            common[ICON_DIR + icon[:-4] + ".vsvg_c"] = svg_resource(src(os.path.join("icons", icon)), red_svg)
    snippets = src("snippets.xml")
    os.makedirs(os.path.join(ROOT, "dist"), exist_ok=True)

    out = os.path.join(ROOT, "dist", "bot_build_filter_dir.vpk")
    write_vpk(out, dict(common, **{LAYOUT_PATH: layout_resource(inject(src("citadel_popup_build_browser.xml"), snippets), red_layout)}))
    print("wrote", out)

    # Build Gem replaces the same layout; make a combined one from the installed copy.
    for vpk in sorted(glob.glob(os.path.join(game, "addons", "*_dir.vpk"))):
        try:
            idx = vpkread.index(vpk)
        except Exception:
            continue
        if "panorama/scripts/build_gem/build_gem.vjs_c" not in idx[0] or LAYOUT_PATH not in idx[0]:
            continue
        data = dict(blocks(vpkread.read(vpk, LAYOUT_PATH, idx)))[b"DATA"]
        gem_xml = data[6:].decode("utf-8")
        if INCLUDE in gem_xml:
            continue
        out = os.path.join(ROOT, "dist", "bot_build_filter_buildgem_dir.vpk")
        write_vpk(out, dict(common, **{LAYOUT_PATH: layout_resource(inject(gem_xml, snippets), red_layout)}))
        print("wrote", out, "(with Build Gem's layout from", os.path.basename(vpk) + ")")
        break


if __name__ == "__main__":
    main()
