<?php
/**
 * An image as a Linked Document (CP/LD): an HTML canvas and a JSON-LD graph.
 *
 * The canvas is the image with an image map (<area> per region); the graph is
 * the image's own named graph, as mirrored, plus the canvas and its regions.
 * Element ids in the HTML are the fragments of the node ids in the graph
 * (doc:image, doc:canvas, doc:region-a), so each describes the other.
 *
 * Served from the front end at /?isgal_ld={md5 of the graph IRI}, the same
 * hash the lightbox already uses for an image's anchor, and with &format=jsonld
 * for the graph. Nothing here is stored: the document is built from the row.
 *
 * The one thing the mirror does not hold is where the regions are. ImageSnippets
 * keeps that only in the HTML of the image's RDF page (an <svg> of shapes), so it
 * is read from there, once a day, and the document is built without areas when
 * that page cannot be had.
 *
 * @package ImageSnippetsGallery
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

const ISGAL_LD_QUERY_VAR = 'isgal_ld';

/**
 * Where an image's Linked Document is served.
 *
 * @param string $page   Named-graph IRI of the image (the row's 'page').
 * @param string $format '' for the HTML canvas, 'jsonld' for the graph.
 * @return string URL.
 */
function isgal_ld_url( $page, $format = '' ) {
	$args = array( ISGAL_LD_QUERY_VAR => md5( (string) $page ) );
	if ( 'jsonld' === $format ) {
		$args['format'] = 'jsonld';
	}
	return add_query_arg( $args, home_url( '/' ) );
}

/**
 * The value of one attribute in the text of a start tag.
 *
 * "width" does not match inside "stroke-width".
 *
 * @param string $attrs Attribute text.
 * @param string $name  Attribute name.
 * @return string Decoded value, or ''.
 */
function isgal_ld_attr( $attrs, $name ) {
	if ( preg_match( '/(?<![\w:-])' . preg_quote( $name, '/' ) . '\s*=\s*(["\'])(.*?)\1/is', $attrs, $m ) ) {
		return html_entity_decode( $m[2], ENT_QUOTES );
	}
	return '';
}

/**
 * The numbers in a string, as integers.
 *
 * @param string $text Numbers separated by commas and/or whitespace.
 * @return int[]|null Null when anything else is in there.
 */
function isgal_ld_numbers( $text ) {
	$parts = preg_split( '/[\s,]+/', trim( (string) $text ), -1, PREG_SPLIT_NO_EMPTY );
	foreach ( $parts as $part ) {
		if ( ! is_numeric( $part ) ) {
			return null;
		}
	}
	return array_map(
		static function ( $part ) {
			return (int) round( (float) $part );
		},
		$parts
	);
}

/**
 * Named numeric attributes, as integers.
 *
 * @param string   $attrs Attribute text.
 * @param string[] $names Attribute names.
 * @return int[]|null Null when one is missing or not a number.
 */
function isgal_ld_attr_numbers( $attrs, array $names ) {
	$out = array();
	foreach ( $names as $name ) {
		$value = isgal_ld_attr( $attrs, $name );
		if ( ! is_numeric( $value ) ) {
			return null;
		}
		$out[] = (int) round( (float) $value );
	}
	return $out;
}

/**
 * The corners of a path made only of straight, absolute lines.
 *
 * ImageSnippets writes a polygon region as <path d=" M8 363 L309 275 … z"/>.
 * Anything an image map cannot say (curves, relative moves, a second subpath)
 * is not a polygon, and gets null.
 *
 * @param string $d The path data.
 * @return int[]|null Flat x1,y1,x2,y2,….
 */
function isgal_ld_path_points( $d ) {
	if ( ! preg_match_all( '/([A-Za-z])|(-?\d*\.?\d+(?:e[-+]?\d+)?)/i', (string) $d, $tokens, PREG_SET_ORDER ) ) {
		return null;
	}
	$points  = array();
	$pending = array();
	$command = '';
	$x       = 0;
	$y       = 0;
	$moves   = 0;
	$flush   = static function () use ( &$pending, &$points, &$command, &$x, &$y ) {
		if ( 'H' === $command ) {
			$x = $pending[0];
		} elseif ( 'V' === $command ) {
			$y = $pending[0];
		} else {
			list( $x, $y ) = $pending;
		}
		$points[] = $x;
		$points[] = $y;
		$pending  = array();
	};
	foreach ( $tokens as $token ) {
		if ( isset( $token[2] ) && '' !== $token[2] ) {
			if ( ! in_array( $command, array( 'M', 'L', 'H', 'V' ), true ) ) {
				return null;
			}
			$pending[] = (float) $token[2];
			if ( count( $pending ) === ( in_array( $command, array( 'H', 'V' ), true ) ? 1 : 2 ) ) {
				$flush();
				// Further pairs after an M are implicit lineto.
				$command = 'M' === $command ? 'L' : $command;
			}
			continue;
		}
		if ( $pending ) {
			return null;
		}
		$command = $token[1];
		if ( 'M' === $command && ++$moves > 1 ) {
			return null;
		}
		if ( ! in_array( $command, array( 'M', 'L', 'H', 'V', 'Z', 'z' ), true ) ) {
			return null;
		}
	}
	$pairs = array();
	foreach ( array_chunk( $points, 2 ) as $pair ) {
		$pair = array( (int) round( $pair[0] ), (int) round( $pair[1] ) );
		// A repeated corner adds nothing.
		if ( ! $pairs || end( $pairs ) !== $pair ) {
			$pairs[] = $pair;
		}
	}
	// The browser closes the polygon, so the closing corner need not be said.
	if ( count( $pairs ) > 1 && reset( $pairs ) === end( $pairs ) ) {
		array_pop( $pairs );
	}
	return count( $pairs ) >= 3 ? array_merge( ...$pairs ) : null;
}

