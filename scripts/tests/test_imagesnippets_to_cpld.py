"""Offline tests of imagesnippets_to_cpld.py: python3 -m unittest discover -s scripts/tests"""

import json
import os
import re
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import imagesnippets_to_cpld as m  # noqa: E402

GRAPH = "https://imagesnippets.com/imgtag/rdf/info@margaretwarren.us/20190902_184336"


def fixture(name):
    with open(os.path.join(HERE, "fixtures", "margaret-warren-20190902_184336." + name), encoding="utf-8") as f:
        return f.read()


def triples():
    bindings = json.loads(fixture("bindings.json"))["results"]["bindings"]
    return [(b["s"]["value"], b["p"]["value"], b["o"]) for b in bindings]


def flat(doc):
    """The nodes of the document by @id, those of the default graph and of the graph objects in it."""
    nodes = {}

    def walk(items):
        for n in items:
            if "@graph" in n:
                walk(n["@graph"])
            if len(n) > (2 if "@graph" in n else 1):
                nodes[n["@id"]] = n
    walk(doc["graph"]["@graph"])
    return nodes


class Regions(unittest.TestCase):
    def test_rect(self):
        self.assertEqual(m.shape_of("rect", 'x="142" y="258" height="22" width="19"'),
                         {"shape": "rect", "coords": [142, 258, 161, 280]})

    def test_width_is_not_stroke_width(self):
        self.assertEqual(m.shape_of("rect", 'stroke-width="9" x="1" y="2" width="3" height="4"')["coords"], [1, 2, 4, 6])

    def test_polygon_and_circle(self):
        self.assertEqual(m.shape_of("polygon", 'points="0,0 10,0 10,10"'), {"shape": "poly", "coords": [0, 0, 10, 0, 10, 10]})
        self.assertEqual(m.shape_of("circle", 'cx="5" cy="6" r="7"'), {"shape": "circle", "coords": [5, 6, 7]})
        self.assertIsNone(m.shape_of("circle", 'cx="5" cy="6" r="0"'))

    def test_path_is_a_polygon(self):
        self.assertEqual(m.path_points(" M8 363 L309 275 L50 20 z"), [8, 363, 309, 275, 50, 20])

    def test_path_closing_and_repeated_corners_are_dropped(self):
        self.assertEqual(m.path_points("M0 0 L10 0 L10 0 L10 10 L0 0 Z"), [0, 0, 10, 0, 10, 10])

    def test_path_hv(self):
        self.assertEqual(m.path_points("M0 0 H10 V10 Z"), [0, 0, 10, 0, 10, 10])

    def test_path_that_is_not_a_polygon(self):
        self.assertIsNone(m.path_points("M0 0 C 1 1 2 2 3 3"))      # a curve
        self.assertIsNone(m.path_points("m0 0 l10 0 l0 10 z"))      # relative
        self.assertIsNone(m.path_points("M0 0 L1 1 L2 0 M5 5 L6 6 L7 5"))  # two subpaths
        self.assertIsNone(m.path_points("M0 0 L1 1"))               # a line

    def test_rdf_page(self):
        regions = m.parse_regions(fixture("rdf-page.html"))
        self.assertEqual((regions["width"], regions["height"]), (1016, 762))
        self.assertEqual(sorted(regions["shapes"]), ["Region_Region A", "Region_Region B", "Region_Region C"])
        self.assertEqual(regions["shapes"]["Region_Region C"]["coords"], [215, 590, 416, 676])

    def test_selectors(self):
        self.assertEqual(m.selector({"shape": "rect", "coords": [142, 258, 161, 280]})["rdf:value"], "xywh=pixel:142,258,19,22")
        poly = m.selector({"shape": "poly", "coords": [0, 0, 10, 0, 10, 10]})
        self.assertEqual(poly["@type"], "oa:SvgSelector")
        self.assertIn('<polygon points="0,0 10,0 10,10"/>', poly["rdf:value"])


