#!/usr/bin/env python3
"""Convert an image on imagesnippets.com, with its triples, to a CP/LD Linked Document.

    python3 imagesnippets_to_cpld.py https://imagesnippets.com/imgtag/images/USER/NAME.jpg --out DIR

writes, in DIR:

    index.html          the canvas: the image, its caption and credit
    graph.jsonld        the image's graph (schema.org, LIO, Web Annotation) and its regions
    media/NAME.jpg      a copy of the image
    scripts/regions.js  builds the image map from graph.jsonld, shows what a region shows
    styles/regions.css

It is the same document the plugin builds for the lightbox ("Open as a Linked
Document", includes/linked-document.php), for any image, without WordPress.

Where the data comes from:
  * the triples: the SPARQL endpoint of ImageSnippets, the image's named graph;
  * where the regions are: the HTML of the image's RDF page, which carries an
    <svg> of shapes (the store has no geometry);
  * the labels of Wikidata entities: Wikidata itself (query.wikidata.org), not the
    copy in the store (--no-wikidata keeps the store's).

Only the Python standard library is used.
"""

import argparse
import html
import json
import os
import re
import shutil
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

ENDPOINT = "https://imagesnippets.com/sparql/dbpedia"
WIKIDATA_ENDPOINT = "https://query.wikidata.org/sparql"
USER_AGENT = "imagesnippets-to-cpld/1.0 (+https://github.com/gchartier/image-snippets-gallery)"
ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cpld-assets")

RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label"
LIO_SHOWS = "https://w3id.org/lio/v1#shows"

# The same prefixes as the plugin (graph.php, isgal_jsonld_prefixes()), less @vocab: every term is a CURIE.
CONTEXT = {
    "schema": "http://schema.org/",
    "lio": "https://w3id.org/lio/v1#",
    "dc": "http://purl.org/dc/elements/1.1/",
    "dcterms": "http://purl.org/dc/terms/",
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
    "foaf": "http://xmlns.com/foaf/0.1/",
    "photoshop": "http://ns.adobe.com/photoshop/1.0/",
    "Iptc4xmpCore": "http://www.iptc.org/std/Iptc4xmpCore/1.0/xmlns/",
    "xmpRights": "http://ns.adobe.com/xap/1.0/rights/",
    "plus": "http://ns.useplus.org/ldf/xmp/1.0/",
    "exif": "http://ns.adobe.com/exif/1.0/",
    "wdt": "http://www.wikidata.org/prop/direct/",
    "dbr": "http://dbpedia.org/resource/",
    "aat": "http://vocab.getty.edu/aat/",
    "oa": "http://www.w3.org/ns/oa#",
    "iptc4xmpext": "http://iptc.org/std/Iptc4xmpExt/2008-02-29/",
    "xmp": "http://ns.adobe.com/xap/1.0/",
}

# Predicates that describe the ImageSnippets web page, not the image.
CHROME_PREFIXES = (
    "http://ogp.me/ns#",
    "https://ogp.me/ns#",
    "twitter:",
    "http://www.w3.org/1999/xhtml/vocab#",
)

WIKIDATA_ENTITY = re.compile(r"^http://www\.wikidata\.org/entity/(Q[1-9][0-9]*)$")


# --------------------------------------------------------------------------
# Regions: the shapes in the <svg> of the RDF page, as <area> shapes
# --------------------------------------------------------------------------

def _attr(attrs, name):
    """The value of one attribute in the text of a start tag ("width" is not in "stroke-width")."""
    m = re.search(r"(?<![\w:-])" + re.escape(name) + r"""\s*=\s*(["'])(.*?)\1""", attrs, re.I | re.S)
    return html.unescape(m.group(2)) if m else ""


def _is_number(text):
    try:
        float(text)
        return True
    except ValueError:
        return False


def _round(x):
    # PHP's round(): half away from zero.
    return int(x + 0.5) if x >= 0 else -int(-x + 0.5)


def _numbers(text):
    parts = [p for p in re.split(r"[\s,]+", (text or "").strip()) if p]
    if not all(_is_number(p) for p in parts):
        return None
    return [_round(float(p)) for p in parts]