/**
 * One SVG shape as an image-map shape.
 *
 * @param string $tag   rect, polygon, circle or path.
 * @param string $attrs The start tag's attributes.
 * @return array|null [ 'shape' => rect|poly|circle, 'coords' => int[] ] in <area coords> terms:
 *                    rect is left, top, right, bottom; poly is x1,y1,…,xn,yn;
 *                    circle is centre x, centre y, radius.
 */
function isgal_ld_shape( $tag, $attrs ) {
	$tag = strtolower( $tag );
	if ( 'rect' === $tag ) {
		$n = isgal_ld_attr_numbers( $attrs, array( 'x', 'y', 'width', 'height' ) );
		if ( ! $n || $n[2] <= 0 || $n[3] <= 0 ) {
			return null;
		}
		return array(
			'shape'  => 'rect',
			'coords' => array( $n[0], $n[1], $n[0] + $n[2], $n[1] + $n[3] ),
		);
	}
	if ( 'circle' === $tag ) {
		$n = isgal_ld_attr_numbers( $attrs, array( 'cx', 'cy', 'r' ) );
		return ( $n && $n[2] > 0 ) ? array(
			'shape'  => 'circle',
			'coords' => $n,
		) : null;
	}
	$points = null;
	if ( 'polygon' === $tag ) {
		$points = isgal_ld_numbers( isgal_ld_attr( $attrs, 'points' ) );
		$points = ( $points && 0 === count( $points ) % 2 && count( $points ) >= 6 ) ? $points : null;
	} elseif ( 'path' === $tag ) {
		$points = isgal_ld_path_points( isgal_ld_attr( $attrs, 'd' ) );
	}
	return $points ? array(
		'shape'  => 'poly',
		'coords' => $points,
	) : null;
}

/**
 * The regions of an image from the HTML of its RDF page.
 *
 * The page carries <svg width height> with a rect, a polygon written as a path
 * (or a polygon element), or a circle for each region, with id="#Region_…", in
 * the image's pixels. The first svg that holds any shape wins.
 *
 * @param string $html Page HTML.
 * @return array [ 'width' => int, 'height' => int, 'shapes' => [ fragment => shape ] ] where shape is
 *               isgal_ld_shape(); the fragment is percent-decoded, without the '#'.
 */
function isgal_ld_parse_regions( $html ) {
	$out = array(
		'width'  => 0,
		'height' => 0,
		'shapes' => array(),
	);
	if ( ! preg_match_all( '#<svg\b([^>]*)>(.*?)</svg>#is', (string) $html, $svgs, PREG_SET_ORDER ) ) {
		return $out;
	}
	foreach ( $svgs as $svg ) {
		if ( ! preg_match_all( '#<(rect|path|polygon|circle)\b([^>]*?)/?>#i', $svg[2], $found, PREG_SET_ORDER ) ) {
			continue;
		}
		foreach ( $found as $element ) {
			$id    = ltrim( isgal_ld_attr( $element[2], 'id' ), '#' );
			$shape = isgal_ld_shape( $element[1], $element[2] );
			if ( '' !== $id && $shape ) {
				$out['shapes'][ rawurldecode( $id ) ] = $shape;
			}
		}
		if ( $out['shapes'] ) {
			$out['width']  = (int) isgal_ld_attr( $svg[1], 'width' );
			$out['height'] = (int) isgal_ld_attr( $svg[1], 'height' );
			break;
		}
	}
	return $out;
}

/**
 * Where a region is, as a Web Annotation selector.
 *
 * A rectangle is a Media Fragment (xywh); Media Fragments have no other
 * shapes, so a polygon or a circle is an SVG selector.
 *
 * @param array $shape As isgal_ld_shape().
 * @return array JSON-LD node.
 */
