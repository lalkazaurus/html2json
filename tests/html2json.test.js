/*
 * Automated tests for html2json. No dependencies: run with
 *
 *   node --test tests/
 *
 * (Node.js 18+). The file covers:
 *   - the output format and every agreed design decision;
 *   - edge cases and malformed HTML, including the warnings produced;
 *   - every file in html_samples/;
 *   - a round-trip property test on random well-formed trees;
 *   - a fuzz test on random garbage input (must never throw);
 *   - size and speed on large and pathological inputs.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  html2json,
  stringifyResult,
  estimatePrettyIndentation,
  textForDisplay,
  HTML2JSON_LIMITS,
  OUTPUT_LIMITS,
  EXAMPLE_HTML_1,
  EXAMPLE_HTML_2,
} = require("../html2json.js");

const SAMPLES_DIR = path.join(__dirname, "..", "html_samples");

/* ------------------------------------------------------------------------ */
/* Helpers                                                                  */
/* ------------------------------------------------------------------------ */

// Attribute objects have no prototype, so they are compared as plain JSON.
const toJson = (html, options) => JSON.parse(JSON.stringify(html2json(html, options)));
const childrenOf = (html, options) => toJson(html, options).children;
const PRESERVE = { preserveWhitespace: true };
const warningCodes = (html) => html2json(html).warnings.map((w) => w.code);

const el = (tag, attributes = {}, children = []) => ({ type: "element", tag, attributes, children });
const text = (value) => ({ type: "text", value });

/**
 * Walks the whole tree iteratively and checks that every node has exactly
 * the documented shape. Returns the maximum element depth.
 */
function assertValidShape(result) {
  assert.equal(result.type, "document");
  assert.ok(Array.isArray(result.children));
  assert.ok(Array.isArray(result.warnings));
  for (const w of result.warnings) {
    assert.deepEqual(Object.keys(w), ["code", "message", "line", "column"]);
    assert.equal(typeof w.code, "string");
    assert.equal(typeof w.message, "string");
  }

  let maxDepth = 0;
  const pending = result.children.map((node) => ({ node, depth: 1 }));
  while (pending.length > 0) {
    const { node, depth } = pending.pop();
    if (node.type === "element") {
      assert.deepEqual(Object.keys(node), ["type", "tag", "attributes", "children"]);
      assert.equal(typeof node.tag, "string");
      for (const value of Object.values(node.attributes)) assert.equal(typeof value, "string");
      maxDepth = Math.max(maxDepth, depth);
      for (const child of node.children) pending.push({ node: child, depth: depth + 1 });
    } else {
      assert.ok(["text", "comment", "doctype"].includes(node.type), `unknown node type ${node.type}`);
      assert.deepEqual(Object.keys(node), ["type", "value"]);
      assert.equal(typeof node.value, "string");
    }
  }
  return maxDepth;
}

// Deterministic pseudo-random generator, so a failing case can be reproduced.
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/* ------------------------------------------------------------------------ */
/* Output format                                                            */
/* ------------------------------------------------------------------------ */

test("produces the documented format", () => {
  assert.deepEqual(toJson('<p class="a" hidden>Hi <br> there</p>'), {
    type: "document",
    children: [el("p", { class: "a", hidden: "" }, [text("Hi "), el("br"), text(" there")])],
    warnings: [],
  });
});

test("keeps mixed content in order", () => {
  assert.deepEqual(childrenOf("<p>a<b>b</b>c<i>d</i>e</p>"), [
    el("p", {}, [text("a"), el("b", {}, [text("b")]), text("c"), el("i", {}, [text("d")]), text("e")]),
  ]);
});

test("a fragment can have several root nodes", () => {
  assert.deepEqual(childrenOf("<a></a>text<b></b>"), [el("a"), text("text"), el("b")]);
});

test("the provided examples convert without warnings", () => {
  for (const example of [EXAMPLE_HTML_1, EXAMPLE_HTML_2]) {
    const result = html2json(example);
    assertValidShape(result);
    assert.deepEqual(result.warnings, []);
  }
});

/* ------------------------------------------------------------------------ */
/* Input validation                                                         */
/* ------------------------------------------------------------------------ */

test("non-string input returns an empty document with a warning", () => {
  for (const input of [undefined, null, 42, {}, [], true, () => {}, Symbol("x")]) {
    const result = html2json(input);
    assert.deepEqual(result.children, []);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].code, "INVALID_INPUT");
  }
});

test("empty and whitespace-only input", () => {
  assert.deepEqual(toJson(""), { type: "document", children: [], warnings: [] });
  assert.deepEqual(childrenOf("  \n\t "), []);
  assert.deepEqual(childrenOf("   "), [text("   ")]);
  assert.deepEqual(childrenOf("  \n\t ", PRESERVE), [text("  \n\t ")]);
});

test("invalid options fall back to defaults with a warning", () => {
  const throwingGetter = {
    get preserveWhitespace() {
      throw new Error("boom");
    },
  };
  for (const options of ["yes", 1, true, () => {}, { preserveWhitespace: "true" }, throwingGetter]) {
    const result = toJson("<p>a</p>\n<p>b</p>", options);
    assert.deepEqual(result.children, [el("p", {}, [text("a")]), el("p", {}, [text("b")])]);
    assert.deepEqual(
      result.warnings.map((w) => w.code),
      ["INVALID_OPTIONS"],
    );
  }
  for (const options of [undefined, null, {}, { unknown: 1 }, { preserveWhitespace: false }]) {
    assert.deepEqual(warningCodes("<p></p>", options), []);
  }
});