class Naming(unittest.TestCase):
    def test_graph_iri(self):
        for url in ("https://imagesnippets.com/imgtag/images/info@margaretwarren.us/20190902_184336.jpg",
                    "https://imagesnippets.com/imgtag/images/info@margaretwarren.us/20190902_184336.html",
                    GRAPH):
            self.assertEqual(m.graph_iri_of(url), GRAPH)
        with self.assertRaises(ValueError):
            m.graph_iri_of("https://example.org/a.jpg")

    def test_region_id(self):
        self.assertEqual(m.region_id("Region_Region A", {}), "region-a")
        self.assertEqual(m.region_id("Region_Region A", {"region-a": True}), "region-a-2")
        self.assertEqual(m.region_id("Region_3", {}), "region-3")

    def test_compact(self):
        self.assertEqual(m.compact("http://schema.org/name"), "schema:name")
        self.assertEqual(m.compact("https://w3id.org/lio/v1#shows"), "lio:shows")
        self.assertEqual(m.compact("http://example.org/a/b"), "http://example.org/a/b")


class Document(unittest.TestCase):
    def build(self, wikidata=None):
        t = triples()
        row = m.summarise(t, GRAPH)
        regions = m.parse_regions(fixture("rdf-page.html"))
        return row, t, m.build_document(row, t, regions, wikidata)

    def test_row(self):
        row, _, _ = self.build()
        self.assertEqual(row["image"], "https://imagesnippets.com/imgtag/images/info@margaretwarren.us/20190902_184336.jpg")
        self.assertEqual(row["title"], "Labyrinth")
        self.assertEqual(row["creator"], "Margaret Warren")

    def test_page_holds_the_canvas_and_every_region_flat(self):
        _, _, doc = self.build()
        by_id = flat(doc)
        page = by_id[doc["page"]]
        self.assertEqual([p["@id"] for p in page["schema:hasPart"]], ["doc:canvas", "doc:region-b", "doc:region-a", "doc:region-c"])
        self.assertNotIn("schema:hasPart", by_id["doc:image"])
        self.assertNotIn("schema:hasPart", by_id["doc:canvas"])
        self.assertEqual(page["schema:mainEntity"], [{"@id": "doc:image"}])

    def test_the_image_has_its_own_named_graph(self):
        _, _, doc = self.build()
        top = doc["graph"]["@graph"]
        graphs = [n for n in top if "@graph" in n]
        self.assertEqual([g["@id"] for g in graphs], ["doc:image-graph"])
        inside = [n["@id"] for n in graphs[0]["@graph"]]
        self.assertEqual(inside[:2], ["doc:image", "doc:canvas"])
        self.assertTrue({"doc:region-a", "doc:region-b", "doc:region-c"} <= set(inside))
        outside = [n["@id"] for n in top if "@graph" not in n]
        self.assertEqual(outside[0], doc["page"])
        self.assertFalse(any(i.startswith("doc:") and i != "doc:image-graph" for i in outside))
        described = [n for n in top if n["@id"] == "doc:image-graph" and "@graph" not in n][0]
        self.assertEqual(described["schema:isPartOf"], [{"@id": doc["page"]}])

    def test_regions_have_selectors_and_labels(self):
        _, _, doc = self.build()
        by_id = flat(doc)
        a = by_id["doc:region-a"]
        self.assertEqual(a["rdfs:label"], [{"@value": "Region A"}])
        self.assertEqual(a["oa:hasSelector"][0]["rdf:value"], "xywh=pixel:142,258,19,22")
        self.assertEqual(a["lio:shows"], [{"@id": "http://dbpedia.org/resource/Boat"}])

    def test_chrome_is_left_out(self):
        _, _, doc = self.build()
        text = json.dumps(doc["graph"])
        self.assertNotIn("ogp.me", text)
        self.assertNotIn("twitter:", text)

    def test_wikidata_labels_replace_the_store(self):
        q = "http://www.wikidata.org/entity/Q34679"
        _, _, doc = self.build({q: "SAND"})
        node = flat(doc)[q]
        self.assertEqual(node["rdfs:label"], [{"@value": "SAND", "@language": "en"}])

    def test_wikidata_iris(self):
        iris = m.wikidata_iris(triples())
        self.assertIn("http://www.wikidata.org/entity/Q34679", iris)
        self.assertTrue(all(m.WIKIDATA_ENTITY.match(i) for i in iris))

    def test_markup_is_rdf_html(self):
        self.assertEqual(m.ld_value({"type": "literal", "value": "<p>hi</p>"}, lambda i: i),
                         {"@type": "rdf:HTML", "@value": "<p>hi</p>"})
        self.assertEqual(m.ld_value({"type": "literal", "value": "hi", "xml:lang": "en"}, lambda i: i),
                         {"@value": "hi", "@language": "en"})

    def test_the_context_has_no_vocab_and_a_doc_prefix(self):
        _, _, doc = self.build()
        ctx = doc["graph"]["@context"]
        self.assertNotIn("@vocab", ctx)
        self.assertEqual(ctx["doc"], doc["page"] + "#")