def _attr_numbers(attrs, names):
    out = []
    for name in names:
        value = _attr(attrs, name)
        if not _is_number(value):
            return None
        out.append(_round(float(value)))
    return out


def path_points(d):
    """The corners of a path made only of straight, absolute lines (M, L, H, V, Z), else None.

    ImageSnippets writes a polygon as <path d=" M8 363 L309 275 ... z"/>.
    """
    tokens = re.findall(r"([A-Za-z])|(-?\d*\.?\d+(?:e[-+]?\d+)?)", d or "", re.I)
    if not tokens:
        return None
    points, pending, command, x, y, moves = [], [], "", 0.0, 0.0, 0

    def flush():
        nonlocal x, y, pending
        if command == "H":
            x = pending[0]
        elif command == "V":
            y = pending[0]
        else:
            x, y = pending
        points.append((x, y))
        pending = []

    for letter, number in tokens:
        if number != "":
            if command not in ("M", "L", "H", "V"):
                return None
            pending.append(float(number))
            if len(pending) == (1 if command in ("H", "V") else 2):
                flush()
                if command == "M":  # further pairs after an M are implicit lineto
                    command = "L"
            continue
        if pending:
            return None
        command = letter
        if command == "M":
            moves += 1
            if moves > 1:
                return None
        if command not in ("M", "L", "H", "V", "Z", "z"):
            return None
    pairs = []
    for px, py in points:
        pair = (_round(px), _round(py))
        if not pairs or pairs[-1] != pair:  # a repeated corner adds nothing
            pairs.append(pair)
    if len(pairs) > 1 and pairs[0] == pairs[-1]:  # the browser closes the polygon
        pairs.pop()
    if len(pairs) < 3:
        return None
    return [c for pair in pairs for c in pair]


def shape_of(tag, attrs):
    """One SVG shape as an image-map shape: {'shape': rect|poly|circle, 'coords': [...]}.

    rect is left, top, right, bottom; poly is x1,y1,...,xn,yn; circle is cx, cy, r.
    """
    tag = tag.lower()
    if tag == "rect":
        n = _attr_numbers(attrs, ("x", "y", "width", "height"))
        if not n or n[2] <= 0 or n[3] <= 0:
            return None
        return {"shape": "rect", "coords": [n[0], n[1], n[0] + n[2], n[1] + n[3]]}
    if tag == "circle":
        n = _attr_numbers(attrs, ("cx", "cy", "r"))
        return {"shape": "circle", "coords": n} if n and n[2] > 0 else None
    points = None
    if tag == "polygon":
        points = _numbers(_attr(attrs, "points"))
        if not (points and len(points) % 2 == 0 and len(points) >= 6):
            points = None
    elif tag == "path":
        points = path_points(_attr(attrs, "d"))
    return {"shape": "poly", "coords": points} if points else None


def parse_regions(page_html):
    """The regions of an image from the HTML of its RDF page.

    Returns {'width', 'height', 'shapes': {fragment: shape}}; the fragment is
    percent-decoded, without the '#'. The first <svg> that holds any shape wins.
    """
    out = {"width": 0, "height": 0, "shapes": {}}
    for svg in re.finditer(r"<svg\b([^>]*)>(.*?)</svg>", page_html or "", re.I | re.S):
        for element in re.finditer(r"<(rect|path|polygon|circle)\b([^>]*?)/?>", svg.group(2), re.I):
            ident = _attr(element.group(2), "id").lstrip("#")
            shape = shape_of(element.group(1), element.group(2))
            if ident and shape:
                out["shapes"][urllib.parse.unquote(ident)] = shape
        if out["shapes"]:
            for key in ("width", "height"):
                m = re.match(r"\d+", _attr(svg.group(1), key))
                out[key] = int(m.group(0)) if m else 0
            break
    return out