/* ------------------------------------------------------------------------ */
/* Whitespace                                                               */
/* ------------------------------------------------------------------------ */

test("formatting whitespace (with a line break) is dropped by default", () => {
  assert.deepEqual(childrenOf("<!DOCTYPE html>\n<ul>\n  <li> a </li>\n  <li>b</li>\n</ul>\n"), [
    { type: "doctype", value: "html" },
    el("ul", {}, [el("li", {}, [text(" a ")]), el("li", {}, [text("b")])]),
  ]);
});

test("spaces on one line between elements are kept", () => {
  assert.deepEqual(childrenOf("<p><b>a</b> <i>b</i>\t<u>c</u></p>"), [
    el("p", {}, [el("b", {}, [text("a")]), text(" "), el("i", {}, [text("b")]), text("\t"), el("u", {}, [text("c")])]),
  ]);
});

test("text with visible characters is never trimmed", () => {
  assert.deepEqual(childrenOf("<p>\n  Hello\n</p>"), [el("p", {}, [text("\n  Hello\n")])]);
});

test("a no-break space is content, not whitespace", () => {
  assert.deepEqual(childrenOf("<p>&nbsp;\n</p>"), [el("p", {}, [text(" \n")])]);
});

test("whitespace inside pre, textarea, script and style is untouched", () => {
  for (const tag of ["pre", "textarea", "script", "style", "title"]) {
    assert.deepEqual(childrenOf(`<${tag}> \n  \n</${tag}>`), [el(tag, {}, [text(" \n  \n")])], tag);
  }
});

test("elements nested in pre keep whitespace too, and dropping resumes after it", () => {
  assert.deepEqual(childrenOf("<pre>\n\n<b>x</b>\n</pre>\n<div>\n</div>"), [
    el("pre", {}, [text("\n"), el("b", {}, [text("x")]), text("\n")]),
    el("div"),
  ]);
});

test("an unclosed pre keeps whitespace up to the end of input", () => {
  assert.deepEqual(childrenOf("<pre>\n\n<b>x</b>\n"), [
    el("pre", {}, [text("\n"), el("b", {}, [text("x")]), text("\n")]),
  ]);
});

test("the decision is made on the final text node, after merging", () => {
  // "a" and "\n  " are separate pieces but one node: nothing is removed.
  assert.deepEqual(childrenOf("<p>a</x>\n  </p>"), [el("p", {}, [text("a\n  ")])]);
  // Two whitespace pieces that merge into a formatting node are removed together.
  assert.deepEqual(childrenOf("<p>  </x>\n</p>"), [el("p")]);
});

test("preserveWhitespace keeps every text node exactly", () => {
  assert.deepEqual(childrenOf("<ul>\n  <li> a </li>\n</ul>", PRESERVE), [
    el("ul", {}, [text("\n  "), el("li", {}, [text(" a ")]), text("\n")]),
  ]);
});

test("Example 2 has no formatting text nodes by default", () => {
  assert.deepEqual(childrenOf(EXAMPLE_HTML_2), [
    el("div", {}, [
      el("p", {}, [text("Hello world!")]),
      el("button", {}, [text("Click me!")]),
      el("textarea", {}, [text(`Some ${"very ".repeat(35)}long string.`)]),
    ]),
  ]);
  assert.equal(childrenOf(EXAMPLE_HTML_2, PRESERVE)[0].children.length, 7);
});

test("Example 1: only meaningful text nodes remain", () => {
  const texts = [];
  const pending = [...childrenOf(EXAMPLE_HTML_1)];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node.type === "text") texts.push(node.value);
    if (node.type === "element") pending.push(...node.children);
  }
  assert.ok(
    texts.every((value) => value.trim() !== ""),
    JSON.stringify(texts),
  );
  assert.equal(texts.length, 10);
});

test("CRLF and CR are normalized to LF, a BOM is dropped", () => {
  assert.deepEqual(childrenOf("﻿<p>a\r\nb\rc</p>"), [el("p", {}, [text("a\nb\nc")])]);
});

/* ------------------------------------------------------------------------ */
/* Entities (decision 2: minimal set)                                       */
/* ------------------------------------------------------------------------ */

test("decodes the supported named and numeric entities", () => {
  assert.deepEqual(childrenOf("&amp;&lt;&gt;&quot;&apos;&nbsp;&copy;"), [text("&<>\"' ©")]);
  assert.deepEqual(childrenOf("&#169;&#xA9;&#XA9;&#128512;&#65"), [text("©©©\u{1F600}A")]);
});

test("leaves unknown or incomplete references as written", () => {
  const source = "&hellipx; &x; AT&T & &# &#x; &constructor; &__proto__; &notin; &Mdash;";
  assert.deepEqual(childrenOf(source), [text(source)]);
});

test("invalid code points become U+FFFD instead of throwing", () => {
  assert.deepEqual(childrenOf("&#0;&#xD800;&#x110000;&#99999999999999999999;"), [text("�".repeat(4))]);
});