class Assets(unittest.TestCase):
    def test_the_example_uses_the_same_regions_script_and_styles(self):
        example = os.path.join(HERE, "..", "..", "examples", "cpld", "margaret-warren-20190902_184336")
        for folder, name in (("scripts", "regions.js"), ("styles", "regions.css")):
            path = os.path.join(example, folder, name)
            if not os.path.exists(path):
                self.skipTest("no example")
            with open(path, "rb") as a, open(os.path.join(m.ASSETS, name), "rb") as b:
                self.assertEqual(a.read(), b.read(), name + " differs from scripts/cpld-assets")


class Html(unittest.TestCase):
    def test_every_element_of_the_body_has_an_id(self):
        row = m.summarise(triples(), GRAPH)
        doc = m.build_document(row, triples(), m.parse_regions(fixture("rdf-page.html")))
        page = m.build_html(doc, row, "media/20190902_184336.jpg")
        body = page.split("<body", 1)[1]
        for tag in re.findall(r"<(?!/|!)([a-z0-9]+)\b([^>]*)>", body):
            self.assertIn(' id="', " " + tag[1], "<%s%s> has no id" % tag)
        self.assertIn('<meta name="id" content="%s">' % doc["page"], page)
        self.assertIn('rel="describedby"', page)

    def test_unplaced_regions_are_listed_under_their_ids(self):
        row = m.summarise(triples(), GRAPH)
        doc = m.build_document(row, triples(), {"width": 0, "height": 0, "shapes": {}})
        page = m.build_html(doc, row, "x.jpg")
        self.assertIn('<li id="region-a">', page)

    def test_inline_graph_cannot_close_the_script(self):
        row = m.summarise(triples(), GRAPH)
        row["title"] = "</script><b>"
        doc = m.build_document(row, triples(), {"width": 0, "height": 0, "shapes": {}})
        page = m.build_html(doc, row, "x.jpg", inline_graph=True)
        self.assertEqual(page.count("</script>"), 2)  # the graph and regions.js

    def test_write(self):
        row = m.summarise(triples(), GRAPH)
        doc = m.build_document(row, triples(), m.parse_regions(fixture("rdf-page.html")))
        with tempfile.TemporaryDirectory() as d:
            m.write_document(d, doc, row, b"JPEG", "20190902_184336.jpg")
            for name in ("index.html", "graph.jsonld", "media/20190902_184336.jpg", "scripts/regions.js", "styles/regions.css"):
                self.assertTrue(os.path.exists(os.path.join(d, name)), name)
            with open(os.path.join(d, "index.html"), encoding="utf-8") as f:
                self.assertIn('src="media/20190902_184336.jpg"', f.read())


if __name__ == "__main__":
    unittest.main()