function isgal_ld_selector( array $shape ) {
	$c = $shape['coords'];
	if ( 'rect' === $shape['shape'] ) {
		return array(
			'@type'              => 'oa:FragmentSelector',
			'dcterms:conformsTo' => array( '@id' => 'http://www.w3.org/TR/media-frags/' ),
			'rdf:value'          => 'xywh=pixel:' . implode( ',', array( $c[0], $c[1], $c[2] - $c[0], $c[3] - $c[1] ) ),
		);
	}
	if ( 'circle' === $shape['shape'] ) {
		$svg = sprintf( '<circle cx="%d" cy="%d" r="%d"/>', $c[0], $c[1], $c[2] );
	} else {
		$pairs = array();
		foreach ( array_chunk( $c, 2 ) as $pair ) {
			$pairs[] = $pair[0] . ',' . $pair[1];
		}
		$svg = '<polygon points="' . implode( ' ', $pairs ) . '"/>';
	}
	return array(
		'@type'     => 'oa:SvgSelector',
		'rdf:value' => '<svg xmlns="http://www.w3.org/2000/svg">' . $svg . '</svg>',
	);
}

/**
 * The regions of an image, fetched from its RDF page and cached.
 *
 * A failure is cached too, for an hour, so a page that is down costs one
 * request an hour rather than one per view.
 *
 * @param string $page Named-graph IRI, which is also the URL of the RDF page.
 * @return array As isgal_ld_parse_regions().
 */
function isgal_ld_fetch_regions( $page ) {
	$none = array(
		'width'  => 0,
		'height' => 0,
		'shapes' => array(),
	);

	/**
	 * Filter the URL the regions of an image are read from. Return '' to build
	 * documents without regions.
	 *
	 * @param string $url  Defaults to the image's named-graph IRI.
	 * @param string $page The named-graph IRI.
	 */
	$url = (string) apply_filters( 'isgal_ld_regions_url', $page, $page );
	if ( 0 !== strpos( $url, 'https://' ) || ! isgal_iri_is_clean( $url ) ) {
		return $none;
	}

	$key = 'isgal_ld2_' . md5( $url );
	$hit = get_transient( $key );
	if ( is_array( $hit ) ) {
		return $hit;
	}

	$response = wp_safe_remote_get(
		$url,
		array(
			'timeout'             => 10,
			'headers'             => array( 'Accept' => 'text/html' ),
			'limit_response_size' => 2 * MB_IN_BYTES,
		)
	);
	$ok       = ! is_wp_error( $response ) && 200 === (int) wp_remote_retrieve_response_code( $response );
	$regions  = $ok ? isgal_ld_parse_regions( wp_remote_retrieve_body( $response ) ) : $none;
	set_transient( $key, $regions, $ok ? DAY_IN_SECONDS : HOUR_IN_SECONDS );
	return $regions;
}

/**
 * The Wikidata entities a graph mentions: every IRI of the form
 * http://www.wikidata.org/entity/Q… that is a subject or an object.
 *
 * @param array $triples Triples as [ subject, predicate, term ].
 * @return string[] Entity IRIs, once each.
 */
function isgal_ld_wikidata_iris( array $triples ) {
	$found = array();
	foreach ( $triples as $triple ) {
		$candidates = array( $triple[0] );
		if ( isset( $triple[2]['type'], $triple[2]['value'] ) && 'uri' === $triple[2]['type'] ) {
			$candidates[] = $triple[2]['value'];
		}
		foreach ( $candidates as $iri ) {
			if ( preg_match( '#^http://www\.wikidata\.org/entity/Q[1-9][0-9]*$#', (string) $iri ) ) {
				$found[ $iri ] = true;
			}
		}
	}
	return array_keys( $found );
}

/**
 * The labels of Wikidata entities, read from Wikidata itself rather than from
 * the copy in the ImageSnippets store, so that a document says what Wikidata
 * says. One SPARQL request for all the entities not cached yet; a label is
 * kept for a week, a missing one for a day, and a failed request for an hour
 * (the document then keeps the label the store has).
 *
 * @param string[] $iris Entity IRIs, http://www.wikidata.org/entity/Q….
 * @return array [ entity IRI => label ] for the entities with a label.
 */