test("decodes once only", () => {
  assert.deepEqual(childrenOf("&amp;lt;"), [text("&lt;")]);
});

/* ------------------------------------------------------------------------ */
/* Attributes (decisions 3 and 4)                                           */
/* ------------------------------------------------------------------------ */

test("attributes in all syntaxes", () => {
  const [div] = childrenOf(`<div a="1" b='2' c=3 d e = "5" f= g=h/i j="x>y" k='"'>`);
  assert.deepEqual(div.attributes, { a: "1", b: "2", c: "3", d: "", e: "5", f: "g=h/i", j: "x>y", k: '"' });
});

test("boolean attributes get an empty string value, as in the DOM", () => {
  assert.deepEqual(childrenOf("<input disabled checked>")[0].attributes, { disabled: "", checked: "" });
});

test("tag and attribute names are lowercased, values are not", () => {
  assert.deepEqual(childrenOf('<DIV ID="MyId" Data-X="Y"></div>'), [el("div", { id: "MyId", "data-x": "Y" })]);
});

test("only ASCII letters are lowercased in names", () => {
  assert.equal(childrenOf("<x-İ></x-İ>")[0].tag, "x-İ");
});

test("duplicate attribute: the first one wins, with a warning", () => {
  const result = toJson('<p class="a" CLASS="b"></p>');
  assert.deepEqual(result.children[0].attributes, { class: "a" });
  assert.equal(result.warnings[0].code, "DUPLICATE_ATTRIBUTE");
});

test("attribute values are entity-decoded", () => {
  assert.deepEqual(childrenOf('<a href="?a=1&amp;b=2" title=&lt;x&gt;>')[0].attributes, {
    href: "?a=1&b=2",
    title: "<x>",
  });
});

test("attribute names that exist on Object.prototype are ordinary keys", () => {
  const result = html2json('<a __proto__="x" constructor="y" hasOwnProperty="z"></a>');
  const { attributes } = result.children[0];
  assert.equal(Object.getPrototypeOf(attributes), null);
  assert.deepEqual(Object.keys(attributes), ["__proto__", "constructor", "hasownproperty"]);
  assert.equal(JSON.parse(JSON.stringify(result)).children[0].attributes.constructor, "y");
  assert.equal({}.polluted, undefined);
});

/* ------------------------------------------------------------------------ */
/* Void, self-closing and raw text elements                                 */
/* ------------------------------------------------------------------------ */

test("void elements never take children", () => {
  assert.deepEqual(childrenOf("<p>a<br>b<img src=x>c</p>"), [
    el("p", {}, [text("a"), el("br"), text("b"), el("img", { src: "x" }), text("c")]),
  ]);
});

test("self-closing syntax closes any element (agreed decision)", () => {
  assert.deepEqual(childrenOf("<div/><span/>x<br/>"), [el("div"), el("span"), text("x"), el("br")]);
});

test("script and style content is raw and not decoded", () => {
  const source = 'if (a < b && c > d) { s = "</div>&amp;"; }';
  assert.deepEqual(childrenOf(`<script>${source}</script>`), [el("script", {}, [text(source)])]);
  assert.deepEqual(childrenOf("<style>a > b {}</style>"), [el("style", {}, [text("a > b {}")])]);
});

test("textarea and title content is raw but decoded", () => {
  assert.deepEqual(childrenOf("<textarea><b>&lt;x&gt;</b></textarea>"), [el("textarea", {}, [text("<b><x></b>")])]);
  assert.deepEqual(childrenOf("<title>A &amp; <i>B</i></title>"), [el("title", {}, [text("A & <i>B</i>")])]);
});

test("raw text ends only at the real closing tag", () => {
  assert.deepEqual(childrenOf("<script>a</scriptx>b</SCRIPT >c"), [
    el("script", {}, [text("a</scriptx>b")]),
    text("c"),
  ]);
});

test("empty raw text element has no children", () => {
  assert.deepEqual(childrenOf("<script></script>"), [el("script")]);
});

/* ------------------------------------------------------------------------ */
/* Comments, doctype, bogus markup                                          */
/* ------------------------------------------------------------------------ */

test("comments and doctype", () => {
  assert.deepEqual(childrenOf("<!DOCTYPE  html ><!-- a <b> -- c --><!----><!--><!--->"), [
    { type: "doctype", value: "html" },
    { type: "comment", value: " a <b> -- c " },
    { type: "comment", value: "" },
    { type: "comment", value: "" },
    { type: "comment", value: "" },
  ]);
});

test("comment closed with --!>", () => {
  assert.deepEqual(childrenOf("<!-- x --!>y"), [{ type: "comment", value: " x " }, text("y")]);
});

test("CDATA and processing instructions are stored as comments", () => {
  const result = toJson('<?xml version="1.0"?><![CDATA[x]]>');
  assert.deepEqual(result.children, [
    { type: "comment", value: '?xml version="1.0"?' },
    { type: "comment", value: "[CDATA[x]]" },
  ]);
  assert.deepEqual(
    result.warnings.map((w) => w.code),
    ["BOGUS_COMMENT", "BOGUS_COMMENT"],
  );
});

/* ------------------------------------------------------------------------ */
/* Malformed HTML (decisions 5 and 6)                                       */
/* ------------------------------------------------------------------------ */

