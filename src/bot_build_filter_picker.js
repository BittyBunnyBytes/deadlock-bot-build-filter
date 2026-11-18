"use strict";
// Bot Build Filter: its own tags in the game's tag picker ("Ordered and annotated").
// These are not game tags (the game network cannot search by them): picking one sets a filter the
// build browser script applies to its list. The choice is kept on the root panel, which the build
// browser and this popup share.
(function () {
    var TAGS = [
        { id: "annotated", name: "Annotated", icon: "s2r://panorama/images/bot_build_filter/tag_annotated.vsvg",
          tip: "Builds whose items carry notes (annotations)." },
        { id: "ordered", name: "L>R", icon: "s2r://panorama/images/bot_build_filter/tag_ordered.vsvg",
          tip: "Builds that say which order to buy in: \"L>R\", \"left to right\", a buy order, or numbered items." }
    ];
    function valid(p) { try { return !!(p && p.IsValid && p.IsValid()); } catch (e) { return false; } }
    var picker = $.GetContextPanel();
    while (valid(picker) && picker.paneltype !== "PopupBuildTagPicker") picker = picker.GetParent();
    if (!valid(picker)) return;
    var root = picker;
    while (valid(root.GetParent())) root = root.GetParent();
    var list = picker.FindChildTraverse("BbfTags");
    if (!list) return;
    function current() { var v = root.GetAttributeString("bbf3_tag_filter", ""); return v ? v.split(",") : []; }
    var on = current();
    TAGS.forEach(function (t) {
        var chip = $.CreatePanel("Panel", list, "");
        chip.AddClass("BbfPickTag");
        chip.SetHasClass("BbfOn", on.indexOf(t.id) >= 0);
        var img = $.CreatePanel("Image", chip, "");
        try { img.SetImage(t.icon); } catch (e) {}
        var l = $.CreatePanel("Label", chip, "");
        l.text = t.name;
        chip.SetPanelEvent("onmouseover", function () { try { $.DispatchEvent("UIShowTextTooltip", chip, t.tip + "<br>Click again to remove it."); } catch (e) {} });
        chip.SetPanelEvent("onmouseout", function () { try { $.DispatchEvent("UIHideTextTooltip", chip); } catch (e) {} });
        chip.SetPanelEvent("onactivate", function () {
            var cur = current(), i = cur.indexOf(t.id);
            if (i >= 0) cur.splice(i, 1); else cur.push(t.id);
            root.SetAttributeString("bbf3_tag_filter", cur.join(","));
            try { $.DispatchEvent("UIHideTextTooltip", chip); } catch (e) {}
            try { $.DispatchEvent("UIPopupButtonClicked", picker); } catch (e) {}
        });
    });
    var hint = $.CreatePanel("Label", list, "");
    hint.AddClass("BbfPickHint");
    hint.text = "Bot Build Filter tags filter the list it shows (the game network cannot search by them).";
})();