def selector(shape):
    """Where a region is, as a Web Annotation selector (Media Fragment for a rectangle, else SVG)."""
    c = shape["coords"]
    if shape["shape"] == "rect":
        return {
            "@type": "oa:FragmentSelector",
            "dcterms:conformsTo": {"@id": "http://www.w3.org/TR/media-frags/"},
            "rdf:value": "xywh=pixel:%d,%d,%d,%d" % (c[0], c[1], c[2] - c[0], c[3] - c[1]),
        }
    if shape["shape"] == "circle":
        svg = '<circle cx="%d" cy="%d" r="%d"/>' % tuple(c)
    else:
        svg = '<polygon points="%s"/>' % " ".join("%d,%d" % (c[i], c[i + 1]) for i in range(0, len(c), 2))
    return {"@type": "oa:SvgSelector", "rdf:value": '<svg xmlns="http://www.w3.org/2000/svg">%s</svg>' % svg}


# --------------------------------------------------------------------------
# Fetching
# --------------------------------------------------------------------------

CAFILE = None  # set by --cafile; else the system's trust, or SSL_CERT_FILE


def http_get(url, accept, timeout=30, binary=False):
    request = urllib.request.Request(url, headers={"Accept": accept, "User-Agent": USER_AGENT})
    context = ssl.create_default_context(cafile=CAFILE) if CAFILE else None
    with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
        body = response.read()
    return body if binary else body.decode("utf-8", "replace")


def sparql(endpoint, query):
    url = endpoint + ("&" if "?" in endpoint else "?") + urllib.parse.urlencode({"query": query})
    data = json.loads(http_get(url, "application/sparql-results+json"))
    return data["results"]["bindings"]


def fetch_triples(endpoint, graph):
    """Every statement of the image's named graph, as (subject, predicate, term) with a SPARQL JSON term."""
    query = "SELECT ?s ?p ?o WHERE { GRAPH <%s> { ?s ?p ?o } }" % graph
    return [(b["s"]["value"], b["p"]["value"], b["o"]) for b in sparql(endpoint, query)]


def wikidata_iris(triples):
    found = {}
    for s, _, o in triples:
        for iri in (s, o["value"] if o.get("type") == "uri" else ""):
            if WIKIDATA_ENTITY.match(iri):
                found[iri] = True
    return list(found)


def wikidata_labels(iris, lang="en", endpoint=WIKIDATA_ENDPOINT):
    """Labels of Wikidata entities from Wikidata itself, in one request: {entity IRI: label}."""
    ids = {}
    for iri in iris:
        m = WIKIDATA_ENTITY.match(iri)
        if m:
            ids[m.group(1)] = iri
    if not ids or not re.match(r"^[a-z]{2,3}(-[A-Za-z0-9]+)*$", lang):
        return {}
    query = "SELECT ?e ?l WHERE { VALUES ?e { %s } ?e rdfs:label ?l . FILTER(lang(?l) = \"%s\") }" % (
        " ".join("wd:" + q for q in ids), lang)
    labels = {}
    for b in sparql(endpoint, query):
        q = b["e"]["value"].rsplit("/", 1)[-1]
        if q in ids and b["l"]["value"].strip():
            labels[ids[q]] = b["l"]["value"].strip()
    return labels


def graph_iri_of(url):
    """The named graph (the RDF page) of an image from any of its imagesnippets.com addresses."""
    m = re.match(r"^(https?://[^/]+/imgtag)/(?:images|rdf)/([^/]+)/([^/?#]+?)(?:\.[A-Za-z0-9]{2,5})?/?(?:[?#].*)?$", url)
    if not m:
        raise ValueError("not an ImageSnippets image address: " + url)
    return "%s/rdf/%s/%s" % (m.group(1), m.group(2), m.group(3))


# --------------------------------------------------------------------------
# The document
# --------------------------------------------------------------------------

def compact(iri, context=CONTEXT):
    """Compact an IRI against the context, longest namespace first."""
    for prefix, namespace in sorted(context.items(), key=lambda kv: -len(kv[1])):
        if iri.startswith(namespace):
            local = iri[len(namespace):]
            if local and not re.search(r"[/#?\s]", local):
                return prefix + ":" + local
    return iri