function isgal_ld_wikidata_labels( array $iris ) {
	/**
	 * Filter the SPARQL endpoint labels of Wikidata entities are read from.
	 * Return '' to keep the labels of the store.
	 *
	 * @param string $endpoint Defaults to the Wikidata Query Service.
	 */
	$endpoint = (string) apply_filters( 'isgal_ld_wikidata_endpoint', 'https://query.wikidata.org/sparql' );
	$lang     = (string) apply_filters( 'isgal_ld_wikidata_lang', 'en' );
	if ( 0 !== strpos( $endpoint, 'https://' ) || ! preg_match( '/^[a-z]{2,3}(-[A-Za-z0-9]+)*$/', $lang ) ) {
		return array();
	}

	$labels  = array();
	$missing = array();
	foreach ( $iris as $iri ) {
		if ( ! preg_match( '#^http://www\.wikidata\.org/entity/(Q[1-9][0-9]*)$#', $iri, $m ) ) {
			continue;
		}
		$hit = get_transient( 'isgal_wd1_' . $lang . '_' . $m[1] );
		if ( false === $hit ) {
			$missing[ $m[1] ] = $iri;
		} elseif ( '' !== $hit ) {
			$labels[ $iri ] = $hit;
		}
	}
	if ( ! $missing ) {
		return $labels;
	}

	$values   = 'wd:' . implode( ' wd:', array_keys( $missing ) );
	$query    = 'SELECT ?e ?l WHERE { VALUES ?e { ' . $values . ' } ?e rdfs:label ?l . FILTER(lang(?l) = "' . $lang . '") }';
	$response = wp_safe_remote_get(
		add_query_arg(
			array(
				'format' => 'json',
				'query'  => $query,
			),
			$endpoint
		),
		array(
			'timeout'             => 10,
			'headers'             => array(
				'Accept'     => 'application/sparql-results+json',
				'User-Agent' => 'ImageSnippetsGallery/' . ISGAL_VERSION . ' (WordPress plugin)',
			),
			'limit_response_size' => MB_IN_BYTES,
		)
	);
	$body     = ! is_wp_error( $response ) && 200 === (int) wp_remote_retrieve_response_code( $response ) ? json_decode( wp_remote_retrieve_body( $response ), true ) : null;
	if ( ! isset( $body['results']['bindings'] ) || ! is_array( $body['results']['bindings'] ) ) {
		foreach ( array_keys( $missing ) as $q ) {
			set_transient( 'isgal_wd1_' . $lang . '_' . $q, '', HOUR_IN_SECONDS );
		}
		return $labels;
	}

	$fresh = array();
	foreach ( $body['results']['bindings'] as $binding ) {
		if ( isset( $binding['e']['value'], $binding['l']['value'] ) && isset( $missing[ substr( strrchr( $binding['e']['value'], '/' ), 1 ) ] ) ) {
			$fresh[ substr( strrchr( $binding['e']['value'], '/' ), 1 ) ] = trim( (string) $binding['l']['value'] );
		}
	}
	foreach ( $missing as $q => $iri ) {
		$label = isset( $fresh[ $q ] ) ? $fresh[ $q ] : '';
		set_transient( 'isgal_wd1_' . $lang . '_' . $q, $label, '' === $label ? DAY_IN_SECONDS : WEEK_IN_SECONDS );
		if ( '' !== $label ) {
			$labels[ $iri ] = $label;
		}
	}
	return $labels;
}

/**
 * The IRI of the image's page: what the document is, and the namespace its
 * element ids live in. The image's own address with .html for its extension,
 * which is where ImageSnippets puts it.
 *
 * @param array $row Row.
 * @return string
 */
function isgal_ld_page_iri( array $row ) {
	$image = (string) $row['image'];
	if ( preg_match( '#^https?://\S+\.[A-Za-z0-9]{2,5}$#', $image ) ) {
		return (string) preg_replace( '/\.[A-Za-z0-9]{2,5}$/', '.html', $image );
	}
	return (string) $row['page'];
}

/**
 * The @context of a document: the plugin's own prefixes, less the @vocab it
 * uses to emit bare schema.org terms (every term here is a CURIE), plus the few
 * more the graphs and the canvas need.
 *
 * @param string $page Page IRI.
 * @return array Prefix to namespace.
 */
function isgal_ld_context( $page ) {
	$context = isgal_jsonld_prefixes();
	unset( $context['@vocab'] );
	return array_merge(
		$context,
		array(
			'oa'          => 'http://www.w3.org/ns/oa#',
			'iptc4xmpext' => 'http://iptc.org/std/Iptc4xmpExt/2008-02-29/',
			'xmp'         => 'http://ns.adobe.com/xap/1.0/',
			'doc'         => $page . '#',
		)
	);
}

/**
 * Compact an IRI against a context, longest namespace first.
 *
 * @param string $iri     IRI.
 * @param array  $context Prefix to namespace.
 * @return string The CURIE, or the IRI unchanged.
 */
function isgal_ld_compact( $iri, array $context ) {
	static $sorted = array();
	$key = md5( wp_json_encode( $context ) );
	if ( ! isset( $sorted[ $key ] ) ) {
		uasort(
			$context,
			static function ( $a, $b ) {
				return strlen( $b ) - strlen( $a );
			}
		);
		$sorted[ $key ] = $context;
	}
	foreach ( $sorted[ $key ] as $prefix => $namespace ) {
		if ( 0 === strpos( $iri, $namespace ) ) {
			$local = substr( $iri, strlen( $namespace ) );
			if ( '' !== $local && ! preg_match( '~[/#?\s]~', $local ) ) {
				return $prefix . ':' . $local;
			}
		}
	}
	return $iri;
}

/**
 * The id a region gets in the document: "Region_Region A" is "region-a".
 *
 * @param string $fragment Percent-decoded fragment of the region's IRI.
 * @param array  $taken    Ids already given, id => true.
 * @return string
 */