test("a lone < is text", () => {
  assert.deepEqual(childrenOf("a < b <3 <"), [text("a < b <3 <")]);
});

test("unmatched closing tag is ignored and text around it merges", () => {
  const result = toJson("a</x>b");
  assert.deepEqual(result.children, [text("ab")]);
  assert.equal(result.warnings[0].code, "UNMATCHED_CLOSING_TAG");
});

test("crossed nesting closes the inner element", () => {
  const result = toJson("<b><i>x</b>y</i>");
  assert.deepEqual(result.children, [el("b", {}, [el("i", {}, [text("x")])]), text("y")]);
  assert.deepEqual(
    result.warnings.map((w) => w.code),
    ["IMPLICITLY_CLOSED", "UNMATCHED_CLOSING_TAG"],
  );
});

test("unclosed elements are closed at end of input", () => {
  const result = toJson("<div><p>text");
  assert.deepEqual(result.children, [el("div", {}, [el("p", {}, [text("text")])])]);
  // Only <div>: the end tag of <p> is optional in HTML.
  assert.deepEqual(
    result.warnings.map((w) => w.code),
    ["UNCLOSED_ELEMENT"],
  );
});

test("a tag cut off by the end of input is kept as text", () => {
  for (const tail of ["<div cla", '<div class="a', "<div class=", "</div", "<a b='x"]) {
    const result = toJson(`ok${tail}`);
    assert.deepEqual(result.children, [text(`ok${tail}`)], tail);
    assert.equal(result.warnings[0].code, "UNTERMINATED_TAG");
  }
});

test("unterminated comment and doctype", () => {
  assert.deepEqual(childrenOf("<!-- open"), [{ type: "comment", value: " open" }]);
  assert.deepEqual(warningCodes("<!-- open"), ["UNTERMINATED_COMMENT"]);
  assert.deepEqual(childrenOf("<!doctype html"), [{ type: "doctype", value: "html" }]);
});

test("unclosed script takes the rest of the input as text", () => {
  const result = toJson("<script>a<p>b</p>");
  assert.deepEqual(result.children, [el("script", {}, [text("a<p>b</p>")])]);
  assert.deepEqual(
    result.warnings.map((w) => w.code),
    ["UNCLOSED_ELEMENT"],
  );
});

test("odd closing tags", () => {
  assert.deepEqual(toJson("</>").children, []);
  assert.deepEqual(warningCodes("</>"), ["EMPTY_CLOSING_TAG"]);
  assert.deepEqual(childrenOf("</br>"), [el("br")]);
  assert.deepEqual(warningCodes("</img>"), ["VOID_CLOSING_TAG"]);
  assert.deepEqual(childrenOf("</ 1>"), [{ type: "comment", value: " 1" }]);
  assert.deepEqual(warningCodes('<p></p title=">">'), ["ATTRIBUTES_ON_CLOSING_TAG"]);
  assert.deepEqual(childrenOf("x</"), [text("x</")]);
});

test("warnings report 1-based line and column, sorted by position", () => {
  const warnings = html2json("<div>\n  </span>\n<a class=a class=b>").warnings;
  assert.deepEqual(
    warnings.map((w) => [w.code, w.line, w.column]),
    [
      ["UNCLOSED_ELEMENT", 1, 1],
      ["UNMATCHED_CLOSING_TAG", 2, 3],
      ["DUPLICATE_ATTRIBUTE", 3, 12],
      ["UNCLOSED_ELEMENT", 3, 1],
    ].sort((a, b) => a[1] - b[1] || a[2] - b[2]),
  );
});

test("the cap keeps the first warnings by position, whichever pass reported them", () => {
  // The builder's warnings (stray closing tags) come first in the file, the
  // tokenizer's (duplicate attributes) and unclosed elements come later.
  const html = "</x>".repeat(3000) + "<a b=1 b=2>".repeat(500);
  const warnings = html2json(html).warnings;
  const listed = warnings.slice(0, -1);
  assert.equal(listed.length, HTML2JSON_LIMITS.maxWarnings);
  assert.ok(listed.every((w) => w.code === "UNMATCHED_CLOSING_TAG"));
  assert.deepEqual([listed.at(-1).line, listed.at(-1).column], [1, 4 * (HTML2JSON_LIMITS.maxWarnings - 1) + 1]);
  assert.match(warnings.at(-1).message, /^3000 more/); // 3000 stray + 500 duplicates + 500 unclosed - 1000

  // The other way round: the tokenizer's warnings must not be crowded out either.
  const reversed = html2json("<a b=1 b=2>".repeat(1500) + "</x>".repeat(10)).warnings.slice(0, -1);
  assert.ok(reversed.every((w, i) => i === 0 || reversed[i - 1].column <= w.column || reversed[i - 1].line < w.line));
  assert.ok(
    reversed.some((w) => w.code === "DUPLICATE_ATTRIBUTE") && reversed.some((w) => w.code === "UNCLOSED_ELEMENT"),
  );
});

test("the number of warnings is capped", () => {
  const warnings = html2json("</x>".repeat(5000)).warnings;
  assert.equal(warnings.length, HTML2JSON_LIMITS.maxWarnings + 1);
  assert.equal(warnings[warnings.length - 1].code, "WARNINGS_TRUNCATED");
  assert.match(warnings[warnings.length - 1].message, /^4000 more/);
});