def region_id(fragment, taken):
    """The id a region gets in the document: "Region_Region A" is "region-a"."""
    slug = re.sub(r"[^a-z0-9]+", "-", re.sub(r"^Region_", "", fragment).lower()).strip("-")
    ident = slug if slug.startswith("region") else ("region-" + slug).strip("-")
    base, n = ident, 2
    while ident in taken:
        ident = "%s-%d" % (base, n)
        n += 1
    return ident


def node_label(iri, labels):
    """What to call a node that may have no rdfs:label: a region by its fragment, else a compact IRI."""
    if labels.get(iri, "").strip():
        return labels[iri].strip()
    if "#" in iri and iri.split("#", 1)[1]:
        name = urllib.parse.unquote(iri.split("#", 1)[1])
        return re.sub(r"^Region_", "", name).replace("_", " ")
    return compact(iri)


def ld_value(term, node_id):
    """One term of a triple as a JSON-LD value. A literal with markup is typed rdf:HTML."""
    value, kind = term.get("value", ""), term.get("type", "literal")
    if kind == "uri":
        return {"@id": node_id(value)}
    if kind == "bnode":
        return {"@id": "_:" + value}
    if re.search(r"</?[a-z][a-z0-9]*(\s[^>]*)?/?>", value, re.I):
        return {"@type": "rdf:HTML", "@value": value}
    if term.get("xml:lang"):
        return {"@value": value, "@language": term["xml:lang"]}
    datatype = term.get("datatype")
    if datatype and datatype != "http://www.w3.org/2001/XMLSchema#string":
        return {"@type": compact(datatype), "@value": value}
    return {"@value": value}


def first(candidates):
    for c in candidates:
        if isinstance(c, str) and c.strip():
            return c.strip()
    return ""


def summarise(triples, graph):
    """The image and the fields the page shows, from the triples about the image itself."""
    image = ""
    for s, p, o in triples:
        if p == "http://schema.org/thumbnail":
            image = s
            break
    if not image:
        for s, p, o in triples:
            if p == RDF_TYPE and o.get("value") == "http://schema.org/ImageObject":
                image = s
                break
    props = {}
    for s, p, o in triples:
        if s == image:
            props.setdefault(p, []).append(o)
    labels = {s: o["value"] for s, p, o in triples if p == RDFS_LABEL and o.get("type") == "literal"}

    def one(predicate):
        return props[predicate][0]["value"] if props.get(predicate) else ""

    def labelled(predicate):
        if not props.get(predicate):
            return ""
        term = props[predicate][0]
        return labels.get(term["value"], term["value"]) if term.get("type") == "uri" else term["value"]

    return {
        "graph": graph,
        "image": image,
        "thumb": one("http://schema.org/thumbnail"),
        "content": one("http://schema.org/contentUrl"),
        "title": one("http://purl.org/dc/elements/1.1/title"),
        "name": one("http://schema.org/name"),
        "desc": one("http://www.iptc.org/std/Iptc4xmpCore/1.0/xmlns/ExtDescrAccessibility"),
        "alt": one("http://www.iptc.org/std/Iptc4xmpCore/1.0/xmlns/AltTextAccessibility"),
        "date": one("http://ns.adobe.com/photoshop/1.0/DateCreated"),
        "rights": labelled("http://purl.org/dc/elements/1.1/rights"),
        "web": one("http://ns.adobe.com/xap/1.0/rights/WebStatement"),
        "creator": labelled("http://purl.org/dc/elements/1.1/creator"),
        "labels": labels,
    }


def page_iri(row):
    """The IRI of the image's page: the image's address with .html for its extension."""
    image = row["image"]
    if re.match(r"^https?://\S+\.[A-Za-z0-9]{2,5}$", image):
        return re.sub(r"\.[A-Za-z0-9]{2,5}$", ".html", image)
    return row["graph"]


IMAGE_GRAPH = "doc:image-graph"