function isgal_ld_region_id( $fragment, array $taken ) {
	$slug = trim( (string) preg_replace( '/[^a-z0-9]+/', '-', strtolower( (string) preg_replace( '/^Region_/', '', $fragment ) ) ), '-' );
	$id   = ( 0 === strpos( $slug, 'region' ) ) ? $slug : trim( 'region-' . $slug, '-' );
	$base = $id;
	for ( $n = 2; isset( $taken[ $id ] ); $n++ ) {
		$id = $base . '-' . $n;
	}
	return $id;
}

/**
 * One term of a triple as a JSON-LD value.
 *
 * A literal that contains markup is typed rdf:HTML (and loses its language,
 * which a typed literal cannot have).
 *
 * @param array    $term    SPARQL JSON term.
 * @param callable $node_id Maps an IRI to the id it has in the document.
 * @param array    $context Prefix to namespace.
 * @return array
 */
function isgal_ld_value( array $term, $node_id, array $context ) {
	$value = isset( $term['value'] ) ? (string) $term['value'] : '';
	$type  = isset( $term['type'] ) ? $term['type'] : 'literal';
	if ( 'uri' === $type ) {
		return array( '@id' => $node_id( $value ) );
	}
	if ( 'bnode' === $type ) {
		return array( '@id' => '_:' . $value );
	}
	if ( preg_match( '#</?[a-z][a-z0-9]*(\s[^>]*)?/?>#i', $value ) ) {
		return array(
			'@type'  => 'rdf:HTML',
			'@value' => $value,
		);
	}
	if ( ! empty( $term['xml:lang'] ) ) {
		return array(
			'@value'    => $value,
			'@language' => $term['xml:lang'],
		);
	}
	if ( ! empty( $term['datatype'] ) && 'http://www.w3.org/2001/XMLSchema#string' !== $term['datatype'] ) {
		return array(
			'@type'  => isgal_ld_compact( $term['datatype'], $context ),
			'@value' => $value,
		);
	}
	return array( '@value' => $value );
}

/**
 * Build the Linked Document of an image.
 *
 * @param array $row     Row, as mirrored.
 * @param array $regions Region geometry, as isgal_ld_parse_regions().
 * @return array [ 'page' => IRI, 'graph' => JSON-LD document, 'regions' => [ [ id, label, shows, shape ] ],
 *               'width' => int, 'height' => int ].
 */