/* ------------------------------------------------------------------------ */
/* Browser rules added after the stress tests                               */
/* ------------------------------------------------------------------------ */

test("A: the line break right after <pre>, <listing> and <textarea> is dropped", () => {
  assert.deepEqual(childrenOf("<pre>\ncode\n</pre>"), [el("pre", {}, [text("code\n")])]);
  assert.deepEqual(childrenOf("<listing>\nx</listing>"), [el("listing", {}, [text("x")])]);
  assert.deepEqual(childrenOf("<textarea>\n\nx</textarea>"), [el("textarea", {}, [text("\nx")])]);
  assert.deepEqual(childrenOf("<pre class=a>\r\nx</pre>"), [el("pre", { class: "a" }, [text("x")])]);
  // Only one line break, only right after the tag, only for these tags.
  assert.deepEqual(childrenOf("<pre> \nx</pre>"), [el("pre", {}, [text(" \nx")])]);
  assert.deepEqual(childrenOf("<pre><!---->\nx</pre>"), [el("pre", {}, [{ type: "comment", value: "" }, text("\nx")])]);
  assert.deepEqual(childrenOf("<pre>\n</pre>"), [el("pre")]);
  assert.deepEqual(childrenOf("<code>\nx</code>"), [el("code", {}, [text("\nx")])]);
});

test("A: preserveWhitespace keeps the line break after <pre> as well", () => {
  assert.deepEqual(childrenOf("<pre>\nx</pre>", PRESERVE), [el("pre", {}, [text("\nx")])]);
  assert.deepEqual(childrenOf("<textarea>\nx</textarea>", PRESERVE), [el("textarea", {}, [text("\nx")])]);
});

test("B: common named references", () => {
  assert.deepEqual(
    childrenOf("&mdash;&ndash;&hellip;&laquo;&raquo;&ldquo;&rdquo;&trade;&reg;&euro;&rarr;&times;&deg;&frac12;"),
    [text("—–…«»“”™®€→×°½")],
  );
  assert.deepEqual(childrenOf("&AMP;&LT;&GT;&QUOT;&COPY;"), [text('&<>"©')]);
  // Case matters, as in browsers: "&Mdash;" is not a reference.
  assert.deepEqual(childrenOf("&Mdash;"), [text("&Mdash;")]);
});

test("B: legacy names work without the semicolon in text", () => {
  assert.deepEqual(childrenOf("&copy 2024 &amp &lt;x&gt"), [text("© 2024 & <x>")]);
  assert.deepEqual(childrenOf("&copy2024 &notit &ampx"), [text("©2024 ¬it &x")]);
  // Names that need ";" stay as written without it.
  assert.deepEqual(childrenOf("&mdash &hellip &euro"), [text("&mdash &hellip &euro")]);
  // An unknown name with ";" is not half-decoded by its legacy prefix.
  assert.deepEqual(childrenOf("&notin; &ltimes;"), [text("&notin; &ltimes;")]);
});

test("B: in attributes a reference without ; before a letter, digit or = stays", () => {
  const attributes = childrenOf('<a href="?a=1&copy=2&amp=3&lang=uk&x=&lt;" title="&copy 2024 &amp;">')[0].attributes;
  assert.deepEqual(attributes, { href: "?a=1&copy=2&amp=3&lang=uk&x=<", title: "© 2024 &" });
  assert.deepEqual(childrenOf('<a title="&copy">')[0].attributes, { title: "©" });
});

test("B: numeric references 128-159 are Windows-1252 characters", () => {
  assert.deepEqual(childrenOf("&#151;&#147;&#148;&#128;&#x99;&#133;"), [text("—“”€™…")]);
  assert.deepEqual(childrenOf("&#129;"), [text("\u0081")]);
});

test("C: <li>, <dt>, <dd> end at the next item", () => {
  assert.deepEqual(childrenOf("<ul><li>a<li>b</ul>"), [
    el("ul", {}, [el("li", {}, [text("a")]), el("li", {}, [text("b")])]),
  ]);
  assert.deepEqual(childrenOf("<dl><dt>a<dd>b<dt>c</dl>"), [
    el("dl", {}, [el("dt", {}, [text("a")]), el("dd", {}, [text("b")]), el("dt", {}, [text("c")])]),
  ]);
  // A nested list is its own scope.
  assert.deepEqual(childrenOf("<ul><li>a<ul><li>b<li>c</ul><li>d</ul>"), [
    el("ul", {}, [
      el("li", {}, [text("a"), el("ul", {}, [el("li", {}, [text("b")]), el("li", {}, [text("c")])])]),
      el("li", {}, [text("d")]),
    ]),
  ]);
  // <div> does not stop the search, as in browsers.
  assert.deepEqual(childrenOf("<li><div>a<li>b"), [
    el("li", {}, [el("div", {}, [text("a")])]),
    el("li", {}, [text("b")]),
  ]);
});