def build_document(row, triples, regions, wikidata=None, wikidata_lang="en"):
    """The Linked Document of an image: {'page', 'graph' (JSON-LD), 'regions': [...], 'width', 'height'}."""
    page = page_iri(row)
    context = dict(CONTEXT)
    context["doc"] = page + "#"
    wikidata = wikidata or {}
    labels = dict(row["labels"])
    labels.update(wikidata)  # a Wikidata entity is labelled by Wikidata

    # Which IRIs are regions, and the id each has in the document.
    region_ids, regions_in, taken = {}, {}, {}
    for s, _, o in triples:
        for iri in (s, o["value"] if o.get("type") == "uri" else ""):
            m = re.search(r"#(Region_[^#]*)$", iri)
            if iri and iri not in region_ids and m:
                fragment = urllib.parse.unquote(m.group(1))
                ident = region_id(fragment, taken)
                taken[ident] = True
                region_ids[iri] = ident
                regions_in[iri] = fragment

    def node_id(iri):
        if iri == row["image"]:
            return "doc:image"
        return "doc:" + region_ids[iri] if iri in region_ids else iri

    nodes = {}
    for subject, predicate, term in triples:
        value = (term.get("value") or "").strip()
        if not value or any(predicate.startswith(p) for p in CHROME_PREFIXES):
            continue
        nid = node_id(subject)
        node = nodes.setdefault(nid, {"@id": nid})
        if predicate == RDF_TYPE and term.get("type") == "uri":
            node.setdefault("@type", []).append(compact(value, context))
            continue
        node.setdefault(compact(predicate, context), []).append(ld_value(term, node_id))
    for node in nodes.values():
        for key, values in node.items():
            if key != "@id":
                unique = []
                for v in values:
                    if v not in unique:
                        unique.append(v)
                node[key] = unique

    for iri, label in wikidata.items():
        node = nodes.setdefault(iri, {"@id": iri})
        node["rdfs:label"] = [{"@value": label, "@language": wikidata_lang}]

    content = first([row["content"], row["image"]])
    if regions["width"] > 0 and regions["height"] > 0 and "doc:image" in nodes:
        nodes["doc:image"]["schema:width"] = [{"@value": regions["width"]}]
        nodes["doc:image"]["schema:height"] = [{"@value": regions["height"]}]

    listing = []
    for iri, ident in region_ids.items():
        doc_id = "doc:" + ident
        label = node_label(iri, labels)
        node = nodes.setdefault(doc_id, {"@id": doc_id})
        node.setdefault("rdfs:label", [{"@value": label}])
        what = []
        for s, p, o in triples:
            if s == iri and p == LIO_SHOWS and o.get("value"):
                name = node_label(o["value"], labels)
                if name not in what:
                    what.append(name)
        shape = regions["shapes"].get(regions_in[iri])
        if shape:
            node["oa:hasSelector"] = [selector(shape)]
        listing.append({"id": ident, "label": label, "shows": what, "shape": shape})

    # The page, and the canvas. CP/LD does not nest parts: the canvas and every region are parts of the page.
    title = first([row["title"], row["name"]])
    page_node = nodes.setdefault(page, {"@id": page})
    page_node["@type"] = ["schema:WebPage"]
    if title:
        page_node["schema:name"] = [{"@value": title}]
    page_node["schema:mainEntity"] = [{"@id": "doc:image"}]
    page_node["schema:hasPart"] = [{"@id": "doc:canvas"}] + [{"@id": "doc:" + r["id"]} for r in listing]
    nodes["doc:canvas"] = {
        "@id": "doc:canvas",
        "@type": ["schema:ImageObject"],
        "schema:contentUrl": [{"@id": content}],
    }

    ordered = [page, "doc:image", "doc:canvas"] + ["doc:" + i for i in region_ids.values()]
    graph = [nodes.pop(i) for i in ordered if i in nodes]
    graph += list(nodes.values())

    # The image, the canvas, the regions and what the page itself names (its instances) are the image graph, a
    # named graph in the file. The page, its parts' text and the registry labels stay in the default graph.
    def in_image_graph(node):
        nid = node["@id"]
        return nid.startswith("doc:") or (nid.startswith(page + "#") and nid != page)

    image_nodes = [n for n in graph if in_image_graph(n)]
    rest = [n for n in graph if not in_image_graph(n)]
    if image_nodes:
        at = 1 if rest and rest[0]["@id"] == page else 0
        rest[at:at] = [
            {"@id": IMAGE_GRAPH, "rdfs:label": [{"@value": "Image graph"}], "schema:isPartOf": [{"@id": page}]},
            {"@id": IMAGE_GRAPH, "@graph": image_nodes},
        ]
        graph = rest
    return {
        "page": page,
        "graph": {"@context": context, "@graph": graph},
        "regions": listing,
        "width": regions["width"],
        "height": regions["height"],
    }