function isgal_ld_document( array $row, array $regions ) {
	$page    = isgal_ld_page_iri( $row );
	$context = isgal_ld_context( $page );
	$labels  = isset( $row['labels'] ) ? (array) $row['labels'] : array();
	// The labels of Wikidata entities are Wikidata's own, not the copy in the store.
	$wikidata = isgal_ld_wikidata_labels( isgal_ld_wikidata_iris( (array) $row['triples'] ) );
	$labels   = array_merge( $labels, $wikidata );
	$wd_lang  = (string) apply_filters( 'isgal_ld_wikidata_lang', 'en' );
	$chrome  = isgal_graph_chrome_prefixes();
	$type    = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
	$shows   = 'https://w3id.org/lio/v1#shows';

	// Which IRIs are regions, and the id each has in the document.
	$region_ids = array();
	$taken      = array();
	$regions_in = array();
	foreach ( (array) $row['triples'] as $triple ) {
		foreach ( array( $triple[0], isset( $triple[2]['type'], $triple[2]['value'] ) && 'uri' === $triple[2]['type'] ? $triple[2]['value'] : '' ) as $iri ) {
			if ( '' !== $iri && ! isset( $region_ids[ $iri ] ) && preg_match( '/#(Region_[^#]*)$/', $iri, $m ) ) {
				$fragment            = rawurldecode( $m[1] );
				$id                  = isgal_ld_region_id( $fragment, $taken );
				$taken[ $id ]        = true;
				$region_ids[ $iri ]  = $id;
				$regions_in[ $iri ]  = $fragment;
			}
		}
	}

	$node_id = static function ( $iri ) use ( $row, $region_ids ) {
		if ( (string) $row['image'] === $iri ) {
			return 'doc:image';
		}
		return isset( $region_ids[ $iri ] ) ? 'doc:' . $region_ids[ $iri ] : $iri;
	};

	// The graph, node by node.
	$nodes = array();
	foreach ( (array) $row['triples'] as $triple ) {
		list( $subject, $predicate, $term ) = $triple;
		$value                              = isset( $term['value'] ) ? trim( (string) $term['value'] ) : '';
		if ( '' === $value ) {
			continue;
		}
		foreach ( $chrome as $prefix ) {
			if ( 0 === strpos( $predicate, $prefix ) ) {
				continue 2;
			}
		}
		$id = $node_id( $subject );
		if ( ! isset( $nodes[ $id ] ) ) {
			$nodes[ $id ] = array( '@id' => $id );
		}
		if ( $type === $predicate && isset( $term['type'] ) && 'uri' === $term['type'] ) {
			$nodes[ $id ]['@type'][] = isgal_ld_compact( $value, $context );
			continue;
		}
		$key                      = isgal_ld_compact( $predicate, $context );
		$nodes[ $id ][ $key ][]   = isgal_ld_value( $term, $node_id, $context );
	}
	foreach ( $nodes as $id => $node ) {
		foreach ( $node as $key => $values ) {
			if ( '@id' !== $key ) {
				$nodes[ $id ][ $key ] = array_values( array_unique( $values, SORT_REGULAR ) );
			}
		}
	}

	foreach ( $wikidata as $iri => $label ) {
		if ( ! isset( $nodes[ $iri ] ) ) {
			$nodes[ $iri ] = array( '@id' => $iri );
		}
		$nodes[ $iri ]['rdfs:label'] = array(
			array(
				'@value'    => $label,
				'@language' => $wd_lang,
			),
		);
	}

	// The image: its size when the RDF page said.
	$content = isgal_first( array( $row['content'], $row['image'] ) );
	if ( $regions['width'] > 0 && $regions['height'] > 0 && isset( $nodes['doc:image'] ) ) {
		$nodes['doc:image']['schema:width']  = array( array( '@value' => $regions['width'] ) );
		$nodes['doc:image']['schema:height'] = array( array( '@value' => $regions['height'] ) );
	}

	// The regions: a label when the graph has none, and a place when we know it.
	$list = array();
	foreach ( $region_ids as $iri => $id ) {
		$doc_id = 'doc:' . $id;
		$label  = isgal_node_label( $iri, $labels );
		if ( ! isset( $nodes[ $doc_id ] ) ) {
			$nodes[ $doc_id ] = array( '@id' => $doc_id );
		}
		if ( ! isset( $nodes[ $doc_id ]['rdfs:label'] ) ) {
			$nodes[ $doc_id ]['rdfs:label'] = array( array( '@value' => $label ) );
		}
		$what = array();
		foreach ( (array) $row['triples'] as $triple ) {
			if ( $triple[0] === $iri && $shows === $triple[1] && isset( $triple[2]['value'] ) ) {
				$what[] = isgal_node_label( $triple[2]['value'], $labels );
			}
		}
		$shape = isset( $regions['shapes'][ $regions_in[ $iri ] ] ) ? $regions['shapes'][ $regions_in[ $iri ] ] : null;
		if ( $shape ) {
			$nodes[ $doc_id ]['oa:hasSelector'] = array( isgal_ld_selector( $shape ) );
		}
		$list[] = array(
			'id'    => $id,
			'label' => $label,
			'shows' => array_values( array_unique( $what ) ),
			'shape' => $shape,
		);
	}

	// The page, and the canvas that carries the regions.
	$title                 = isgal_first( array( $row['title'], $row['name'] ) );
	$nodes[ $page ]        = ( isset( $nodes[ $page ] ) ? $nodes[ $page ] : array( '@id' => $page ) );
	$nodes[ $page ]['@type'] = array( 'schema:WebPage' );
	if ( '' !== $title ) {
		$nodes[ $page ]['schema:name'] = array( array( '@value' => $title ) );
	}
	$nodes[ $page ]['schema:mainEntity'] = array( array( '@id' => 'doc:image' ) );
	// CP/LD does not nest parts: the canvas and every region are parts of the page itself.
	$nodes[ $page ]['schema:hasPart']    = array_merge(
		array( array( '@id' => 'doc:canvas' ) ),
		array_map(
			static function ( $region ) {
				return array( '@id' => 'doc:' . $region['id'] );
			},
			$list
		)
	);

	$canvas = array(
		'@id'               => 'doc:canvas',
		'@type'             => array( 'schema:ImageObject' ),
		'schema:contentUrl' => array( array( '@id' => $content ) ),
	);
	$nodes['doc:canvas'] = $canvas;

	// The document first, then what it is made of, then everything else.
	$first = array( $page, 'doc:image', 'doc:canvas' );
	foreach ( $region_ids as $id ) {
		$first[] = 'doc:' . $id;
	}
	$ordered = array();
	foreach ( $first as $id ) {
		if ( isset( $nodes[ $id ] ) ) {
			$ordered[] = $nodes[ $id ];
			unset( $nodes[ $id ] );
		}
	}

	return array(
		'page'    => $page,
		'graph'   => array(
			'@context' => $context,
			'@graph'   => array_merge( $ordered, array_values( $nodes ) ),
		),
		'regions' => $list,
		'width'   => (int) $regions['width'],
		'height'  => (int) $regions['height'],
	);
}

/**
 * The first paragraph of a description, as text. ImageSnippets descriptions
 * are HTML fragments that may go on to carry a markdown-style LIO description
 * after "Here is the LIO description"; the caption is what comes before.
 *
 * @param string $description Description.
 * @return string
 */