test("C: <p> ends at a block element or the next <p>", () => {
  assert.deepEqual(childrenOf("<p>a<p>b<div>c</div>"), [
    el("p", {}, [text("a")]),
    el("p", {}, [text("b")]),
    el("div", {}, [text("c")]),
  ]);
  assert.deepEqual(childrenOf("<p>a<h2>b</h2><p>c<ul><li>d</ul><p>e<hr>"), [
    el("p", {}, [text("a")]),
    el("h2", {}, [text("b")]),
    el("p", {}, [text("c")]),
    el("ul", {}, [el("li", {}, [text("d")])]),
    el("p", {}, [text("e")]),
    el("hr"),
  ]);
  // Inline elements stay inside, and a <button> keeps its own <p>.
  assert.deepEqual(childrenOf("<p>a<span>b</span>"), [el("p", {}, [text("a"), el("span", {}, [text("b")])])]);
  assert.deepEqual(childrenOf("<p><button><div>x</div></button>"), [
    el("p", {}, [el("button", {}, [el("div", {}, [text("x")])])]),
  ]);
});

test("C: table cells, rows and sections end at the next one", () => {
  assert.deepEqual(childrenOf("<table><tr><td>1<td>2<tr><th>3</table>"), [
    el("table", {}, [
      el("tr", {}, [el("td", {}, [text("1")]), el("td", {}, [text("2")])]),
      el("tr", {}, [el("th", {}, [text("3")])]),
    ]),
  ]);
  assert.deepEqual(childrenOf("<table><thead><tr><td>h<tbody><tr><td>b</table>"), [
    el("table", {}, [
      el("thead", {}, [el("tr", {}, [el("td", {}, [text("h")])])]),
      el("tbody", {}, [el("tr", {}, [el("td", {}, [text("b")])])]),
    ]),
  ]);
  // A table inside a cell is its own scope.
  assert.deepEqual(childrenOf("<table><tr><td><table><tr><td>in</table><td>out</table>"), [
    el("table", {}, [
      el("tr", {}, [
        el("td", {}, [el("table", {}, [el("tr", {}, [el("td", {}, [text("in")])])])]),
        el("td", {}, [text("out")]),
      ]),
    ]),
  ]);
});

test("C: <option> and <optgroup>", () => {
  assert.deepEqual(childrenOf("<select><option>a<option>b<optgroup><option>c<optgroup><option>d</select>"), [
    el("select", {}, [
      el("option", {}, [text("a")]),
      el("option", {}, [text("b")]),
      el("optgroup", {}, [el("option", {}, [text("c")])]),
      el("optgroup", {}, [el("option", {}, [text("d")])]),
    ]),
  ]);
});

test("C: omitted optional end tags are not warnings, other implicit closes are", () => {
  assert.deepEqual(warningCodes("<html><body><ul><li>a<li>b</ul><p>c<table><tr><td>d</table>"), []);
  assert.deepEqual(warningCodes("<div><p>a</div>"), []);
  assert.deepEqual(warningCodes("<li><b>x<li>y"), ["IMPLICITLY_CLOSED"]);
  assert.deepEqual(warningCodes("<p><i>x<div>y</div>"), ["IMPLICITLY_CLOSED"]);
  assert.deepEqual(warningCodes("<div>open"), ["UNCLOSED_ELEMENT"]);
});

test("C: thousands of omitted end tags stay fast and shallow", () => {
  const started = Date.now();
  const deep = html2json("<div>".repeat(20000) + "<ul>" + "<li>x".repeat(50000) + "<p>y".repeat(50000));
  assert.ok(Date.now() - started < 3000);
  assert.ok(assertValidShape(deep) <= HTML2JSON_LIMITS.maxDepth + 1);
  const flat = toJson("<ul>" + "<li>x".repeat(50000));
  assert.equal(flat.children[0].children.length, 50000);
});

/* ------------------------------------------------------------------------ */
/* Depth limit                                                              */
/* ------------------------------------------------------------------------ */

test("very deep nesting is capped and stays serializable", () => {
  const depth = 100000;
  const result = html2json(`${"<div>".repeat(depth)}deep${"</div>".repeat(depth)}`);
  assert.equal(assertValidShape(result), HTML2JSON_LIMITS.maxDepth + 1);
  assert.deepEqual(
    result.warnings.map((w) => w.code),
    ["MAX_DEPTH_EXCEEDED"],
  );
  assert.ok(JSON.stringify(result).includes('"deep"'));
});

test("nothing is lost past the depth limit", () => {
  const depth = HTML2JSON_LIMITS.maxDepth + 3;
  const html = `${"<div>".repeat(depth)}<b>x</b>${"</div>".repeat(depth)}after`;
  const serialized = JSON.stringify(html2json(html));
  assert.equal(serialized.split('"tag":"div"').length - 1, depth);
  assert.ok(serialized.includes('"tag":"b"'));
  assert.deepEqual(toJson(html).children.at(-1), text("after"));
});

/* ------------------------------------------------------------------------ */
/* Sample files                                                             */
/* ------------------------------------------------------------------------ */

test("every file in html_samples/ and html_samples/stress/ converts and serializes", () => {
  const files = [SAMPLES_DIR, path.join(SAMPLES_DIR, "stress")].flatMap((dir) =>
    fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".html"))
      .map((name) => path.join(dir, name)),
  );
  assert.ok(files.length >= 50);
  for (const file of files) {
    // Decoded like the browser's File#text(): invalid bytes become U+FFFD.
    const html = new TextDecoder().decode(fs.readFileSync(file));
    for (const options of [undefined, PRESERVE]) {
      const result = html2json(html, options);
      assertValidShape(result);
      assert.ok(!result.warnings.some((w) => w.code === "INTERNAL_ERROR"), file);
      const { text } = stringifyResult(result);
      assert.doesNotThrow(() => JSON.parse(text), file);
    }
  }
});

