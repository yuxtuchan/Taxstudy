"""e-Gov の法令XML（消費税法）から、暗記ツール用の条文カード（data/jobun.json）を作る。

使い方:
    python3 tools/build_jobun.py <法令XML> data/jobun.json [重要度.json]

重要度.json は {"30:1": 2, "4": 1, "別表第二": 2, ...} の形（条番号は 12_2 のように「の」を _ に）。
値は ★ の数（2→ランクA、1→ランクB）。指定がない条・項はランクC。
"""
import json
import re
import sys
import xml.etree.ElementTree as ET

KANJI = {"〇": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
FW = str.maketrans("0123456789", "０１２３４５６７８９")
SPLIT_ARTICLE = 700   # これより長い条は項ごとに分ける
SPLIT_PARA = 1200     # これより長い項は号のまとまりで分ける
CHUNK = 800           # 号をまとめる目安の文字数


def text(e):
    return "".join(e.itertext()).strip() if e is not None else ""


def sentence(e):
    """ParagraphSentence / ItemSentence など。Column は全角空白でつなぐ。"""
    if e is None:
        return ""
    cols = e.findall("Column")
    if cols:
        return "　".join(text(c) for c in cols)
    return "".join(text(s) for s in e.findall("Sentence"))


def item_lines(item, depth=0):
    tag = item.tag
    title = item.findtext(tag + "Title") or ""
    body = sentence(item.find(tag + "Sentence"))
    lines = [("　" * depth) + title.strip() + "　" + body]
    for child in item:
        if child.tag.startswith("Subitem") and not child.tag.endswith(("Title", "Sentence")):
            lines += item_lines(child, depth + 1)
    return lines


def art_label(num):
    a = num.split("_")
    return "第" + a[0] + "条" + "".join("の" + x for x in a[1:])


def rank_of(ranks, keys):
    v = max((ranks.get(k, -1) for k in keys), default=-1)
    return "A" if v >= 2 else "B" if v == 1 else "C"


def chunk(items):
    """号（とその下のイロハ）を切らずに、CHUNK 文字程度ずつまとめる。"""
    groups, cur, cur_len = [], [], 0
    top = [i for i, ln in enumerate(items) if not ln.startswith("　")] or [0]
    if top[0] != 0:
        top = [0] + top
    bounds = top + [len(items)]
    for a, b in zip(bounds, bounds[1:]):
        block = items[a:b]
        blen = sum(map(len, block))
        if cur and cur_len + blen > CHUNK:
            groups.append(cur)
            cur, cur_len = [], 0
        cur += block
        cur_len += blen
    if cur:
        groups.append(cur)
    return groups


def range_label(group):
    nums = [ln.split("　")[0] for ln in group if not ln.startswith("　")]
    if not nums:
        return ""
    return f"（{nums[0]}号）" if nums[0] == nums[-1] else f"（{nums[0]}〜{nums[-1]}号）"


def build(xml_path, ranks):
    root = ET.parse(xml_path).getroot()
    body = root.find("LawBody")
    cards = []

    def add(title, category, rank, lines):
        cards.append({"title": title, "category": category, "rank": rank, "body": "\n".join(lines)})

    for chap in body.find("MainProvision").findall("Chapter"):
        ctitle = (chap.findtext("ChapterTitle") or "").split("　", 1)[-1]
        category = "条文・" + ctitle
        caption = ""
        for art in chap.iter("Article"):
            caption = (art.findtext("ArticleCaption") or "").strip("（）") or caption
            num = art.get("Num")
            label = art_label(num)
            paras = art.findall("Paragraph")
            if all(re.fullmatch(r"削除", sentence(p.find("ParagraphSentence"))) for p in paras):
                continue
            plines = []
            for p in paras:
                pnum = (p.findtext("ParagraphNum") or "").strip()
                lead = (pnum + "　" if pnum else "") + sentence(p.find("ParagraphSentence"))
                items = [ln for it in p.findall("Item") for ln in item_lines(it)]
                plines.append((int(p.get("Num")), lead, items))
            total = sum(len(l) + sum(map(len, i)) for _, l, i in plines)
            akeys = [num] + [f"{num}:{n}" for n, _, _ in plines]
            if total <= SPLIT_ARTICLE or len(plines) == 1 and total <= SPLIT_PARA:
                lines = [ln for _, l, i in plines for ln in [l] + i]
                add(f"{label} {caption}", category, rank_of(ranks, akeys), lines)
                continue
            for n, lead, items in plines:
                keys = [num, f"{num}:{n}"]
                ptitle = f"{label}第{n}項 {caption}" if len(plines) > 1 else f"{label} {caption}"
                size = len(lead) + sum(map(len, items))
                if size <= SPLIT_PARA or not items:
                    add(ptitle, category, rank_of(ranks, keys), [lead] + items)
                    continue
                # 号をまとめて分割（1枚目にだけ柱書きを入れる）
                groups = chunk(items)
                for gi, g in enumerate(groups):
                    add(f"{ptitle}{range_label(g)}", category, rank_of(ranks, keys), ([lead] if gi == 0 else []) + g)

    for tbl in body.findall("AppdxTable"):
        title = (tbl.findtext("AppdxTableTitle") or "").strip()
        name = re.sub(r"[（(].*", "", title)
        if name == "別表第三":
            continue  # 公共法人等の名称一覧なので除く
        lines = []
        for it in tbl.iter("Item"):
            lines += item_lines(it)
        if not lines:
            lines = [text(tbl)]
        groups = chunk(lines) if sum(map(len, lines)) > SPLIT_PARA else [lines]
        for g in groups:
            add(f"{name}{range_label(g) if len(groups) > 1 else ''}", "条文・別表", rank_of(ranks, [name]), g)
    return cards


if __name__ == "__main__":
    ranks = json.load(open(sys.argv[3], encoding="utf-8")) if len(sys.argv) > 3 else {}
    cards = build(sys.argv[1], ranks)
    for i, c in enumerate(cards):
        c["id"] = "jobun-" + str(i + 1).zfill(4)
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        json.dump({"source": "消費税法（e-Gov法令データ）", "theories": cards}, f, ensure_ascii=False, indent=0)
    print(len(cards), "cards", sum(len(c["body"]) for c in cards), "chars")