function isgal_ld_caption( $description ) {
	$text = preg_replace( '#<(br|/div|/p)\b[^>]*>#i', "\n", (string) $description );
	$text = wp_strip_all_tags( (string) $text );
	$text = preg_split( '/Here is the LIO description/i', $text )[0];
	return trim( (string) preg_replace( '/\s+/', ' ', $text ) );
}

/**
 * The HTML canvas of a document: the image, its image map, and who made it.
 *
 * Every element in the body has an id; the ones the graph names (image,
 * canvas, the regions) have the id the graph gives them.
 *
 * @param array  $doc       As isgal_ld_document().
 * @param array  $row       Row.
 * @param string $graph_url Where the JSON-LD graph is served.
 * @return string HTML.
 */
function isgal_ld_html( array $doc, array $row, $graph_url ) {
	$title   = isgal_first( array( $row['title'], $row['name'], $row['image'] ) );
	$alt     = isgal_first( array( $row['alt'], $title ) );
	$source  = isgal_first( array( $row['content'], $row['image'], $row['thumb'] ) );
	$caption = isgal_ld_caption( $row['desc'] );
	$areas   = array_filter(
		$doc['regions'],
		static function ( $region ) {
			return null !== $region['shape'];
		}
	);
	// A region whose place is not known is still in the graph, so it is still
	// in the page: listed, under the id the graph gives it.
	$unplaced = array_filter(
		$doc['regions'],
		static function ( $region ) {
			return null === $region['shape'];
		}
	);

	ob_start();
	?>
<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta name="id" content="<?php echo esc_attr( $doc['page'] ); ?>">
	<link rel="preload" type="application/ld+json" href="<?php echo esc_url( $graph_url ); ?>" as="fetch" crossorigin>
	<title><?php echo esc_html( $title ); ?></title>
	<style>
		figure { display: inline-block; max-width: 100%; margin: 0; }
		figure img { display: block; max-width: 100%; height: auto; }
		/* An <area> has no box to style, so the script draws each one as an SVG outline over the image. */
		#stage { position: relative; }
		#region-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; filter: drop-shadow(0 0 1px #000); }
		#region-overlay * { fill: none; stroke: #ffd400; stroke-width: 1px; vector-effect: non-scaling-stroke; }
		#region-overlay .active { fill: rgba(255, 212, 0, .3); }
	</style>
</head>
<body id="body">
	<main id="main">
		<h1 id="title"><?php echo esc_html( $title ); ?></h1>
		<figure id="canvas">
			<div id="stage">
			<img id="image" src="<?php echo esc_url( $source ); ?>"<?php echo $areas ? ' usemap="#regions"' : ''; ?> alt="<?php echo esc_attr( $alt ); ?>">
			<?php if ( $areas ) : ?>
			<map id="regions" name="regions">
				<?php foreach ( $areas as $region ) : ?>
					<?php $name = $region['label'] . ( $region['shows'] ? ': ' . implode( ', ', $region['shows'] ) : '' ); ?>
				<area id="<?php echo esc_attr( $region['id'] ); ?>" shape="<?php echo esc_attr( $region['shape']['shape'] ); ?>" coords="<?php echo esc_attr( implode( ',', $region['shape']['coords'] ) ); ?>" href="#<?php echo esc_attr( $region['id'] ); ?>" alt="<?php echo esc_attr( $name ); ?>">
				<?php endforeach; ?>
			</map>
			<?php endif; ?>
			</div>
			<?php if ( '' !== $caption ) : ?>
			<figcaption id="caption"><?php echo esc_html( $caption ); ?></figcaption>
			<?php endif; ?>
		</figure>
		<?php if ( $unplaced ) : ?>
		<ul id="regions-list">
			<?php foreach ( $unplaced as $region ) : ?>
			<li id="<?php echo esc_attr( $region['id'] ); ?>"><?php echo esc_html( $region['label'] . ( $region['shows'] ? ': ' . implode( ', ', $region['shows'] ) : '' ) ); ?></li>
			<?php endforeach; ?>
		</ul>
		<?php endif; ?>
		<?php if ( '' !== $row['creator'] || '' !== $row['rights'] || '' !== $row['web'] ) : ?>
		<p id="credit">
			<?php if ( '' !== $row['creator'] ) : ?>
			<span id="creator"><?php echo esc_html( $row['creator'] ); ?></span>
			<?php endif; ?>
			<?php if ( '' !== $row['rights'] ) : ?>
			<span id="rights"><?php echo esc_html( $row['rights'] ); ?></span>
			<?php endif; ?>
			<?php if ( '' !== $row['web'] ) : ?>
			<a id="license" href="<?php echo esc_url( $row['web'] ); ?>"><?php echo esc_html( $row['web'] ); ?></a>
			<?php endif; ?>
		</p>
		<?php endif; ?>
	</main>
	<?php if ( $areas ) : ?>
	<script id="draw-areas">
		// Image maps do not scale with a responsive image, and areas cannot be styled:
		// keep the areas on their regions, and draw each one as an outline.
		( function () {
			var NS = 'http://www.w3.org/2000/svg';
			var img = document.getElementById( 'image' );
			var areas = Array.prototype.slice.call( document.querySelectorAll( '#regions area' ) );
			var orig = areas.map( function ( a ) { return a.getAttribute( 'coords' ).split( ',' ).map( Number ); } );
			var overlay = document.createElementNS( NS, 'svg' );
			overlay.id = 'region-overlay';
			overlay.setAttribute( 'aria-hidden', 'true' );
			img.parentNode.appendChild( overlay );
			areas.forEach( function ( a, i ) {
				var c = orig[ i ], el;
				if ( 'circle' === a.shape ) {
					el = document.createElementNS( NS, 'circle' );
					el.setAttribute( 'cx', c[ 0 ] ); el.setAttribute( 'cy', c[ 1 ] ); el.setAttribute( 'r', c[ 2 ] );
				} else if ( 'poly' === a.shape ) {
					el = document.createElementNS( NS, 'polygon' );
					el.setAttribute( 'points', c.join( ' ' ) );
				} else {
					el = document.createElementNS( NS, 'rect' );
					el.setAttribute( 'x', c[ 0 ] ); el.setAttribute( 'y', c[ 1 ] );
					el.setAttribute( 'width', c[ 2 ] - c[ 0 ] ); el.setAttribute( 'height', c[ 3 ] - c[ 1 ] );
				}
				el.id = a.id + '-outline';
				overlay.appendChild( el );
				[ 'mouseover', 'focus' ].forEach( function ( e ) { a.addEventListener( e, function () { el.classList.add( 'active' ); } ); } );
				[ 'mouseout', 'blur' ].forEach( function ( e ) { a.addEventListener( e, function () { el.classList.remove( 'active' ); } ); } );
			} );
			function scale() {
				var k = img.clientWidth / img.naturalWidth;
				overlay.setAttribute( 'viewBox', '0 0 ' + img.naturalWidth + ' ' + img.naturalHeight );
				areas.forEach( function ( a, i ) { a.coords = orig[ i ].map( function ( c ) { return Math.round( c * k ); } ).join( ',' ); } );
			}
			window.addEventListener( 'resize', scale );
			img.complete ? scale() : img.addEventListener( 'load', scale );
		} )();
	</script>
	<?php endif; ?>
</body>
</html>
	<?php
	return ob_get_clean();
}