test("large sample: every table row is found", () => {
  const html = fs.readFileSync(path.join(SAMPLES_DIR, "13-large-table.html"), "utf8");
  const serialized = JSON.stringify(html2json(html));
  assert.equal(serialized.split('"tag":"tr"').length - 1, 6000);
});

/* ------------------------------------------------------------------------ */
/* Round trip on random well-formed trees                                   */
/* ------------------------------------------------------------------------ */

// Serializes a tree back to HTML, escaping what the parser decodes.
function serialize(nodes) {
  const escapeText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const escapeAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return nodes
    .map((node) => {
      if (node.type === "text") return escapeText(node.value);
      if (node.type === "comment") return `<!--${node.value}-->`;
      const attrs = Object.entries(node.attributes)
        .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
        .join("");
      return `<${node.tag}${attrs}>${serialize(node.children)}</${node.tag}>`;
    })
    .join("");
}

// Only valid nesting is generated: inside <p> only phrasing elements (a
// <div> there would end the <p>), and <li> only directly inside <ul>.
function randomTree(random, depth, parent = null, phrasingOnly = false) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const phrasing = ["span", "a", "b", "custom-el"];
  const tags = phrasingOnly
    ? phrasing
    : ["div", "p", "ul", "section", "pre", ...phrasing, ...(parent === "ul" ? ["li", "li", "li"] : [])];
  const words = ["a", "b c", " ", "\n", "&", "<", ">", '"', "'", "привіт", "😀", "=", "/"];
  const nodes = [];
  const count = Math.floor(random() * 4);
  for (let i = 0; i < count; i += 1) {
    const kind = random();
    const last = nodes[nodes.length - 1];
    if (kind < 0.4) {
      const value = pick(words) + pick(words);
      if (last && last.type === "text")
        last.value += value; // parser merges adjacent text
      else nodes.push(text(value));
    } else if (kind < 0.5) {
      nodes.push({ type: "comment", value: pick(["", " c ", "a-b", "<x>"]) });
    } else if (depth < 6) {
      const attributes = {};
      if (random() < 0.5) attributes.class = pick(words);
      if (random() < 0.3) attributes["data-x"] = pick(words) + pick(words);
      const tag = pick(tags);
      nodes.push(el(tag, attributes, randomTree(random, depth + 1, tag, phrasingOnly || tag === "p")));
    }
  }
  return nodes;
}

// The tree the default mode should produce: formatting text nodes removed
// everywhere except inside whitespace-sensitive elements.
// Also drops the line break that starts a <pre>, as browsers do.
function withoutFormattingWhitespace(nodes, insideSensitive = false, parentTag = null) {
  if (parentTag === "pre" && nodes[0] && nodes[0].type === "text" && nodes[0].value.startsWith("\n")) {
    const rest = nodes[0].value.slice(1);
    nodes = rest === "" ? nodes.slice(1) : [text(rest), ...nodes.slice(1)];
  }
  return nodes
    .filter((node) => insideSensitive || node.type !== "text" || !/^[\t\n\f\r ]*\n[\t\n\f\r ]*$/.test(node.value))
    .map((node) =>
      node.type === "element"
        ? {
            ...node,
            children: withoutFormattingWhitespace(node.children, insideSensitive || node.tag === "pre", node.tag),
          }
        : node,
    );
}

test("round trip with preserveWhitespace: parse(serialize(tree)) is the same tree", () => {
  const random = createRandom(2026);
  for (let i = 0; i < 2000; i += 1) {
    const tree = randomTree(random, 0);
    const html = serialize(tree);
    const result = toJson(html, PRESERVE);
    assert.deepEqual(result.children, tree, html);
    assert.deepEqual(result.warnings, [], html);
  }
});

test("round trip by default: the same tree minus formatting whitespace", () => {
  const random = createRandom(7);
  for (let i = 0; i < 2000; i += 1) {
    const tree = randomTree(random, 0);
    const html = serialize(tree);
    const result = toJson(html);
    assert.deepEqual(result.children, withoutFormattingWhitespace(tree), html);
    assert.deepEqual(result.warnings, [], html);
  }
});

/* ------------------------------------------------------------------------ */
/* Fuzzing: random garbage must never crash                                 */
/* ------------------------------------------------------------------------ */

