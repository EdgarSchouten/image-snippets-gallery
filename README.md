# ImageSnippets Gallery

A WordPress block that displays a responsive, **server-rendered** gallery of images from [ImageSnippets](https://imagesnippets.com), with embedded provenance metadata (schema.org JSON-LD) for SEO and discoverability.

It is an independent, modernized fork of [IS Gallery](https://wordpress.org/plugins/is-gallery/) by Henry Sautter (GPL-2.0). With thanks to the original author.

## Why a fork?

The original renders entirely in the browser, so search engines, social scrapers, and AI crawlers see an empty `<div>`. This fork **mirrors each gallery into WordPress** — one hidden post per image, holding the image's whole named graph — and renders from that copy on the server, emitting real HTML plus JSON-LD. The images *and their provenance* are present in the page source, no page view ever waits on the endpoint, and WordPress site search finds the images.

## Features

- **Server-side rendering from a local mirror.** Galleries are re-fetched on a per-block interval (`isgal_cache_ttl` filter), diffed, and the affected pages are cleared from any page cache when something changed. WP-CLI: `wp isgal sync|status|prune|reindex|reset`.
- **Site search** finds mirrored images by title, description, and depicted entities, linking to the gallery page.
- **Open as a Linked Document.** Double-click a lightbox image (or use the link beside the flip button, or press L) to open it as a CP/LD document: an HTML canvas with its regions as an image map, and the image's graph as JSON-LD, with the labels of Wikidata entities read from Wikidata itself. See `examples/cpld/` for a sample.
  The same document can be made for any ImageSnippets image without WordPress, with a standard-library Python script: `python3 scripts/imagesnippets_to_cpld.py https://imagesnippets.com/imgtag/images/USER/NAME.jpg --out DIR` writes `index.html`, `graph.jsonld`, a copy of the image in `media/`, and `scripts/regions.js` and `styles/regions.css` (which draw the regions from the graph and show what each one shows). It reads the triples from the ImageSnippets SPARQL endpoint, the regions from the image's RDF page, and the labels of Wikidata entities from Wikidata (`--no-wikidata` keeps the store's). On a network that inspects TLS, give the proxy's root certificate with `--cafile` or `SSL_CERT_FILE`; certificate checking is never turned off. Open the result over http (`python3 -m http.server`), or use `--inline-graph` to have it work as a file. Tests: `python3 -m unittest discover -s scripts/tests`.
  **Model of a Linked Document.** Regions belong to the page, not to an image:
  - A region's id is unique within the page (the `doc:` namespace, the page's IRI plus `#`), never only within an image. With more than one image on a `schema:WebPage`, `doc:region-a` can exist once, whichever image it is drawn on. The converter and `regions.js` make ids that way (`regions.js` picks the next free letter across the whole page).
  - The canvas is a part of the page, as is every region (CP/LD does not nest parts). The document has one image, `doc:canvas`; a page with several images would have one canvas per image (for example `doc:canvas-1`, `doc:canvas-2`).
  - A region is a part of the canvas: an `oa:SpecificResource` (`doc:region-a`) whose `oa:hasSource` is the canvas, with an `oa:hasSelector` (a media-fragment rectangle or an SVG shape), and `lio:shows` for what it shows. The Web Annotation that says so is a node of its own, `doc:annotation-a`: `oa:motivatedBy oa:identifying`, `oa:hasTarget` the region, `oa:hasBody` the entity. Annotations are not parts of the page.
  - The annotations are in a collection, `doc:annotations`, with one page, `doc:annotations-page`, after the Web Annotation model. There is no `oa:AnnotationCollection`: the model's `AnnotationCollection` and `AnnotationPage` are `as:OrderedCollection` and `as:OrderedCollectionPage` of ActivityStreams, so the context has the prefix `as`. The items are repeated `as:items` values, not an RDF list as the model's JSON-LD context would make them, so that the Graph tab shows no list cells; `regions.js` keeps `as:totalItems` and the items right when a region is added or deleted. All of it is in the image's named graph `doc:image-graph`.
  - `regions.js` also reads the older shapes (a selector directly on the region, which was also the annotation) and writes this shape when a region is changed. Not yet built: the converter and `regions.js` handle one image, always `doc:canvas`.
  - Two rectangles are never the same thing because they look alike. Two regions, on two near-identical images, that show the same entity are related through that entity: both point with `lio:shows` to the same instance node (or to instances that are linked with `schema:sameAs`, or that have the same Wikidata concept). A region is a view of an entity, not an identity.
- **Rich JSON-LD**: an `ImageGallery` of `ImageObject`s, each linked to its canonical entity (`about`) and scene location (`contentLocation`) from the ImageSnippets graph.
- **Smart text fallbacks**: alt text resolves `alt → description → title`; an optional filename fallback; an editor-only warning when images lack titles/alt text.
- **Layouts**: grid, masonry, justified; small/medium/large thumbnails.
- **Configurable crop ratio** (square, 4:3, 3:2, 16:9) to eliminate layout shift.
- Sort by date or title, ascending or descending, or arrange the images by hand (Tools → ImageSnippets → Arrange, then Sort by → Manual on the block); limit the image count.
- Optional filter by ImageSnippets user; overridable SPARQL endpoint.

## Install (for testing)

Download the latest `image-snippets-gallery-*.zip` from the [Releases](../../releases) page, then in WordPress go to **Plugins → Add New → Upload Plugin**, choose the zip, and activate. Add the **ImageSnippets Gallery** block and pick a gallery from the list (galleries outside the main Imagesnippets datasets appear as `owner/gallery`, e.g. `ejw_galleries/railroad_project`; a name not on the list can still be typed).

## Build from source

Requires Node 18+.

```bash
npm install
npm run build      # outputs to build/
npm run start      # watch mode for development
```

For a quick local WordPress with the plugin loaded (no Docker/PHP needed):

```bash
npx @wp-now/wp-now@latest start
```

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