def caption_of(description):
    """The first paragraph of a description, as text (what comes before the markdown LIO description)."""
    text = re.sub(r"<(br|/div|/p)\b[^>]*>", "\n", description or "", flags=re.I)
    text = html.unescape(re.sub(r"<[^>]*>", "", text))
    text = re.split(r"Here is the LIO description", text, flags=re.I)[0]
    return re.sub(r"\s+", " ", text).strip()


def build_html(doc, row, image_src, graph_href="graph.jsonld", inline_graph=False):
    """The HTML canvas. Every element of the body has an id; the regions' ids are the graph's."""
    e = lambda s: html.escape(str(s), quote=True)
    title = first([row["title"], row["name"], row["image"]])
    alt = first([row["alt"], title])
    caption = caption_of(row["desc"])
    size = ""
    if doc["width"] > 0 and doc["height"] > 0:
        size = ' width="%d" height="%d"' % (doc["width"], doc["height"])
    unplaced = [r for r in doc["regions"] if r["shape"] is None]
    out = [
        "<!DOCTYPE html>",
        '<html lang="en">',
        "<head>",
        '  <meta charset="utf-8">',
        '  <meta name="viewport" content="width=device-width, initial-scale=1">',
        '  <meta name="id" content="%s">' % e(doc["page"]),
        '  <link rel="describedby" type="application/ld+json" href="%s" crossorigin>' % e(graph_href),
        "  <title>%s</title>" % e(title),
        '  <link rel="stylesheet" href="styles/regions.css">',
    ]
    if inline_graph:
        # JSON-LD must not close the script element; "<" is escaped in every string.
        out.append('  <script type="application/ld+json">%s</script>' % json.dumps(
            doc["graph"], ensure_ascii=False).replace("<", "\\u003c"))
    out += [
        "</head>",
        '<body id="body">',
        '  <main id="main">',
        '    <h1 id="title">%s</h1>' % e(title),
        '    <figure id="canvas">',
        '      <div id="stage">',
        '        <img id="image" src="%s"%s alt="%s">' % (e(image_src), size, e(alt)),
        "      </div>",
    ]
    if caption:
        out.append('      <figcaption id="caption">%s</figcaption>' % e(caption))
    out.append("    </figure>")
    if unplaced:
        out.append('    <ul id="regions-list">')
        for r in unplaced:
            text = r["label"] + (": " + ", ".join(r["shows"]) if r["shows"] else "")
            out.append('      <li id="%s">%s</li>' % (e(r["id"]), e(text)))
        out.append("    </ul>")
    if row["creator"] or row["date"] or row["rights"] or row["web"]:
        out.append('    <p id="credit">')
        if row["creator"]:
            out.append('      <span id="creator">%s</span>' % e(row["creator"]))
        if row["date"]:
            out.append('      <span id="date">%s</span>' % e(row["date"]))
        if row["rights"]:
            out.append('      <span id="rights">%s</span>' % e(row["rights"]))
        if row["web"]:
            out.append('      <a id="license" href="%s">%s</a>' % (e(row["web"]), e(row["web"])))
        out.append("    </p>")
    out += [
        "  </main>",
        '  <script id="regions-script" src="scripts/regions.js"></script>',
        "</body>",
        "</html>",
        "",
    ]
    return "\n".join(out)


# --------------------------------------------------------------------------
# Writing
# --------------------------------------------------------------------------