/**
 * Register the query variable the document is asked for by.
 *
 * @param array $vars Query vars.
 * @return array
 */
function isgal_ld_query_vars( $vars ) {
	$vars[] = ISGAL_LD_QUERY_VAR;
	return $vars;
}
add_filter( 'query_vars', 'isgal_ld_query_vars' );

/**
 * Answer /?isgal_ld={hash}: the canvas, or with &format=jsonld the graph.
 *
 * Runs before the canonical redirect and before the theme. An unknown hash is
 * an ordinary 404.
 *
 * @return void
 */
function isgal_ld_serve() {
	$hash = get_query_var( ISGAL_LD_QUERY_VAR );
	if ( '' === $hash || null === $hash ) {
		return;
	}

	$row = null;
	if ( is_string( $hash ) && preg_match( '/^[a-f0-9]{32}$/', $hash ) ) {
		$ids = get_posts(
			array(
				'post_type'      => ISGAL_POST_TYPE,
				'post_status'    => 'publish',
				'name'           => $hash,
				'posts_per_page' => 1,
				'fields'         => 'ids',
				'no_found_rows'  => true,
			)
		);
		$row = $ids ? isgal_mirror_read_row( (int) $ids[0] ) : null;
	}
	if ( ! $row ) {
		global $wp_query;
		$wp_query->set_404();
		status_header( 404 );
		nocache_headers();
		return;
	}

	$doc    = isgal_ld_document( $row, isgal_ld_fetch_regions( (string) $row['page'] ) );
	$jsonld = isset( $_GET['format'] ) && 'jsonld' === sanitize_key( wp_unslash( $_GET['format'] ) ); // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- A public read.

	status_header( 200 );
	header( 'Cache-Control: public, max-age=3600' );
	if ( $jsonld ) {
		header( 'Content-Type: application/ld+json; charset=utf-8' );
		header( 'Access-Control-Allow-Origin: *' );
		echo wp_json_encode( $doc['graph'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- JSON, not HTML.
	} else {
		header( 'Content-Type: text/html; charset=utf-8' );
		echo isgal_ld_html( $doc, $row, isgal_ld_url( (string) $row['page'], 'jsonld' ) ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- escaped within.
	}
	exit;
}
add_action( 'template_redirect', 'isgal_ld_serve', 1 );