test("fuzz: random markup-like input never throws", () => {
  const random = createRandom(42);
  const pieces = [
    "<",
    ">",
    "/",
    "!",
    "-",
    "--",
    "<!--",
    "-->",
    "<!",
    "<?",
    "</",
    "/>",
    "=",
    '"',
    "'",
    "&",
    ";",
    "#",
    "x",
    "&amp;",
    "&#",
    "&#x",
    "div",
    "p",
    "script",
    "textarea",
    "style",
    "br",
    " ",
    "\n",
    "\r",
    "\t",
    "a",
    "<div>",
    "</div>",
    "<script>",
    "</script>",
    "<p class=",
    "DOCTYPE",
    "[CDATA[",
    "]]>",
    "﻿",
    "\u0000",
    "😀",
    "\uD800",
    "__proto__",
    "constructor",
  ];
  for (let i = 0; i < 5000; i += 1) {
    let input = "";
    const length = Math.floor(random() * 60);
    for (let j = 0; j < length; j += 1) input += pieces[Math.floor(random() * pieces.length)];
    let result;
    assert.doesNotThrow(() => {
      result = html2json(input, i % 2 === 0 ? undefined : PRESERVE);
    }, JSON.stringify(input));
    assertValidShape(result);
    assert.ok(!result.warnings.some((w) => w.code === "INTERNAL_ERROR"), JSON.stringify(input));
  }
});

/* ------------------------------------------------------------------------ */
/* Size and speed                                                           */
/* ------------------------------------------------------------------------ */

function assertFast(label, html, maxMs) {
  const started = process.hrtime.bigint();
  const result = html2json(html);
  JSON.stringify(result);
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsed < maxMs, `${label}: ${elapsed.toFixed(0)} ms (limit ${maxMs} ms)`);
  return result;
}

test("performance: large and pathological inputs stay linear", () => {
  const row = '<tr class="r"><td>cell &amp; text</td><td><a href="/x?a=1&amp;b=2">link</a></td></tr>\n';
  const tenMb = `<table>${row.repeat(Math.ceil(10e6 / row.length))}</table>`;
  assertFast("10 MB table", tenMb, 6000);

  const longText = `<textarea>${"very ".repeat(2e6)}</textarea>`;
  assertFast("10 MB single text node", longText, 3000);

  assertFast("500k lone '<'", "< ".repeat(5e5), 3000);
  assertFast("deep stack + many unmatched closing tags", "<div>".repeat(5e4) + "</x>".repeat(5e4), 3000);
  assertFast("many unclosed elements", "<b>".repeat(2e5), 3000);
  assertFast("script with many false closing tags", `<script>${"</scrip ".repeat(2e5)}</script>`, 3000);
  assertFast("unterminated attribute quotes", `<a b="${"x".repeat(5e6)}`, 3000);
});

/* ------------------------------------------------------------------------ */
/* Turning the result into text                                             */
/* ------------------------------------------------------------------------ */

test("small results are pretty-printed exactly like JSON.stringify(result, null, 2)", () => {
  const result = html2json(EXAMPLE_HTML_1);
  assert.deepEqual(stringifyResult(result), { text: JSON.stringify(result, null, 2), pretty: true });
});

test("the indentation estimate is close to the real size", () => {
  for (const html of [EXAMPLE_HTML_1, EXAMPLE_HTML_2, "<a x=1 y=2><b>t</b><!--c--></a>", "<div>".repeat(600)]) {
    const result = html2json(html);
    const real = JSON.stringify(result, null, 2).length - JSON.stringify(result).length;
    const estimate = estimatePrettyIndentation(result, Infinity);
    assert.ok(Math.abs(estimate - real) / real < 0.15, `${estimate} vs ${real}`);
  }
});

test("deep results fall back to compact JSON instead of crashing", () => {
  // Pretty-printing this needs about 1 GB and throws "Invalid string length".
  const result = html2json("<div>".repeat(100000));
  const started = Date.now();
  const { text, pretty } = stringifyResult(result);
  assert.equal(pretty, false);
  assert.equal(text, JSON.stringify(result));
  assert.ok(Date.now() - started < 3000);
});

test("long text is shortened for display with a note", () => {
  assert.equal(textForDisplay("abc", 10), "abc");
  const shown = textForDisplay("x".repeat(OUTPUT_LIMITS.display + 10));
  assert.ok(shown.startsWith("x".repeat(OUTPUT_LIMITS.display)));
  assert.match(shown, /output shortened for display/);
});

/* ------------------------------------------------------------------------ */
/* Page integration                                                         */
/* ------------------------------------------------------------------------ */

// Runs convertHtml2JsonAndSet() from html2json.js against a stand-in for the
// two text areas of index.html.
function runIndexPage(html) {
  const vm = require("node:vm");
  const fields = { html: { value: html }, json: { textContent: "" } };
  const context = vm.createContext({ document: { getElementById: (id) => fields[id] } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "html2json.js"), "utf8"), context);
  vm.runInContext("convertHtml2JsonAndSet()", context);
  return fields.json.textContent;
}

test("index.html: the Convert button never throws, even on huge or deep input", () => {
  assert.deepEqual(JSON.parse(runIndexPage(EXAMPLE_HTML_2)), JSON.parse(JSON.stringify(html2json(EXAMPLE_HTML_2))));
  for (const html of ["", "<div>".repeat(100000), `<p>${"word ".repeat(2e6)}</p>`]) {
    let output;
    assert.doesNotThrow(() => {
      output = runIndexPage(html);
    });
    assert.ok(output.length <= OUTPUT_LIMITS.display + 200);
  }
});

test("functions used by the provided index.html still exist", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "html2json.js"), "utf8");
  for (const name of ["convertHtml2JsonAndSet", "showExample1", "showExample2", "html2json"]) {
    assert.match(source, new RegExp(`function ${name}\\(`));
  }
});
