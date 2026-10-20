(function () {
  var link = document.querySelector('link[type="application/ld+json"]');
  var stage = document.getElementById('stage');
  var popup = document.createElement('div');
  popup.id = 'region-popup';
  popup.setAttribute('role', 'dialog');
  popup.hidden = true;
  var close = document.createElement('button');
  close.id = 'region-popup-close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '\u00d7';
  var body = document.createElement('div');
  body.id = 'region-popup-body';
  popup.appendChild(close);
  popup.appendChild(body);
  stage.appendChild(popup);

  var IMAGE_GRAPH = 'doc:image-graph';   // the named graph with the image, its regions and what they show
  var graph = null, context = {}, byId = {}, loading = null, hasImageGraph = false;
  var regionActions = null, relayout = null;   // set by the editor, when it is open
  function expand(id) {
    var i = id.indexOf(':');
    var ns = i > 0 && context[id.slice(0, i)];
    return typeof ns === 'string' && id.indexOf('://') !== i ? ns + id.slice(i + 1) : id;
  }
  // The graph: the JSON-LD blocks in the page when there are any (a viewer puts the linked graph there),
  // otherwise the linked file. That file cannot be fetched from a page that is not served over http.
  function load() {
    function add(doc) {
      context = doc['@context'] || {};
      // The nodes of the default graph and of the graph objects in it (the image graph): one lookup.
      (function walk(nodes) {
        (nodes || []).forEach(function (n) {
          if (n['@graph']) { if (n['@id'] && expand(n['@id']) === expand(IMAGE_GRAPH)) { hasImageGraph = true; } walk(n['@graph']); }
          if (Object.keys(n).some(function (k) { return k !== '@id' && k !== '@graph'; })) { byId[expand(n['@id'])] = n; }
        });
      })(doc['@graph']);
    }
    var inline = Array.prototype.map.call(document.querySelectorAll('script[type="application/ld+json"]'), function (s) {
      try { return JSON.parse(s.textContent); } catch (e) { return null; }
    }).filter(function (d) { return d && d['@graph']; });
    if (inline.length) { add(inline[0]); return Promise.resolve(); }
    loading = loading || fetch(link.href).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(add);
    return loading;
  }
  function list(v) { return v == null ? [] : [].concat(v); }
  function text(v) { return v && typeof v === 'object' ? v['@value'] : v; }
  function labelOf(iri) {
    var n = byId[iri], l = n && (n['rdfs:label'] || n['schema:name']);
    return l ? text(list(l)[0]) : null;
  }
  // The stacking order of overlapping regions. The first <area> in the map is the top-most, so the region with
  // the lowest schema:position goes first; a region without one is in the middle (100), polygons before rects.
  function positionOf(node) {
    var v = node && text(list(node['schema:position'])[0]);
    return v != null && v !== '' && !isNaN(+v) ? +v : 100;
  }
  function isUrl(v) { return /^https?:\/\/\S+$/.test(v); }
  function anchor(url, text) {
    var a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = text || url;
    return a;
  }
  // One term (dt, left column) with one dd (right column) per value.
  // A value is text, [label, iri] for a labelled IRI, or {text, href} for a named link; URLs become links.
  function row(dl, term, values) {
    var dt = document.createElement('dt');
    dt.textContent = term;
    dl.appendChild(dt);
    list(values).forEach(function (v) {
      var dd = document.createElement('dd');
      if (Array.isArray(v)) { dd.appendChild(document.createTextNode(v[0] + ' (')); dd.appendChild(anchor(v[1])); dd.appendChild(document.createTextNode(')')); }
      else if (v && v.href) dd.appendChild(anchor(v.href, v.text));
      else if (isUrl(v)) dd.appendChild(anchor(v));
      else dd.textContent = v;
      dl.appendChild(dd);
    });
  }
  function entry() {
    var dl = document.createElement('dl');
    body.appendChild(dl);
    return dl;
  }
  function show(areaId, x, y) {
    body.textContent = '';
    var region = byId[expand('doc:' + areaId)];
    var shown = region ? list(region['lio:shows']) : [];
    var regionLabel = (region && labelOf(expand('doc:' + areaId))) || areaId;
    var shows = { text: 'lio:shows', href: expand('lio:shows') };
    if (!shown.length) { var none = entry(); row(none, 'Region', regionLabel); row(none, 'Shows', 'nothing described'); }
    shown.forEach(function (s) {
      var iri = expand(s['@id']), node = byId[iri] || {}, dl = entry();
      row(dl, 'Region', [regionLabel, shows]);
      row(dl, 'Id', iri);
      var types = list(node['@type']).map(function (t) {
        var full = expand(t), l = labelOf(full);
        return l ? [l, full] : full;
      });
      row(dl, 'Type', types.length ? types : 'none given');
      row(dl, 'Label', labelOf(iri) || 'none given');
    });
    if (region && regionActions) body.appendChild(regionActions(areaId));
    place(x, y);
  }
  function place(x, y) {
    popup.hidden = false;
    var maxX = stage.clientWidth - popup.offsetWidth, maxY = stage.clientHeight - popup.offsetHeight;
    popup.style.left = Math.max(0, Math.min(x + 8, maxX)) + 'px';
    popup.style.top = Math.max(0, Math.min(y + 8, maxY)) + 'px';
  }
  var NS = 'http://www.w3.org/2000/svg';
  var img = document.getElementById('image');
  var overlay = document.createElementNS(NS, 'svg');
  overlay.id = 'region-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  stage.appendChild(overlay);
  var drawLayer = document.createElementNS(NS, 'svg');
  drawLayer.id = 'region-draw';
  drawLayer.setAttribute('aria-hidden', 'true');
  stage.appendChild(drawLayer);
  var areas = [], orig = [], map = null;

  // A selector as <area> terms: rect is l,t,r,b; poly is x1,y1,x2,y2,...; circle is cx,cy,r.
  function shapeOf(sel) {
    var v = sel && text(sel['rdf:value']), t = sel && list(sel['@type'])[0], m;
    if (!v) return null;
    if (t === 'oa:FragmentSelector') {
      m = /xywh=pixel:(\d+),(\d+),(\d+),(\d+)/.exec(v);
      return m && { shape: 'rect', coords: [+m[1], +m[2], +m[1] + +m[3], +m[2] + +m[4]] };
    }
    if (t === 'oa:SvgSelector') {
      var svg = new DOMParser().parseFromString(v, 'image/svg+xml'), el;
      if ((el = svg.querySelector('polygon'))) return { shape: 'poly', coords: el.getAttribute('points').trim().split(/[\s,]+/).map(Number) };
      if ((el = svg.querySelector('circle'))) return { shape: 'circle', coords: ['cx', 'cy', 'r'].map(function (k) { return +el.getAttribute(k); }) };
      if ((el = svg.querySelector('rect'))) {
        var x = +el.getAttribute('x'), y = +el.getAttribute('y');
        return { shape: 'rect', coords: [x, y, x + +el.getAttribute('width'), y + +el.getAttribute('height')] };
      }
    }
    return null;
  }
  function outline(s, c) {
    var el;
    if (s === 'circle') {
      el = document.createElementNS(NS, 'circle');
      el.setAttribute('cx', c[0]); el.setAttribute('cy', c[1]); el.setAttribute('r', c[2]);
    } else if (s === 'poly') {
      el = document.createElementNS(NS, 'polygon');
      el.setAttribute('points', c.join(' '));
    } else {
      el = document.createElementNS(NS, 'rect');
      el.setAttribute('x', c[0]); el.setAttribute('y', c[1]);
      el.setAttribute('width', c[2] - c[0]); el.setAttribute('height', c[3] - c[1]);
    }
    return el;
  }
  function scale() {
    var k = img.clientWidth / img.naturalWidth;
    // The overlay follows the image, not the stage: a page (or a viewer) can make the image narrower than its container.
    overlay.style.left = img.offsetLeft + 'px';
    overlay.style.top = img.offsetTop + 'px';
    overlay.style.width = img.clientWidth + 'px';
    overlay.style.height = img.clientHeight + 'px';
    overlay.setAttribute('viewBox', '0 0 ' + img.naturalWidth + ' ' + img.naturalHeight);
    [drawLayer].forEach(function (l) {
      l.style.left = overlay.style.left; l.style.top = overlay.style.top;
      l.style.width = overlay.style.width; l.style.height = overlay.style.height;
      l.setAttribute('viewBox', overlay.getAttribute('viewBox'));
    });
    if (relayout) relayout();
    areas.forEach(function (a, i) { a.coords = orig[i].map(function (c) { return Math.round(c * k); }).join(','); });
  }
  // A viewer that shows triples (the CP/LD viewer) tells which resource has the focus: highlight its region.
  function focusRegion(iri) {
    var base = expand('doc:'), id = iri && iri.indexOf(base) === 0 ? iri.slice(base.length) : null;
    Array.prototype.forEach.call(overlay.querySelectorAll('.focus'), function (o) { o.classList.remove('focus'); });
    var o = id && document.getElementById(id + '-outline');
    if (o) {
      o.classList.add('focus');
      if (o.scrollIntoView) o.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
  // One region: an <area> for the pointer and the keyboard, an outline for the eye. A region that is added
  // later goes first, so that it wins where it overlaps the others.
  function addArea(r, first) {
    var a = document.createElement('area'), shown = list(r.node['lio:shows'])[0];
    a.id = r.id; a.shape = r.shape; a.coords = r.coords.join(',');
    a.href = '#' + r.id;
    a.alt = (labelOf(expand('doc:' + r.id)) || r.id) + (shown ? ': ' + (labelOf(expand(shown['@id'])) || expand(shown['@id'])) : '');
    var o = outline(r.shape, r.coords);
    o.id = r.id + '-outline';
    overlay.appendChild(o);
    ['mouseover', 'focus'].forEach(function (e) { a.addEventListener(e, function () { o.classList.add('active'); }); });
    ['mouseout', 'blur'].forEach(function (e) { a.addEventListener(e, function () { o.classList.remove('active'); }); });
    a.addEventListener('click', function (e) {
      var box = stage.getBoundingClientRect();
      show(a.id, e.clientX - box.left, e.clientY - box.top);
      // A viewer that shows triples (the CP/LD viewer) moves its focus to the region. The click does not
      // go on to the figure around the image, because the viewer would move the focus to that instead.
      e.stopPropagation();
      document.dispatchEvent(new CustomEvent('cpld-select', { detail: { iri: expand('doc:') + a.id } }));
    });
    if (first) { map.insertBefore(a, map.firstChild); areas.unshift(a); orig.unshift(r.coords); }
    else { map.appendChild(a); areas.push(a); orig.push(r.coords); }
  }
  function build() {
    var docBase = expand('doc:'), page = byId[docBase.replace(/#$/, '')];
    var regions = list(page && page['schema:hasPart']).map(function (p) {
      var iri = expand(p['@id']), node = byId[iri] || {}, s = shapeOf(selectorIn(node));
      return s && { id: iri.slice(docBase.length), node: node, shape: s.shape, coords: s.coords };
    }).filter(Boolean);
    // The first area wins where areas overlap: by schema:position, then polygons (people, bridge) before rects (boxes behind them).
    regions.sort(function (a, b) {
      return (positionOf(a.node) - positionOf(b.node)) || ((a.shape === 'poly' ? 0 : 1) - (b.shape === 'poly' ? 0 : 1));
    });
    map = document.createElement('map');
    map.id = 'regions'; map.name = 'regions';
    regions.forEach(function (r) { addArea(r, false); });
    stage.appendChild(map);
    img.setAttribute('usemap', '#regions');
    scale();
    initEditor();
    document.addEventListener('cpld-focus', function (e) { focusRegion(e.detail.iri); });
    focusRegion(document.documentElement.dataset.cpldFocus);
    window.addEventListener('resize', scale);
    if (window.ResizeObserver) new ResizeObserver(scale).observe(img);
  }
  // ---- Adding regions ------------------------------------------------------------------------------
  // A region is drawn on the image (rectangle, polygon or freehand), and is given what it shows. It becomes
  // the same nodes as the regions in the graph: a region with an oa:hasSelector and lio:shows, with its annotation, and a new
  // instance when what it shows is not in the graph yet. The viewer gets them in the event cpld-add; the
  // button "Copy JSON-LD" gives them as text to put in the graph file.
  var KINDS = [
    { key: 'person', label: 'Person', type: 'schema:Person', labelProp: 'schema:name' },
    { key: 'animal', label: 'Dog', type: 'http://dbpedia.org/resource/Dog', labelProp: 'rdfs:label' },
    { key: 'boat', label: 'Boat', type: 'http://dbpedia.org/resource/Boat', labelProp: 'rdfs:label' },
    { key: 'rock', label: 'Rock', type: 'http://www.wikidata.org/entity/Q8063', labelProp: 'rdfs:label' },
    { key: 'thing', label: 'Something else', type: 'schema:Thing', labelProp: 'rdfs:label' }
  ];
  var HINTS = {
    rect: 'Drag over the image.',
    poly: 'Click the corners. Double click, Enter or a click on the first corner closes it. Backspace removes a corner.',
    free: 'Press and drag around the shape.'
  };
  var added = [];     // the nodes added in this session, for "Copy JSON-LD"
  var changed = [];   // the region nodes of the graph that got another shape
  var deleted = [];   // the regions of the graph that were deleted

  function el(tag, props, children) {
    var e = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) { if (k === 'text') e.textContent = props[k]; else e[k] = props[k]; });
    (children || []).forEach(function (c) { e.appendChild(c); });
    return e;
  }
  function svgEl(tag) { return document.createElementNS(NS, tag); }
  function pageIri() { return expand('doc:').replace(/#$/, ''); }

  function nextRegionId() {
    var base = expand('doc:'), top = -1;
    Object.keys(byId).forEach(function (k) {
      var m = k.indexOf(base) === 0 && /^region-([a-z])$/.exec(k.slice(base.length));
      if (m) top = Math.max(top, m[1].charCodeAt(0) - 97);
    });
    return top < 25 ? String.fromCharCode(98 + top) : String(Object.keys(byId).length);
  }
  function nextInstance(key) {
    var base = expand('doc:'), top = 0;
    Object.keys(byId).forEach(function (k) {
      var m = k.indexOf(base) === 0 && new RegExp('^' + key + '-instance-(\\d+)$').exec(k.slice(base.length));
      if (m) top = Math.max(top, +m[1]);
    });
    return top + 1;
  }
  function instances() {
    var base = expand('doc:'), out = [];
    Object.keys(byId).forEach(function (k) {
      if (k.indexOf(base) === 0 && /-instance-\d+$/.test(k)) out.push({ id: 'doc:' + k.slice(base.length), label: labelOf(k) || k.slice(base.length) });
    });
    return out;
  }

  // Simplify a freehand line (Ramer-Douglas-Peucker), so that it is a polygon with a handful of corners.
  function simplify(p, tol) {
    if (p.length < 3) return p;
    var a = p[0], b = p[p.length - 1], far = 0, at = 0;
    p.forEach(function (c, i) {
      var dx = b[0] - a[0], dy = b[1] - a[1], len = Math.sqrt(dx * dx + dy * dy) || 1;
      var d = Math.abs(dy * c[0] - dx * c[1] + b[0] * a[1] - b[1] * a[0]) / len;
      if (d > far) { far = d; at = i; }
    });
    if (far <= tol) return [a, b];
    return simplify(p.slice(0, at + 1), tol).slice(0, -1).concat(simplify(p.slice(at), tol));
  }

  function selectorOf(shape) {
    if (shape.shape === 'rect') {
      var c = shape.coords;
      return { '@type': 'oa:FragmentSelector', 'dcterms:conformsTo': { '@id': 'http://www.w3.org/TR/media-frags/' },
        'rdf:value': 'xywh=pixel:' + [c[0], c[1], c[2] - c[0], c[3] - c[1]].join(',') };
    }
    var pairs = [];
    for (var i = 0; i < shape.coords.length; i += 2) pairs.push(shape.coords[i] + ',' + shape.coords[i + 1]);
    return { '@type': 'oa:SvgSelector', 'rdf:value': '<svg xmlns="http://www.w3.org/2000/svg"><polygon points="' + pairs.join(' ') + '"/></svg>' };
  }

  // A region is the part of the canvas that is drawn (an oa:SpecificResource: the canvas is its source, with a
  // selector); lio:shows says what it shows. Its own node, doc:annotation-a for doc:region-a, is the Web
  // Annotation that identifies the region as what it shows: oa:hasTarget the region, oa:hasBody the entity.
  // Earlier shapes (a selector, or an oa:hasTarget with the selector, on a region that is the annotation too)
  // are read as well, and become this shape when the region is changed.
  var CANVAS = 'doc:canvas';
  function selectorIn(node) {
    var t = node && list(node['oa:hasTarget'])[0];
    return (node && list(node['oa:hasSelector'])[0]) || (t && list(t['oa:hasSelector'])[0]);
  }
  function annotationId(regionId) { return regionId.replace(/(^|[#:])region-/, '$1annotation-'); }
  function annotationOf(region) {
    var body = list(region['lio:shows']).map(function (s) { return { '@id': s['@id'] }; });
    return { '@id': annotationId(region['@id']), '@type': 'oa:Annotation', 'oa:motivatedBy': { '@id': 'oa:identifying' },
      'oa:hasTarget': { '@id': region['@id'] }, 'oa:hasBody': body.length === 1 ? body[0] : body };
  }
  // Brings a region of an earlier shape to this one; gives the annotation nodes that it did not have.
  function upgrade(region) {
    var sel = selectorIn(region), extra = [];
    if (!sel) return extra;
    var type = list(region['@type']).filter(function (t) { return t !== 'oa:Annotation'; });
    if (type.indexOf('oa:SpecificResource') < 0) type.push('oa:SpecificResource');
    region['@type'] = type.length === 1 ? type[0] : type;
    region['oa:hasSource'] = { '@id': CANVAS };
    region['oa:hasSelector'] = sel;
    delete region['oa:hasTarget']; delete region['oa:motivation']; delete region['oa:hasBody'];
    if (!byId[expand(annotationId(region['@id']))]) {
      var a = annotationOf(region);
      byId[expand(a['@id'])] = a;
      extra.push(a);
    }
    return extra;
  }

  // The annotations are in a collection (a collection with one page, after the Web Annotation model: the
  // class AnnotationCollection is as:OrderedCollection). Its total and its items are made again from the
  // annotations that there are; the nodes are returned so that they get saved and shown. A file whose
  // context has no prefix "as" keeps no collection.
  function syncCollection() {
    if (typeof context['as'] !== 'string') return [];
    var coll = byId[expand('doc:annotations')], page = byId[expand('doc:annotations-page')];
    if (!coll) coll = { '@id': 'doc:annotations', '@type': 'as:OrderedCollection', 'rdfs:label': 'Annotations of the image' };
    if (!page) page = { '@id': 'doc:annotations-page', '@type': 'as:OrderedCollectionPage', 'as:partOf': { '@id': 'doc:annotations' }, 'as:startIndex': 0 };
    var items = Object.keys(byId).filter(function (k) { return list(byId[k]['@type']).indexOf('oa:Annotation') >= 0; })
      .map(function (k) { return { '@id': byId[k]['@id'] }; });
    coll['as:totalItems'] = items.length;
    page['as:items'] = items;
    if (items.length) { coll['as:first'] = { '@id': page['@id'] }; coll['as:last'] = { '@id': page['@id'] }; }
    else { delete coll['as:first']; delete coll['as:last']; }
    byId[expand(coll['@id'])] = coll; byId[expand(page['@id'])] = page;
    return [coll, page];
  }
  function iris(nodes) { return nodes.map(function (n) { return expand(n['@id']); }); }

  // A position in front of (or behind) all the other regions.
  function edgePosition(except, front) {
    var page = byId[pageIri()], keys = [];
    list(page && page['schema:hasPart']).forEach(function (p) {
      var iri = expand(p['@id']), n = byId[iri];
      if (n && selectorIn(n) && iri !== except) keys.push(positionOf(n));
    });
    if (!keys.length) return 0;
    return front ? Math.min.apply(null, keys) - 1 : Math.max.apply(null, keys) + 1;
  }
  function createRegion(shape, choice) {
    var rid = nextRegionId(), nodes = [], shownId;
    if (choice.existing) shownId = choice.existing;
    else {
      var kind = KINDS[choice.kind], n = nextInstance(kind.key), inst = { '@id': 'doc:' + kind.key + '-instance-' + n, '@type': kind.type };
      inst[kind.labelProp] = choice.label || 'Unidentified ' + kind.label + ' ' + n;
      shownId = inst['@id'];
      nodes.push(inst);
    }
    var region = { '@id': 'doc:region-' + rid, '@type': 'oa:SpecificResource', 'rdfs:label': 'Region ' + rid.toUpperCase(),
      'oa:hasSource': { '@id': CANVAS }, 'oa:hasSelector': selectorOf(shape), 'lio:shows': { '@id': shownId }, 'schema:position': edgePosition(null, true) };
    nodes.push(region, annotationOf(region));
    var page = byId[pageIri()];
    if (page) page['schema:hasPart'] = list(page['schema:hasPart']).concat([{ '@id': region['@id'] }]);
    nodes.forEach(function (n) { byId[expand(n['@id'])] = n; });
    addArea({ id: 'region-' + rid, node: region, shape: shape.shape, coords: shape.coords }, true);
    scale();
    added = added.concat(nodes);
    var coll = syncCollection();
    coll.forEach(function (n) { if (added.indexOf(n) < 0 && changed.indexOf(n) < 0) changed.push(n); });
    if (coll.length) document.dispatchEvent(new CustomEvent('cpld-remove', { detail: { iris: iris(coll) } }));
    // What the viewer needs: the new nodes, and the page that has the region as a part.
    var detail = { context: context, focus: expand('doc:') + 'region-' + rid,
      nodes: nodes.concat(coll, [{ '@id': pageIri(), 'schema:hasPart': [{ '@id': region['@id'] }] }]) };
    document.dispatchEvent(new CustomEvent('cpld-add', { detail: detail }));
    focusRegion(detail.focus);
    return rid;
  }

  function initEditor() {
    var tool = null, pts = [], cursor = null, dragging = false, preview = null, pending = null;
    var hint = el('span', { id: 'region-hint' });
    var tools = el('div', { id: 'region-tools' });
    var toggle = el('button', { type: 'button', id: 'region-edit', text: '+ Region', title: 'Draw a new region on the image' });
    var buttons = {};
    [['rect', 'Rectangle'], ['poly', 'Polygon'], ['free', 'Freehand']].forEach(function (t) {
      buttons[t[0]] = el('button', { type: 'button', text: t[1], hidden: true });
      buttons[t[0]].addEventListener('click', function () { tool === t[0] ? stop() : start(t[0]); });
      tools.appendChild(buttons[t[0]]);
    });
    var copy = el('button', { type: 'button', text: 'Copy JSON-LD', hidden: true, title: 'The regions added in this session, as JSON-LD for the graph file' });
    // Saving in the graph file is something the viewer offers (and the user allows in the settings of the extension).
    var save = el('button', { type: 'button', text: 'Save to file', hidden: true, title: 'Save the regions in the JSON-LD file of this document (asks first, keeps a .bak)' });
    var saveTimer = null;
    var exported = el('textarea', { id: 'region-export', hidden: true, readOnly: true, rows: 8 });
    tools.insertBefore(toggle, tools.firstChild);
    tools.appendChild(copy); tools.appendChild(save); tools.appendChild(hint); tools.appendChild(exported);
    // The buttons for the changes of this session show when the tools are open and there is something to give.
    function sync() {
      var any = added.length || changed.length || deleted.length, open = !buttons.rect.hidden;
      copy.hidden = !(open && any);
      save.hidden = !(open && any && document.documentElement.dataset.cpldCanSave);
    }
    stage.appendChild(tools);
    // A click on the tools is not a click on the figure around the image (the viewer would focus that).
    tools.addEventListener('click', function (e) { e.stopPropagation(); });

    toggle.addEventListener('click', function () {
      var open = !buttons.rect.hidden;
      if (open) { stop(); endEdit(false); }
      regionActions = open ? null : actionsOf;
      Object.keys(buttons).forEach(function (k) { buttons[k].hidden = open; });
      sync();
      exported.hidden = true;
      toggle.classList.toggle('on', !open);
    });
    copy.addEventListener('click', function () {
      var page = { '@id': pageIri(), 'schema:hasPart': added.filter(function (n) { return selectorIn(n); }).map(function (n) { return { '@id': n['@id'] }; }) };
      var nodes = added.concat(changed);
      // A graph file with an image graph gets the nodes in that graph; the page node stays in the default graph.
      var text = JSON.stringify({ '@context': context, '@graph': hasImageGraph ? [page, { '@id': IMAGE_GRAPH, '@graph': nodes }] : nodes.concat([page]) }, null, 2);
      var done = function () { hint.textContent = 'Copied. Merge the nodes into the graph file.' + (deleted.length ? ' Remove from it: ' + deleted.join(', ') + '.' : ''); };
      var fallback = function () { exported.value = text; exported.hidden = false; exported.select(); hint.textContent = 'Copy the text (Ctrl/Cmd+C).' + (deleted.length ? ' Remove from the graph file: ' + deleted.join(', ') + '.' : ''); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
    });

    function at(e) {
      var r = img.getBoundingClientRect(), k = img.naturalWidth / r.width;
      return [Math.max(0, Math.min(img.naturalWidth, Math.round((e.clientX - r.left) * k))), Math.max(0, Math.min(img.naturalHeight, Math.round((e.clientY - r.top) * k)))];
    }
    function screenDistance(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]) * img.clientWidth / img.naturalWidth; }
    function start(t) {
      stop();
      tool = t; pts = []; cursor = null;
      drawLayer.classList.add('drawing');
      Object.keys(buttons).forEach(function (k) { buttons[k].classList.toggle('on', k === t); });
      hint.textContent = HINTS[t];
    }
    function stop() {
      tool = null; pts = []; cursor = null; dragging = false; pending = null;
      drawLayer.classList.remove('drawing');
      if (preview) { preview.remove(); preview = null; }
      form.hidden = true;
      Object.keys(buttons).forEach(function (k) { buttons[k].classList.remove('on'); });
      hint.textContent = '';
    }
    function draw() {
      var all = tool === 'poly' && cursor ? pts.concat([cursor]) : pts;
      if (!all.length) return;
      if (!preview || preview.tagName !== (tool === 'rect' ? 'rect' : 'polygon')) {
        if (preview) preview.remove();
        preview = svgEl(tool === 'rect' ? 'rect' : 'polygon');
        drawLayer.appendChild(preview);
      }
      if (tool === 'rect') {
        var a = pts[0], b = pts[1] || a;
        preview.setAttribute('x', Math.min(a[0], b[0])); preview.setAttribute('y', Math.min(a[1], b[1]));
        preview.setAttribute('width', Math.abs(a[0] - b[0])); preview.setAttribute('height', Math.abs(a[1] - b[1]));
      } else preview.setAttribute('points', all.map(function (p) { return p.join(','); }).join(' '));
    }
    function finish(shape) {
      if (!shape) { pts = []; if (preview) { preview.remove(); preview = null; } return; }
      pending = shape;
      drawLayer.classList.remove('drawing');
      hint.textContent = '';
      openForm();
    }
    function finishPolygon() {
      if (pts.length < 3) return;
      finish({ shape: 'poly', coords: [].concat.apply([], pts) });
    }

    drawLayer.addEventListener('click', function (e) { e.stopPropagation(); });
    drawLayer.addEventListener('pointerdown', function (e) {
      if (!tool || pending) return;
      e.preventDefault(); e.stopPropagation();
      var p = at(e);
      if (tool === 'poly') {
        if (pts.length >= 3 && screenDistance(p, pts[0]) < 8) return finishPolygon();
        pts.push(p); draw();
      } else {
        pts = tool === 'rect' ? [p, p] : [p];
        dragging = true;
        drawLayer.setPointerCapture(e.pointerId);
        draw();
      }
    });
    drawLayer.addEventListener('pointermove', function (e) {
      if (!tool || pending) return;
      var p = at(e);
      if (tool === 'poly') { cursor = p; draw(); }
      else if (dragging) {
        if (tool === 'rect') pts[1] = p; else pts.push(p);
        draw();
      }
    });
    drawLayer.addEventListener('pointerup', function () {
      if (!dragging) return;
      dragging = false;
      if (tool === 'rect') {
        var l = Math.min(pts[0][0], pts[1][0]), t = Math.min(pts[0][1], pts[1][1]), r = Math.max(pts[0][0], pts[1][0]), b = Math.max(pts[0][1], pts[1][1]);
        finish(r - l >= 4 && b - t >= 4 ? { shape: 'rect', coords: [l, t, r, b] } : null);
      } else {
        var s = simplify(pts, 2);
        finish(s.length >= 3 ? { shape: 'poly', coords: [].concat.apply([], s) } : null);
      }
    });
    drawLayer.addEventListener('dblclick', function (e) {
      if (tool !== 'poly' || pending) return;
      e.stopPropagation();
      pts.pop();   // the second click of the double click added the same corner again
      finishPolygon();
    });
    document.addEventListener('keydown', function (e) {
      if (editState && e.key === 'Escape') return endEdit(false);
      if (!tool) return;
      if (e.key === 'Escape') stop();
      else if (tool === 'poly' && !pending && e.key === 'Enter') finishPolygon();
      else if (tool === 'poly' && !pending && e.key === 'Backspace') { e.preventDefault(); pts.pop(); draw(); }
    });


    // ---- Deleting and reshaping a region (the popup of a region has the buttons while the tools are open) ----
    var editState = null;
    var doneBtn = el('button', { type: 'button', text: 'Done', hidden: true });
    var cancelBtn = el('button', { type: 'button', text: 'Cancel', hidden: true });
    tools.insertBefore(cancelBtn, hint); tools.insertBefore(doneBtn, cancelBtn);
    doneBtn.addEventListener('click', function () { endEdit(true); });
    cancelBtn.addEventListener('click', function () { endEdit(false); });

    // Tell the viewer that a region has changed: it takes the old one out of its graph and gets the new one.
    function publish(node, iri) {
      var extra = upgrade(node);
      if (extra.length) extra = extra.concat(syncCollection());
      if (added.indexOf(node) < 0 && changed.indexOf(node) < 0) changed.push(node);
      // An annotation that the file does not have yet is new; the collection is a node that changes.
      extra.forEach(function (n) {
        if (added.indexOf(n) >= 0 || changed.indexOf(n) >= 0) return;
        if (n['@type'] === 'oa:Annotation') added.push(n); else changed.push(n);
      });
      sync();
      document.dispatchEvent(new CustomEvent('cpld-remove', { detail: { iris: [iri].concat(iris(extra.filter(function (n) { return byId[expand(n['@id'])] && n['@type'] !== 'oa:Annotation'; }))) } }));
      document.dispatchEvent(new CustomEvent('cpld-add', { detail: { context: context, focus: iri,
        nodes: [node].concat(extra, [{ '@id': pageIri(), 'schema:hasPart': [{ '@id': iri }] }]) } }));
      focusRegion(iri);
    }
    // To the front or to the back: the position in the map, and schema:position, so that it stays that way.
    function moveRegion(id, front) {
      var iri = expand('doc:') + id, node = byId[iri], i = areas.findIndex(function (a) { return a.id === id; });
      if (!node || i < 0) return;
      node['schema:position'] = edgePosition(iri, front);
      var a = areas.splice(i, 1)[0], o = orig.splice(i, 1)[0];
      if (front) { map.insertBefore(a, map.firstChild); areas.unshift(a); orig.unshift(o); }
      else { map.appendChild(a); areas.push(a); orig.push(o); }
      hint.textContent = (labelOf(iri) || id) + ' is ' + (front ? 'in front of' : 'behind') + ' the other regions.';
      publish(node, iri);
    }
    function actionsOf(id) {
      var wrap = el('div', { className: 'region-actions' });
      var front = el('button', { type: 'button', text: 'Move to front' });
      var back = el('button', { type: 'button', text: 'Move to back' });
      front.addEventListener('click', function (e) { e.stopPropagation(); popup.hidden = true; moveRegion(id, true); });
      back.addEventListener('click', function (e) { e.stopPropagation(); popup.hidden = true; moveRegion(id, false); });
      wrap.appendChild(front); wrap.appendChild(back);
      var edit = el('button', { type: 'button', text: 'Edit shape' });
      var del = el('button', { type: 'button', text: 'Delete' });
      edit.addEventListener('click', function (e) { e.stopPropagation(); popup.hidden = true; startEdit(id); });
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        if (del.dataset.sure) { popup.hidden = true; removeRegion(id); }
        else { del.dataset.sure = '1'; del.textContent = 'Really delete?'; }
      });
      wrap.appendChild(edit); wrap.appendChild(del);
      return wrap;
    }
    function shownBySomeRegion(iri) {
      var page = byId[pageIri()];
      return list(page && page['schema:hasPart']).some(function (p) {
        var n = byId[expand(p['@id'])];
        return n && list(n['lio:shows']).some(function (s) { return expand(s['@id']) === iri; });
      });
    }
    function removeRegion(id) {
      var iri = expand('doc:') + id, node = byId[iri], gone = [iri], i = areas.findIndex(function (a) { return a.id === id; });
      if (i >= 0) { areas[i].remove(); areas.splice(i, 1); orig.splice(i, 1); }
      var o = document.getElementById(id + '-outline');
      if (o) o.remove();
      var page = byId[pageIri()];
      if (page) page['schema:hasPart'] = list(page['schema:hasPart']).filter(function (p) { return expand(p['@id']) !== iri; });
      delete byId[iri];
      // What this session created for the region goes with it, unless another region shows it as well.
      list(node && node['lio:shows']).forEach(function (s) {
        var si = expand(s['@id']), n = byId[si];
        if (n && added.indexOf(n) >= 0 && !shownBySomeRegion(si)) { gone.push(si); delete byId[si]; added = added.filter(function (x) { return x !== n; }); }
      });
      if (added.indexOf(node) >= 0) added = added.filter(function (x) { return x !== node; });
      else deleted.push(id);
      changed = changed.filter(function (x) { return x !== node; });
      // The annotation of the region goes with it.
      var aid = annotationId(id), aIri = expand('doc:') + aid, an = byId[aIri];
      if (an) {
        gone.push(aIri); delete byId[aIri];
        if (added.indexOf(an) >= 0) added = added.filter(function (x) { return x !== an; });
        else deleted.push(aid);
        changed = changed.filter(function (x) { return x !== an; });
      }
      var coll = syncCollection();
      coll.forEach(function (n) { if (added.indexOf(n) < 0 && changed.indexOf(n) < 0) changed.push(n); });
      focusRegion(null);
      sync();
      document.dispatchEvent(new CustomEvent('cpld-remove', { detail: { iris: gone.concat(iris(coll)), focus: pageIri() } }));
      if (coll.length) document.dispatchEvent(new CustomEvent('cpld-add', { detail: { context: context, focus: pageIri(), nodes: coll } }));
    }

    function startEdit(id) {
      stop(); endEdit(false);
      var i = areas.findIndex(function (a) { return a.id === id; });
      if (i < 0) return;
      if (areas[i].shape !== 'rect' && areas[i].shape !== 'poly') { hint.textContent = 'This shape cannot be edited here (only rectangles and polygons).'; return; }
      var shape = areas[i].shape, coords = orig[i].slice();
      var shapeEl = svgEl(shape === 'rect' ? 'rect' : 'polygon'), handles = [], bounds = function () {
        var xs = [], ys = [];
        for (var j = 0; j < coords.length; j += 2) { xs.push(coords[j]); ys.push(coords[j + 1]); }
        return { l: Math.min.apply(null, xs), t: Math.min.apply(null, ys), r: Math.max.apply(null, xs), b: Math.max.apply(null, ys) };
      };
      // A rectangle is l,t,r,b; its corners are 0 top left, 1 top right, 2 bottom right, 3 bottom left.
      function points() {
        return shape === 'rect' ? [[coords[0], coords[1]], [coords[2], coords[1]], [coords[2], coords[3]], [coords[0], coords[3]]]
          : coords.reduce(function (acc, c, j) { if (j % 2 === 0) acc.push([c, coords[j + 1]]); return acc; }, []);
      }
      var outlineEl = document.getElementById(id + '-outline');
      if (outlineEl) outlineEl.style.visibility = 'hidden';
      function layout() {
        var k = img.clientWidth / img.naturalWidth, p = points();
        if (shape === 'rect') {
          shapeEl.setAttribute('x', coords[0]); shapeEl.setAttribute('y', coords[1]);
          shapeEl.setAttribute('width', coords[2] - coords[0]); shapeEl.setAttribute('height', coords[3] - coords[1]);
        } else shapeEl.setAttribute('points', coords.join(' '));
        handles.forEach(function (h, j) { h.setAttribute('cx', p[j][0]); h.setAttribute('cy', p[j][1]); h.setAttribute('r', 5 / k); });
      }
      function drag(e, how) {
        e.preventDefault(); e.stopPropagation();
        var target = e.currentTarget, from = at(e), start = coords.slice(), box = bounds();
        target.setPointerCapture(e.pointerId);
        function move(ev) {
          var p = at(ev);
          if (how === 'move') {
            var dx = Math.max(-box.l, Math.min(img.naturalWidth - box.r, p[0] - from[0])), dy = Math.max(-box.t, Math.min(img.naturalHeight - box.b, p[1] - from[1]));
            coords = start.map(function (c, j) { return c + (j % 2 ? dy : dx); });
          } else if (shape === 'rect') {
            var opp = points()[(how + 2) % 4], l = Math.min(opp[0], p[0]), t = Math.min(opp[1], p[1]), r = Math.max(opp[0], p[0]), b = Math.max(opp[1], p[1]);
            if (r - l >= 4 && b - t >= 4) coords = [l, t, r, b];
          } else { coords[2 * how] = p[0]; coords[2 * how + 1] = p[1]; }
          layout();
        }
        function up() { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); }
        target.addEventListener('pointermove', move); target.addEventListener('pointerup', up);
      }
      shapeEl.style.pointerEvents = 'all'; shapeEl.style.cursor = 'move';
      shapeEl.addEventListener('pointerdown', function (e) { drag(e, 'move'); });
      drawLayer.appendChild(shapeEl);
      points().forEach(function (_, j) {
        var h = svgEl('circle');
        h.setAttribute('class', 'handle'); h.style.pointerEvents = 'all'; h.style.cursor = 'pointer';
        h.addEventListener('pointerdown', function (e) { drag(e, j); });
        drawLayer.appendChild(h); handles.push(h);
      });
      drawLayer.classList.add('editing');
      editState = { id: id, shape: shape, get coords() { return coords; }, outlineEl: outlineEl };
      relayout = layout; layout();
      doneBtn.hidden = false; cancelBtn.hidden = false;
      hint.textContent = 'Drag a corner to reshape, drag inside to move.';
    }
    function endEdit(keep) {
      if (!editState) return;
      var st = editState, id = st.id, iri = expand('doc:') + id;
      editState = null; relayout = null;
      drawLayer.textContent = ''; drawLayer.classList.remove('editing');
      doneBtn.hidden = true; cancelBtn.hidden = true; hint.textContent = '';
      if (st.outlineEl) st.outlineEl.style.visibility = '';
      if (!keep) return;
      var node = byId[iri], i = areas.findIndex(function (a) { return a.id === id; }), coords = st.coords.map(Math.round);
      if (!node || i < 0) return;
      node['oa:hasSelector'] = selectorOf({ shape: st.shape, coords: coords });
      orig[i] = coords;
      var fresh = outline(st.shape, coords);
      fresh.id = id + '-outline';
      st.outlineEl.parentNode.replaceChild(fresh, st.outlineEl);
      scale();
      publish(node, iri);
    }


    save.addEventListener('click', function () {
      var detail = {
        nodes: added.concat(changed),
        pageId: pageIri(),
        addParts: added.filter(function (n) { return selectorIn(n); }).map(function (n) { return n['@id']; }),
        removeIds: deleted.map(function (id) { return 'doc:' + id; })
      };
      if (hasImageGraph) { detail.graphId = IMAGE_GRAPH; }
      save.disabled = true;
      hint.textContent = 'Saving...';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(function () { save.disabled = false; hint.textContent = 'No answer from the viewer. Nothing is saved.'; }, 180000);
      document.dispatchEvent(new CustomEvent('cpld-save', { detail: detail }));
    });
    // The answer of the viewer (the extension decides: the setting, the file, and the question to the user).
    document.addEventListener('cpld-saved', function (e) {
      var r = e.detail || {};
      clearTimeout(saveTimer);
      save.disabled = false;
      if (r.ok) {
        added = []; changed = []; deleted = [];
        hint.textContent = 'Saved in ' + r.file + ': ' + r.summary + '. The old version is kept as ' + r.file + '.bak.';
      } else hint.textContent = r.cancelled ? 'Not saved.' : 'Not saved: ' + r.error + '.';
      sync();
    });

    // What does the new region show?
    var form = el('div', { id: 'region-form', hidden: true });
    var shows = el('select', { id: 'region-shows' });
    var kind = el('select', { id: 'region-kind' }, KINDS.map(function (k, i) { return el('option', { value: i, text: k.label }); }));
    var name = el('input', { id: 'region-name', type: 'text', placeholder: 'Label (optional)' });
    var fresh = el('div', { id: 'region-new' }, [kind, name]);
    var add = el('button', { type: 'button', text: 'Add region' });
    var cancel = el('button', { type: 'button', text: 'Cancel' });
    form.appendChild(el('strong', { text: 'New region' }));
    form.appendChild(el('label', { text: 'Shows ' }, [shows]));
    form.appendChild(fresh);
    form.appendChild(el('div', {}, [add, cancel]));
    stage.appendChild(form);
    form.addEventListener('click', function (e) { e.stopPropagation(); });
    function openForm() {
      shows.textContent = '';
      shows.appendChild(el('option', { value: '', text: 'A new thing' }));
      instances().forEach(function (i) { shows.appendChild(el('option', { value: i.id, text: i.label })); });
      shows.value = ''; name.value = '';
      fresh.hidden = false;
      form.hidden = false;
    }
    shows.addEventListener('change', function () { fresh.hidden = shows.value !== ''; });
    cancel.addEventListener('click', stop);
    add.addEventListener('click', function () {
      var shape = pending, rid = createRegion(shape, shows.value ? { existing: shows.value } : { kind: +kind.value, label: name.value.trim() });
      stop();
      sync();
      var c = shape.coords, k = img.clientWidth / img.naturalWidth, box = stage.getBoundingClientRect(), r = img.getBoundingClientRect();
      var x = shape.shape === 'rect' ? (c[0] + c[2]) / 2 : c[0], y = shape.shape === 'rect' ? (c[1] + c[3]) / 2 : c[1];
      show('region-' + rid, r.left - box.left + x * k, r.top - box.top + y * k);
    });
  }
  var imageReady = new Promise(function (resolve) { img.complete ? resolve() : img.addEventListener('load', resolve); });
  Promise.all([load(), imageReady]).then(build, function (err) {
    body.textContent = '';
    row(entry(), 'Error', 'Could not load ' + link.getAttribute('href') + ' (' + err.message + '). Serve this folder over http, not file://.');
    place(0, 0);
  });
  close.addEventListener('click', function () { popup.hidden = true; });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') popup.hidden = true; });
  document.addEventListener('click', function (e) {
    if (!popup.contains(e.target) && e.target.tagName !== 'AREA') popup.hidden = true;
  });
})();