def write_document(out_dir, doc, row, image_bytes=None, image_name="", inline_graph=False):
    os.makedirs(os.path.join(out_dir, "scripts"), exist_ok=True)
    os.makedirs(os.path.join(out_dir, "styles"), exist_ok=True)
    image_src = first([row["content"], row["image"], row["thumb"]])
    if image_bytes is not None:
        os.makedirs(os.path.join(out_dir, "media"), exist_ok=True)
        with open(os.path.join(out_dir, "media", image_name), "wb") as f:
            f.write(image_bytes)
        image_src = "media/" + urllib.parse.quote(image_name)
    with open(os.path.join(out_dir, "graph.jsonld"), "w", encoding="utf-8") as f:
        json.dump(doc["graph"], f, indent=2, ensure_ascii=False)
        f.write("\n")
    with open(os.path.join(out_dir, "index.html"), "w", encoding="utf-8") as f:
        f.write(build_html(doc, row, image_src, inline_graph=inline_graph))
    shutil.copyfile(os.path.join(ASSETS, "regions.js"), os.path.join(out_dir, "scripts", "regions.js"))
    shutil.copyfile(os.path.join(ASSETS, "regions.css"), os.path.join(out_dir, "styles", "regions.css"))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Convert an ImageSnippets image and its triples to a CP/LD Linked Document.")
    parser.add_argument("url", help="address of the image, its .html page or its RDF page on imagesnippets.com")
    parser.add_argument("--out", help="output directory (default: USER-NAME in the current directory)")
    parser.add_argument("--endpoint", default=ENDPOINT, help="SPARQL endpoint of ImageSnippets (default: %(default)s)")
    parser.add_argument("--lang", default="en", help="language of Wikidata labels (default: %(default)s)")
    parser.add_argument("--no-wikidata", action="store_true", help="keep the labels of Wikidata entities as the store has them")
    parser.add_argument("--no-regions", action="store_true", help="do not read where the regions are from the RDF page")
    parser.add_argument("--no-download", action="store_true", help="do not copy the image: the page points at the original")
    parser.add_argument("--cafile", help="CA bundle to verify HTTPS with, for a network that inspects TLS (a proxy's root "
                                         "certificate); SSL_CERT_FILE does the same. Verification is never turned off.")
    parser.add_argument("--inline-graph", action="store_true",
                        help="also put the graph in index.html, so that the page works when opened as a file")
    args = parser.parse_args(argv)
    global CAFILE
    CAFILE = args.cafile

    graph = graph_iri_of(args.url)
    print("graph:", graph, file=sys.stderr)
    triples = fetch_triples(args.endpoint, graph)
    if not triples:
        sys.exit("no statements found in " + graph)
    row = summarise(triples, graph)
    if not row["image"]:
        sys.exit("no image found in " + graph)

    regions = {"width": 0, "height": 0, "shapes": {}}
    if not args.no_regions:
        try:
            regions = parse_regions(http_get(graph, "text/html"))
        except (urllib.error.URLError, OSError) as err:
            print("warning: regions not read from %s: %s" % (graph, err), file=sys.stderr)
    labels = {}
    if not args.no_wikidata:
        try:
            labels = wikidata_labels(wikidata_iris(triples), args.lang)
        except (urllib.error.URLError, OSError, ValueError, KeyError) as err:
            print("warning: Wikidata labels not read, the store's are kept: %s" % err, file=sys.stderr)

    doc = build_document(row, triples, regions, labels, args.lang)
    out_dir = args.out or "-".join(graph.rstrip("/").split("/")[-2:])

    image_bytes, image_name = None, ""
    source = first([row["content"], row["image"]])
    if not args.no_download and source:
        image_name = urllib.parse.unquote(urllib.parse.urlparse(source).path.rsplit("/", 1)[-1]) or "image.jpg"
        try:
            image_bytes = http_get(source, "image/*", binary=True)
        except (urllib.error.URLError, OSError) as err:
            print("warning: image not copied, the page points at the original: %s" % err, file=sys.stderr)
    write_document(out_dir, doc, row, image_bytes, image_name, args.inline_graph)
    placed = sum(1 for r in doc["regions"] if r["shape"])
    print("wrote %s (%d regions, %d placed)" % (out_dir, len(doc["regions"]), placed), file=sys.stderr)


if __name__ == "__main__":
    main()
