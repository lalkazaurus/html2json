/*
 * html2json — converts an HTML string into a JSON tree.
 *
 * No DOM parser is used: the input is read by a hand-written single-pass
 * tokenizer, and the tree is assembled by an iterative (stack-based) builder.
 *
 * Output format (see README.md for the reasoning behind every choice):
 *
 *   { type: "document", children: Node[], warnings: Warning[] }
 *
 *   Node =
 *     | { type: "element", tag, attributes: { [name]: value }, children: Node[] }
 *     | { type: "text",    value }
 *     | { type: "comment", value }
 *     | { type: "doctype", value }
 *
 *   Warning = { code, message, line, column }   // line/column are 1-based, or null
 *
 * Options (second argument, optional):
 *
 *   preserveWhitespace: boolean (default false)
 *     false - formatting whitespace is dropped: a text node made only of
 *             whitespace that contains a line break (indentation between
 *             tags). Spaces on one line ("<b>a</b> <i>b</i>") are kept, and
 *             nothing inside pre/textarea/script/style... is touched.
 *     true  - every text node is kept exactly as in the input.
 *
 * The function never throws: problems in the input are reported as warnings,
 * and the best possible tree is still returned.
 */
"use strict";

/* ------------------------------------------------------------------------ */
/* Configuration                                                            */
/* ------------------------------------------------------------------------ */

const HTML2JSON_LIMITS = Object.freeze({
  // Each element adds two levels of nesting to the JSON (object + children
  // array). JSON.stringify is recursive, so an unbounded depth would crash it
  // with "Maximum call stack size exceeded". 500 is far beyond real pages.
  maxDepth: 500,
  // Garbage input can produce a warning for nearly every character.
  // Keeping the first N is enough to diagnose the problem.
  maxWarnings: 1000,
});

// Elements that never have content or a closing tag.
// The last five are obsolete, but browsers still parse them as void.
// prettier-ignore
// prettier-ignore
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "source", "track", "wbr",
  "param", "keygen", "frame", "basefont", "bgsound",
]);

// Content is plain text up to the matching closing tag; entities are NOT decoded.
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes"]);

// Content is plain text up to the matching closing tag; entities ARE decoded.
const ESCAPABLE_RAW_TEXT_ELEMENTS = new Set(["textarea", "title"]);

// Inside these every whitespace character matters, so formatting whitespace
// is never removed from them (or from anything nested in them).
const WHITESPACE_SENSITIVE_ELEMENTS = new Set(["pre", "listing", ...RAW_TEXT_ELEMENTS, ...ESCAPABLE_RAW_TEXT_ELEMENTS]);

// A line break right after these start tags is source formatting, so
// browsers drop it ("<pre>\ncode" shows "code"). Dropped in the default mode.
const LEADING_NEWLINE_ELEMENTS = new Set(["pre", "listing", "textarea"]);

const DEFAULT_OPTIONS = Object.freeze({ preserveWhitespace: false });

/*
 * Character references. Not the full HTML table (2231 names): the ones that
 * actually show up in pages. Unknown names are left as written.
 *
 * LEGACY_ENTITIES are the old names browsers also accept WITHOUT the ";"
 * ("&copy 2024", "&amp" in old URLs). OTHER_ENTITIES need the ";".
 * Maps (not plain objects) so "&constructor;" or "&__proto__;" cannot
 * resolve to inherited Object.prototype members.
 */
// prettier-ignore
// prettier-ignore
const LEGACY_ENTITIES = new Map([
  ["amp", "&"], ["AMP", "&"], ["lt", "<"], ["LT", "<"], ["gt", ">"], ["GT", ">"],
  ["quot", '"'], ["QUOT", '"'], ["nbsp", " "], ["copy", "©"], ["COPY", "©"],
  ["reg", "®"], ["REG", "®"], ["iexcl", "¡"], ["cent", "¢"], ["pound", "£"],
  ["curren", "¤"], ["yen", "¥"], ["brvbar", "¦"], ["sect", "§"], ["uml", "¨"],
  ["ordf", "ª"], ["laquo", "«"], ["not", "¬"], ["shy", "­"], ["macr", "¯"],
  ["deg", "°"], ["plusmn", "±"], ["sup2", "²"], ["sup3", "³"], ["acute", "´"],
  ["micro", "µ"], ["para", "¶"], ["middot", "·"], ["cedil", "¸"], ["sup1", "¹"],
  ["ordm", "º"], ["raquo", "»"], ["frac14", "¼"], ["frac12", "½"], ["frac34", "¾"],
  ["iquest", "¿"], ["times", "×"], ["divide", "÷"],
]);

// prettier-ignore
// prettier-ignore
const OTHER_ENTITIES = new Map([
  ["apos", "'"], ["ndash", "–"], ["mdash", "—"], ["hellip", "…"], ["bull", "•"],
  ["lsquo", "‘"], ["rsquo", "’"], ["sbquo", "‚"], ["ldquo", "“"], ["rdquo", "”"],
  ["bdquo", "„"], ["lsaquo", "‹"], ["rsaquo", "›"], ["prime", "′"], ["Prime", "″"],
  ["dagger", "†"], ["Dagger", "‡"], ["permil", "‰"], ["trade", "™"], ["euro", "€"],
  ["larr", "←"], ["uarr", "↑"], ["rarr", "→"], ["darr", "↓"], ["harr", "↔"],
  ["hearts", "♥"], ["check", "✓"], ["minus", "−"], ["ne", "≠"], ["le", "≤"],
  ["ge", "≥"], ["infin", "∞"], ["asymp", "≈"], ["ensp", " "], ["emsp", " "],
  ["thinsp", " "], ["zwnj", "‌"], ["zwj", "‍"], ["lrm", "‎"], ["rlm", "‏"],
]);

const LEGACY_NAME_MAX_LENGTH = 6;

// Numeric references to 0x80-0x9F mean Windows-1252 characters in practice
// ("&#151;" is an em dash), and browsers decode them that way.
// prettier-ignore
// prettier-ignore
const WINDOWS_1252 = new Map([
  [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e], [0x85, 0x2026],
  [0x86, 0x2020], [0x87, 0x2021], [0x88, 0x02c6], [0x89, 0x2030], [0x8a, 0x0160],
  [0x8b, 0x2039], [0x8c, 0x0152], [0x8e, 0x017d], [0x91, 0x2018], [0x92, 0x2019],
  [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014],
  [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a], [0x9c, 0x0153],
  [0x9e, 0x017e], [0x9f, 0x0178],
]);

/*
 * Optional end tags. Real pages often leave out </li>, </p>, </td>...; the
 * HTML spec says when such an element ends, and browsers follow it. A start
 * tag closes an open element of the listed kinds when it is "in scope": no
 * element from the rule's scope list is open above it.
 */
// From the spec's list of "special" elements: they stop the search for an
// open <li>, <dt> or <dd> (address, div and p do not).
// prettier-ignore
// prettier-ignore
const LIST_ITEM_SCOPE = [
  "applet", "area", "article", "aside", "base", "basefont", "bgsound", "blockquote", "body",
  "button", "caption", "center", "col", "colgroup", "details", "dir", "dl", "embed",
  "fieldset", "figcaption", "figure", "footer", "form", "frame", "frameset", "h1", "h2", "h3",
  "h4", "h5", "h6", "head", "header", "hgroup", "html", "iframe", "listing", "main", "marquee",
  "menu", "nav", "noembed", "noframes", "noscript", "object", "ol", "plaintext", "pre",
  "script", "search", "section", "select", "style", "summary", "table", "tbody", "td",
  "template", "textarea", "tfoot", "th", "thead", "title", "tr", "ul", "xmp",
];
const BUTTON_SCOPE = ["applet", "button", "caption", "html", "marquee", "object", "table", "td", "template", "th"];
const TABLE_SCOPE = ["html", "table", "template"];

// Start tags that end an open <p>.
// prettier-ignore
// prettier-ignore
const CLOSES_P = new Set([
  "address", "article", "aside", "blockquote", "center", "details", "dialog", "dir", "div",
  "dl", "dd", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3",
  "h4", "h5", "h6", "header", "hgroup", "hr", "li", "listing", "main", "menu", "nav", "ol",
  "p", "plaintext", "pre", "search", "section", "summary", "table", "ul", "xmp",
]);

// start tag -> { closes: tags it ends, scope: tags that stop the search }
const IMPLIED_END_RULES = new Map([
  ["li", { closes: ["li"], scope: LIST_ITEM_SCOPE }],
  ["dt", { closes: ["dt", "dd"], scope: LIST_ITEM_SCOPE }],
  ["dd", { closes: ["dt", "dd"], scope: LIST_ITEM_SCOPE }],
  ["td", { closes: ["td", "th"], scope: TABLE_SCOPE }],
  ["th", { closes: ["td", "th"], scope: TABLE_SCOPE }],
  ["tr", { closes: ["tr"], scope: TABLE_SCOPE }],
  ["thead", { closes: ["thead", "tbody", "tfoot"], scope: TABLE_SCOPE }],
  ["tbody", { closes: ["thead", "tbody", "tfoot"], scope: TABLE_SCOPE }],
  ["tfoot", { closes: ["thead", "tbody", "tfoot"], scope: TABLE_SCOPE }],
]);

// Elements whose end tag may be left out: closing them implicitly is valid
// HTML, so it is not reported. Anything else closed implicitly still is.
// prettier-ignore
// prettier-ignore
const OPTIONAL_END_TAG = new Set([
  "html", "head", "body", "p", "li", "dt", "dd", "td", "th", "tr", "thead", "tbody",
  "tfoot", "caption", "colgroup", "option", "optgroup", "rb", "rt", "rtc", "rp",
]);

/* ------------------------------------------------------------------------ */
/* Small helpers                                                            */
/* ------------------------------------------------------------------------ */

// HTML whitespace: tab, line feed, form feed, carriage return, space.
function isHtmlWhitespace(code) {
  return code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d || code === 0x20;
}

// Only HTML whitespace counts: a no-break space (&nbsp;) is visible content.
// A line break inside is what marks it as formatting rather than a meaningful
// space between words, the same rule JSX uses.
const FORMATTING_WHITESPACE = /^[\t\n\f\r ]*\n[\t\n\f\r ]*$/;

function isFormattingWhitespace(text) {
  return FORMATTING_WHITESPACE.test(text);
}

function isAsciiAlpha(code) {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

// Only ASCII letters are lowercased, as the HTML spec does. String#toLowerCase
// would also change some non-ASCII characters (e.g. "İ" becomes two chars).
function asciiLowerCase(text) {
  return text.replace(/[A-Z]+/g, (match) => match.toLowerCase());
}

const ENTITY_PATTERN = /&(?:#([0-9]+);?|#[xX]([0-9a-fA-F]+);?|([a-zA-Z][a-zA-Z0-9]*)(;?))/g;

/**
 * Decodes character references, following the browser rules for the
 * supported names:
 *   - "&name;" is decoded when the name is known;
 *   - without ";" only the legacy names are decoded, as the longest legacy
 *     prefix ("&copy2024" -> "©2024", "&notit" -> "¬it");
 *   - in attribute values a reference without ";" followed by a letter,
 *     digit or "=" stays as written, so URLs like "?a=1&copy=2" survive;
 *   - numeric references work with or without ";".
 * An unknown name followed by ";" ("&notin;") is left as written instead of
 * being decoded by its legacy prefix: it is a real reference this table
 * does not have, and half-decoding it would be worse than keeping it.
 */
function decodeEntities(text, inAttribute = false) {
  if (text.indexOf("&") === -1) return text;

  return text.replace(ENTITY_PATTERN, (match, decimal, hex, name, semicolon, offset) => {
    if (name === undefined) {
      const codePoint = decimal !== undefined ? parseInt(decimal, 10) : parseInt(hex, 16);
      return codePointToString(codePoint);
    }
    if (semicolon) {
      if (LEGACY_ENTITIES.has(name)) return LEGACY_ENTITIES.get(name);
      if (OTHER_ENTITIES.has(name)) return OTHER_ENTITIES.get(name);
      return match;
    }
    for (let length = Math.min(name.length, LEGACY_NAME_MAX_LENGTH); length >= 2; length -= 1) {
      const prefix = name.slice(0, length);
      if (!LEGACY_ENTITIES.has(prefix)) continue;
      if (inAttribute && (length < name.length || text[offset + match.length] === "=")) return match;
      return LEGACY_ENTITIES.get(prefix) + name.slice(length);
    }
    return match;
  });
}

// Invalid code points (zero, surrogates, beyond Unicode) become U+FFFD,
// which is what browsers do; String.fromCodePoint would throw on some of them.
function codePointToString(codePoint) {
  if (WINDOWS_1252.has(codePoint)) return String.fromCodePoint(WINDOWS_1252.get(codePoint));
  const isInvalid =
    !Number.isFinite(codePoint) ||
    codePoint === 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff);
  return isInvalid ? "�" : String.fromCodePoint(codePoint);
}

/**
 * Returns a function that turns a character offset into a 1-based
 * { line, column }. Line starts are computed lazily, only when the first
 * warning needs them, and then looked up with a binary search.
 */
function createLocator(input) {
  let lineStarts = null;

  return function locate(offset) {
    if (lineStarts === null) {
      lineStarts = [0];
      for (let i = input.indexOf("\n"); i !== -1; i = input.indexOf("\n", i + 1)) {
        lineStarts.push(i + 1);
      }
    }
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return { line: low + 1, column: offset - lineStarts[low] + 1 };
  };
}

/**
 * Collects warnings and keeps the first "maxWarnings" of them by position in
 * the input, whichever pass reported them.
 *
 * Warnings come from several streams (the tokenizer, the tree builder, the
 * final report of unclosed elements). Each stream reports in increasing
 * position order, but the streams run one after another, so a plain "keep the
 * first N added" would let an early pass fill the list with warnings from the
 * end of the file. Instead every stream keeps its own first N (its earliest
 * ones), and finish() merges them and keeps the overall first N. Memory stays
 * bounded by streams × N.
 */
function createWarningCollector(locate, maxWarnings) {
  const streams = [];
  let total = 0;

  return {
    // Every stream must report in non-decreasing position order.
    stream() {
      const kept = [];
      streams.push(kept);
      return {
        add(code, message, offset) {
          total += 1;
          if (kept.length < maxWarnings) kept.push({ code, message, offset });
        },
      };
    },

    finish() {
      // Warnings without a position (about the arguments) come first.
      // Array#sort is stable: equal positions keep the order of the streams.
      const order = (offset) => (offset === null ? -1 : offset);
      const first = streams
        .flat()
        .sort((a, b) => order(a.offset) - order(b.offset))
        .slice(0, maxWarnings);

      const list = first.map(({ code, message, offset }) => {
        const position = offset === null ? { line: null, column: null } : locate(offset);
        return { code, message, line: position.line, column: position.column };
      });
      if (total > list.length) {
        list.push({
          code: "WARNINGS_TRUNCATED",
          message: `${total - list.length} more warning(s) were not listed (limit is ${maxWarnings}).`,
          line: null,
          column: null,
        });
      }
      return list;
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Tokenizer: string -> flat list of tokens                                 */
/* ------------------------------------------------------------------------ */

/*
 * Token kinds:
 *   { kind: "text",     value, start }
 *   { kind: "comment",  value, start }
 *   { kind: "doctype",  value, start }
 *   { kind: "startTag", name, attributes, selfClosing, start }
 *   { kind: "endTag",   name, start }
 *
 * "start" is the offset of the token in the input, used for warning positions.
 */
class Tokenizer {
  constructor(input, warnings, options = DEFAULT_OPTIONS) {
    this.input = input;
    this.length = input.length;
    this.warnings = warnings;
    this.dropLeadingNewline = !options.preserveWhitespace;
    this.tokens = [];
  }

  run() {
    const { input } = this;
    let position = 0;

    while (position < this.length) {
      const tagOpen = input.indexOf("<", position);
      if (tagOpen === -1) {
        this.pushText(decodeEntities(input.slice(position)), position);
        break;
      }
      if (tagOpen > position) {
        this.pushText(decodeEntities(input.slice(position, tagOpen)), position);
      }
      position = this.readMarkup(tagOpen);
    }
    return this.tokens;
  }

  /* --- emitting ---------------------------------------------------------- */

  // Adjacent text pieces (e.g. "a < b" is read as "a ", "<", " b") are merged.
  pushText(value, start) {
    if (value === "") return;
    const last = this.tokens[this.tokens.length - 1];
    if (last !== undefined && last.kind === "text") {
      last.value += value;
    } else {
      this.tokens.push({ kind: "text", value, start });
    }
  }

  // Input that looks like a tag but is cut off by the end of the input is kept
  // as text, so nothing the user wrote silently disappears.
  pushUnterminated(start, what) {
    this.warnings.add(
      "UNTERMINATED_TAG",
      `${what} is not closed with ">" before the end of input; kept as text.`,
      start,
    );
    this.pushText(this.input.slice(start), start);
    return this.length;
  }

  /* --- dispatch at "<" --------------------------------------------------- */

  readMarkup(start) {
    const { input } = this;
    const next = input.charCodeAt(start + 1);

    if (input.startsWith("<!--", start)) return this.readComment(start);
    if (next === 0x21 /* ! */) return this.readDeclaration(start);
    if (next === 0x3f /* ? */) return this.readBogusComment(start, start + 1);
    if (next === 0x2f /* / */) return this.readEndTag(start);
    if (isAsciiAlpha(next)) return this.readStartTag(start);

    // "<" not followed by a tag name ("a < b", "<3", "< div>") is plain text.
    this.pushText("<", start);
    return start + 1;
  }

  /* --- comments, doctype, other "<!...>" --------------------------------- */

  readComment(start) {
    const { input } = this;
    const bodyStart = start + 4;

    // "<!-->" and "<!--->" are complete (empty) comments in HTML.
    if (input.startsWith(">", bodyStart)) return this.emitComment("", start, bodyStart + 1);
    if (input.startsWith("->", bodyStart)) return this.emitComment("", start, bodyStart + 2);

    const regularEnd = input.indexOf("-->", bodyStart);
    const bangEnd = input.indexOf("--!>", bodyStart);
    let end = regularEnd;
    let closerLength = 3;
    if (bangEnd !== -1 && (regularEnd === -1 || bangEnd < regularEnd)) {
      end = bangEnd;
      closerLength = 4;
    }

    if (end === -1) {
      this.warnings.add(
        "UNTERMINATED_COMMENT",
        'Comment is not closed with "-->"; it runs to the end of input.',
        start,
      );
      return this.emitComment(input.slice(bodyStart), start, this.length);
    }
    return this.emitComment(input.slice(bodyStart, end), start, end + closerLength);
  }

  readDeclaration(start) {
    const { input } = this;
    const keyword = input.slice(start + 2, start + 9);

    if (asciiLowerCase(keyword) !== "doctype") {
      // "<![CDATA[...]]>" and other "<!...>" constructs: HTML treats them as comments.
      return this.readBogusComment(start, start + 2);
    }

    const end = input.indexOf(">", start + 9);
    const rawValue = end === -1 ? input.slice(start + 9) : input.slice(start + 9, end);
    if (end === -1) {
      this.warnings.add("UNTERMINATED_DOCTYPE", 'DOCTYPE is not closed with ">".', start);
    }
    const value = rawValue.trim().replace(/\s+/g, " ");
    this.tokens.push({ kind: "doctype", value, start });
    return end === -1 ? this.length : end + 1;
  }

  readBogusComment(start, contentStart) {
    const end = this.input.indexOf(">", contentStart);
    const value = end === -1 ? this.input.slice(contentStart) : this.input.slice(contentStart, end);
    const opener = this.input.slice(start, contentStart);
    const preview = value.length > 20 ? `${value.slice(0, 20)}...` : value;
    this.warnings.add(
      "BOGUS_COMMENT",
      `"${opener}${preview.replace(/\s+/g, " ")}" is not valid HTML markup; stored as a comment.`,
      start,
    );
    return this.emitComment(value, start, end === -1 ? this.length : end + 1);
  }

  emitComment(value, start, nextPosition) {
    this.tokens.push({ kind: "comment", value, start });
    return nextPosition;
  }

  /* --- tags -------------------------------------------------------------- */

  readTagName(position) {
    const { input } = this;
    const nameStart = position;
    while (position < this.length) {
      const code = input.charCodeAt(position);
      if (isHtmlWhitespace(code) || code === 0x2f /* / */ || code === 0x3e /* > */) break;
      position += 1;
    }
    return { name: asciiLowerCase(input.slice(nameStart, position)), end: position };
  }

  readStartTag(start) {
    const { name, end: nameEnd } = this.readTagName(start + 1);
    const parsed = this.readAttributes(nameEnd, true);
    if (parsed === null) return this.pushUnterminated(start, `Tag <${name}`);

    this.tokens.push({
      kind: "startTag",
      name,
      attributes: parsed.attributes,
      selfClosing: parsed.selfClosing,
      start,
    });

    let end = parsed.end;
    if (!parsed.selfClosing) {
      if (this.dropLeadingNewline && LEADING_NEWLINE_ELEMENTS.has(name) && this.input.charCodeAt(end) === 0x0a) {
        end += 1;
      }
      if (RAW_TEXT_ELEMENTS.has(name)) return this.readRawText(name, end, false);
      if (ESCAPABLE_RAW_TEXT_ELEMENTS.has(name)) return this.readRawText(name, end, true);
    }
    return end;
  }

  readEndTag(start) {
    const { input } = this;
    const nameStartCode = input.charCodeAt(start + 2);

    if (start + 2 >= this.length) {
      this.pushText("</", start);
      return this.length;
    }
    if (nameStartCode === 0x3e /* > */) {
      this.warnings.add("EMPTY_CLOSING_TAG", '"</>" has no tag name; ignored.', start);
      return start + 3;
    }
    if (!isAsciiAlpha(nameStartCode)) {
      return this.readBogusComment(start, start + 2);
    }

    const { name, end: nameEnd } = this.readTagName(start + 2);
    // Attributes on a closing tag are meaningless, but they are still read
    // properly so that a ">" inside a quoted value does not end the tag early.
    const parsed = this.readAttributes(nameEnd, false);
    if (parsed === null) return this.pushUnterminated(start, `Closing tag </${name}`);
    if (Object.keys(parsed.attributes).length > 0) {
      this.warnings.add("ATTRIBUTES_ON_CLOSING_TAG", `Closing tag </${name}> has attributes; they are ignored.`, start);
    }

    this.tokens.push({ kind: "endTag", name, start });
    return parsed.end;
  }

  /**
   * Reads attributes up to and including the closing ">" or "/>".
   * Returns { attributes, selfClosing, end } or null if the input ends first.
   */
  readAttributes(position, reportDuplicates) {
    const { input } = this;
    // No prototype: an attribute called "__proto__" or "constructor" becomes
    // a normal key instead of touching Object.prototype.
    const attributes = Object.create(null);

    for (;;) {
      position = this.skipWhitespace(position);
      if (position >= this.length) return null;

      const code = input.charCodeAt(position);
      if (code === 0x3e /* > */) {
        return { attributes, selfClosing: false, end: position + 1 };
      }
      if (code === 0x2f /* / */) {
        if (input.charCodeAt(position + 1) === 0x3e) {
          return { attributes, selfClosing: true, end: position + 2 };
        }
        position += 1; // a stray "/" between attributes is ignored
        continue;
      }

      // Name: the first character is always taken (even "="), then everything
      // up to whitespace, "/", ">" or "=".
      const nameStart = position;
      position += 1;
      while (position < this.length) {
        const c = input.charCodeAt(position);
        if (isHtmlWhitespace(c) || c === 0x2f || c === 0x3e || c === 0x3d /* = */) break;
        position += 1;
      }
      const name = asciiLowerCase(input.slice(nameStart, position));

      // Value is optional; a boolean attribute gets "" as in the DOM.
      let value = "";
      position = this.skipWhitespace(position);
      if (input.charCodeAt(position) === 0x3d /* = */) {
        position = this.skipWhitespace(position + 1);
        if (position >= this.length) return null;

        const quote = input[position];
        if (quote === '"' || quote === "'") {
          const closingQuote = input.indexOf(quote, position + 1);
          if (closingQuote === -1) return null;
          value = input.slice(position + 1, closingQuote);
          position = closingQuote + 1;
        } else {
          const valueStart = position;
          while (position < this.length) {
            const c = input.charCodeAt(position);
            if (isHtmlWhitespace(c) || c === 0x3e) break;
            position += 1;
          }
          value = input.slice(valueStart, position);
        }
        value = decodeEntities(value, true);
      }

      // The first occurrence wins, as in browsers.
      if (Object.prototype.hasOwnProperty.call(attributes, name)) {
        if (reportDuplicates) {
          this.warnings.add(
            "DUPLICATE_ATTRIBUTE",
            `Attribute "${name}" is repeated; the first value is kept.`,
            nameStart,
          );
        }
      } else {
        attributes[name] = value;
      }
    }
  }

  /**
   * Content of <script>, <style>, <textarea>, <title>... is not markup:
   * everything up to the matching closing tag is a single text node.
   */
  readRawText(tagName, position, decode) {
    const { input } = this;
    let searchFrom = position;

    for (;;) {
      const candidate = input.indexOf("</", searchFrom);
      if (candidate === -1) {
        const text = input.slice(position);
        this.pushText(decode ? decodeEntities(text) : text, position);
        return this.length; // the builder reports the unclosed element
      }

      const nameEnd = candidate + 2 + tagName.length;
      const nameMatches = asciiLowerCase(input.slice(candidate + 2, nameEnd)) === tagName;
      const boundary = input.charCodeAt(nameEnd);
      const isBoundary = nameEnd >= this.length || isHtmlWhitespace(boundary) || boundary === 0x2f || boundary === 0x3e;

      if (nameMatches && isBoundary) {
        const text = input.slice(position, candidate);
        this.pushText(decode ? decodeEntities(text) : text, position);
        return candidate; // the closing tag is read by the main loop
      }
      searchFrom = candidate + 2;
    }
  }

  skipWhitespace(position) {
    while (position < this.length && isHtmlWhitespace(this.input.charCodeAt(position))) {
      position += 1;
    }
    return position;
  }
}

/* ------------------------------------------------------------------------ */
/* Tree builder: tokens -> nested nodes                                     */
/* ------------------------------------------------------------------------ */

/*
 * Iterative, with an explicit stack of open elements, so deeply nested input
 * cannot overflow the call stack.
 *
 * A stack frame is { tag, node, start }. "node" is where children are
 * appended. Normally it is the element itself; beyond maxDepth it is the
 * deepest allowed ancestor, which keeps the output depth bounded while every
 * piece of content is still kept.
 *
 * Formatting whitespace is removed at the very end, not when the text is met:
 * text after an ignored tag is merged into the previous text node ("a</x>\n"
 * becomes "a\n"), so only the final value of a node tells whether it is
 * whitespace-only.
 */
function buildTree(tokens, collector, limits, options) {
  // Two streams: warnings met while walking the tokens, and the final report
  // of unclosed elements, which points back to earlier positions.
  const warnings = collector.stream();
  const unclosedWarnings = collector.stream();
  const root = { type: "document", children: [] };
  const stack = [{ tag: null, node: root, start: 0 }];
  // Tag -> stack indexes of the open elements with that tag. Answers "is a
  // <p> open, and is it above any <table>?" in O(1) instead of scanning the
  // stack, so deep input stays linear.
  const openPositions = new Map();
  const topmost = (tag) => {
    const positions = openPositions.get(tag);
    return positions === undefined || positions.length === 0 ? -1 : positions[positions.length - 1];
  };
  const topmostOf = (tags) => {
    let index = -1;
    for (const tag of tags) index = Math.max(index, topmost(tag));
    return index;
  };
  let depthWarningShown = false;
  // Number of open pre/textarea/script/style... elements.
  let sensitiveDepth = 0;
  // Text nodes that may turn out to be formatting whitespace: { node, siblings }.
  const whitespaceCandidates = [];

  const currentFrame = () => stack[stack.length - 1];

  const appendChild = (node) => {
    const siblings = currentFrame().node.children;
    const last = siblings[siblings.length - 1];
    // Text separated only by an ignored tag ("a</x>b") becomes one node.
    if (node.type === "text" && last !== undefined && last.type === "text") {
      last.value += node.value;
      return;
    }
    siblings.push(node);
    if (node.type === "text" && !options.preserveWhitespace && sensitiveDepth === 0) {
      whitespaceCandidates.push({ node, siblings });
    }
  };

  const openElement = (tag, element, start) => {
    let target = element;
    if (stack.length - 1 >= limits.maxDepth) {
      target = currentFrame().node;
      if (!depthWarningShown) {
        depthWarningShown = true;
        warnings.add(
          "MAX_DEPTH_EXCEEDED",
          `Nesting is deeper than ${limits.maxDepth} levels; content of deeper elements is placed next to them instead of inside.`,
          start,
        );
      }
    }
    if (!openPositions.has(tag)) openPositions.set(tag, []);
    openPositions.get(tag).push(stack.length);
    stack.push({ tag, node: target, start });
    if (WHITESPACE_SENSITIVE_ELEMENTS.has(tag)) sensitiveDepth += 1;
  };

  const popFrame = () => {
    const frame = stack.pop();
    openPositions.get(frame.tag).pop();
    if (WHITESPACE_SENSITIVE_ELEMENTS.has(frame.tag)) sensitiveDepth -= 1;
    return frame;
  };

  const handleEndTag = (token) => {
    const { name, start } = token;

    if (topmost(name) === -1) {
      if (name === "br") {
        // Browsers turn a stray "</br>" into "<br>".
        warnings.add("STRAY_BR_CLOSING_TAG", '"</br>" is treated as "<br>".', start);
        appendChild({ type: "element", tag: "br", attributes: Object.create(null), children: [] });
      } else if (VOID_ELEMENTS.has(name)) {
        warnings.add("VOID_CLOSING_TAG", `<${name}> is a void element and cannot have a closing tag; ignored.`, start);
      } else {
        warnings.add("UNMATCHED_CLOSING_TAG", `Closing tag </${name}> has no matching open tag; ignored.`, start);
      }
      return;
    }

    // Close everything above the matching element as well ("<b><i></b>").
    closeDownTo(topmost(name), `</${name}>`, start);
  };

  // Pops the stack down to and including the element at "index". Elements
  // above it are closed implicitly; that is reported unless their end tag is
  // optional anyway ("</ul>" ending an open <li> is fine).
  const closeDownTo = (index, by, start) => {
    while (stack.length > index) {
      const frame = popFrame();
      if (stack.length !== index && !OPTIONAL_END_TAG.has(frame.tag)) {
        warnings.add("IMPLICITLY_CLOSED", `<${frame.tag}> is closed implicitly by ${by}.`, start);
      }
    }
  };

  // A start tag ends the open elements whose end tag may be omitted:
  // "<li>a<li>b", "<p>a<div>", "<td>a<td>b", "<option>a<option>b".
  const closeOptionalEndTags = (tag, start) => {
    const by = `<${tag}>`;
    if (CLOSES_P.has(tag)) {
      const p = topmost("p");
      if (p > topmostOf(BUTTON_SCOPE)) closeDownTo(p, by, start);
    }
    const rule = IMPLIED_END_RULES.get(tag);
    if (rule !== undefined) {
      const open = topmostOf(rule.closes);
      if (open !== -1 && open > topmostOf(rule.scope)) closeDownTo(open, by, start);
    }
    if (tag === "option" || tag === "optgroup") {
      if (currentFrame().tag === "option") popFrame();
      if (tag === "optgroup" && currentFrame().tag === "optgroup") popFrame();
    }
  };

  for (const token of tokens) {
    switch (token.kind) {
      case "text":
        appendChild({ type: "text", value: token.value });
        break;
      case "comment":
        appendChild({ type: "comment", value: token.value });
        break;
      case "doctype":
        appendChild({ type: "doctype", value: token.value });
        break;
      case "startTag": {
        closeOptionalEndTags(token.name, token.start);
        const element = {
          type: "element",
          tag: token.name,
          attributes: token.attributes,
          children: [],
        };
        appendChild(element);
        // "<div/>" is treated as an empty, closed element (agreed design choice).
        if (!VOID_ELEMENTS.has(token.name) && !token.selfClosing) {
          openElement(token.name, element, token.start);
        }
        break;
      }
      case "endTag":
        handleEndTag(token);
        break;
      default:
        break;
    }
  }

  // Anything still open at the end of input is closed automatically.
  // Not reported for elements whose end tag is optional ("<ul><li>a" is fine).
  for (let i = 1; i < stack.length; i += 1) {
    const frame = stack[i];
    if (OPTIONAL_END_TAG.has(frame.tag)) continue;
    unclosedWarnings.add(
      "UNCLOSED_ELEMENT",
      `<${frame.tag}> is not closed; closed automatically at end of input.`,
      frame.start,
    );
  }

  removeFormattingWhitespace(whitespaceCandidates);
  return root;
}

/**
 * Drops the candidates whose final value is formatting whitespace. Each
 * affected children array is compacted once, so the cost stays linear.
 * Removing a text node never makes two text nodes adjacent: its neighbours
 * cannot be text, otherwise they would have been merged into it.
 */
function removeFormattingWhitespace(candidates) {
  const removed = new Set();
  const affectedLists = new Set();
  for (const { node, siblings } of candidates) {
    if (isFormattingWhitespace(node.value)) {
      removed.add(node);
      affectedLists.add(siblings);
    }
  }
  for (const siblings of affectedLists) {
    let kept = 0;
    for (const child of siblings) {
      if (!removed.has(child)) siblings[kept++] = child;
    }
    siblings.length = kept;
  }
}

/**
 * Validates the options argument. Unknown keys are ignored; anything that is
 * not usable is reported as a warning and replaced by the default.
 */
function readOptions(options, warnings) {
  if (options === undefined || options === null) return DEFAULT_OPTIONS;
  if (typeof options !== "object") {
    warnings.add("INVALID_OPTIONS", `Options must be an object, received ${typeof options}; defaults are used.`, null);
    return DEFAULT_OPTIONS;
  }

  let preserveWhitespace;
  try {
    ({ preserveWhitespace } = options); // a getter or a Proxy could throw
  } catch (error) {
    warnings.add("INVALID_OPTIONS", "Options could not be read; defaults are used.", null);
    return DEFAULT_OPTIONS;
  }
  if (preserveWhitespace === undefined) return DEFAULT_OPTIONS;
  if (typeof preserveWhitespace !== "boolean") {
    warnings.add(
      "INVALID_OPTIONS",
      `"preserveWhitespace" must be true or false, received ${typeof preserveWhitespace}; false is used.`,
      null,
    );
    return DEFAULT_OPTIONS;
  }
  return { preserveWhitespace };
}

/* ------------------------------------------------------------------------ */
/* Public API                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Converts HTML text into a JSON object. Never throws.
 * @param {string} htmlText
 * @param {{ preserveWhitespace?: boolean }} [options]
 * @returns {{ type: "document", children: object[], warnings: object[] }}
 */
function html2json(htmlText, options) {
  const limits = HTML2JSON_LIMITS;

  if (typeof htmlText !== "string") {
    return {
      type: "document",
      children: [],
      warnings: [
        {
          code: "INVALID_INPUT",
          message: `Expected a string, received ${htmlText === null ? "null" : typeof htmlText}.`,
          line: null,
          column: null,
        },
      ],
    };
  }

  // Same preprocessing as browsers: drop a leading byte order mark and turn
  // Windows/old Mac line endings into "\n".
  const input = htmlText.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const warnings = createWarningCollector(createLocator(input), limits.maxWarnings);

  try {
    const settings = readOptions(options, warnings.stream());
    const tokens = new Tokenizer(input, warnings.stream(), settings).run();
    const documentNode = buildTree(tokens, warnings, limits, settings);
    documentNode.warnings = warnings.finish();
    return documentNode;
  } catch (error) {
    // Safety net only. No known input reaches it; it exists so that even an
    // environment failure (for example running out of memory on a gigantic
    // input) is reported instead of crashing the caller.
    return {
      type: "document",
      children: [],
      warnings: [
        {
          code: "INTERNAL_ERROR",
          message: `Conversion failed: ${error && error.message ? error.message : String(error)}`,
          line: null,
          column: null,
        },
      ],
    };
  }
}

/* ------------------------------------------------------------------------ */
/* Turning the result into text for a page                                  */
/* ------------------------------------------------------------------------ */

/*
 * html2json() itself is linear, but pretty-printed JSON is not: every line
 * repeats indentation proportional to its depth. 100 000 elements nested to
 * the depth limit would need about a gigabyte of spaces, and
 * JSON.stringify(result, null, 2) throws "Invalid string length" after
 * several seconds. Compact JSON has no indentation and stays linear.
 */
const OUTPUT_LIMITS = Object.freeze({
  // Above this much indentation, compact JSON is produced instead.
  prettyIndentation: 32 * 1024 * 1024,
  // A text field holding much more than this freezes or crashes a browser tab.
  display: 5 * 1024 * 1024,
});

/**
 * Counts the characters (line breaks + indentation) that pretty-printing
 * with 2 spaces adds to compact JSON. Stops early once "limit" is exceeded.
 * Every line at indentation level L costs 1 + 2 * L characters.
 */
function estimatePrettyIndentation(result, limit) {
  const lineCost = (level) => 1 + 2 * level;
  // Root: "{", "type", "children": [ ... ], "warnings": [ ... ], "}".
  let total = lineCost(0) * 2 + lineCost(1) * 5 + result.warnings.length * (lineCost(2) * 2 + lineCost(3) * 4);
  const pending = result.children.map((node) => [node, 2]);

  while (pending.length > 0) {
    const [node, level] = pending.pop();
    // "{", "type", value or tag line, "}"
    total += lineCost(level) * 2 + lineCost(level + 1) * 2;
    if (node.type === "element") {
      const attributeCount = Object.keys(node.attributes).length;
      total += lineCost(level + 1) * 2; // "attributes" and "children" lines
      if (attributeCount > 0) total += lineCost(level + 2) * attributeCount + lineCost(level + 1);
      if (node.children.length > 0) total += lineCost(level + 1);
      for (const child of node.children) pending.push([child, level + 2]);
    }
    if (total > limit) return Infinity;
  }
  return total;
}

/**
 * Serializes a result: pretty-printed when that is affordable, compact
 * otherwise. Never throws.
 * @returns {{ text: string, pretty: boolean }}
 */
function stringifyResult(result) {
  try {
    if (estimatePrettyIndentation(result, OUTPUT_LIMITS.prettyIndentation) <= OUTPUT_LIMITS.prettyIndentation) {
      return { text: JSON.stringify(result, null, 2), pretty: true };
    }
    return { text: JSON.stringify(result), pretty: false };
  } catch (error) {
    // Only reachable if even the compact text exceeds the engine's string limit.
    const message = `The result is too large to be turned into text: ${error && error.message}`;
    return { text: JSON.stringify({ error: message }, null, 2), pretty: true };
  }
}

/** Shortens text for display in a page, with a note saying what was cut. */
function textForDisplay(text, limit = OUTPUT_LIMITS.display) {
  if (text.length <= limit) return text;
  const megabytes = (length) => (length / 1024 / 1024).toFixed(1);
  return `${text.slice(0, limit)}\n\n... output shortened for display: showing ${megabytes(limit)} MB of ${megabytes(text.length)} MB`;
}

/* ------------------------------------------------------------------------ */
/* Page glue for the provided index.html                                    */
/* ------------------------------------------------------------------------ */

const EXAMPLE_HTML_1 = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport">
    <title>Sample HTML</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <header>
        <h1>Welcome to My Website</h1>
    </header>
    <nav>
        <ul>
            <li><a href="#home">Home</a></li>
            <li><a href="#about">About</a></li>
            <li><a href="#contact">Contact</a></li>
        </ul>
    </nav>
    <main>
        <section id="home">
            <h2>Home Section</h2>
            <p>This is the home section of the webpage.</p>
        </section>
        <section id="about">
            <h2>About Section</h2>
            <p>This is the about section of the webpage.</p>
        </section>
    </main>
    <footer>
        <p>&copy; 2024 My Website</p>
    </footer>
    <script src="script.js"></script>
</body>
</html>
`;

const EXAMPLE_HTML_2 = `<div>
<p>Hello world!</p>
  <button>Click me!</button>
  <textarea>Some very very very very very very very very very very very very very very very very very very very very very very very very very very very very very very very very very very very long string.</textarea>
</div>
`;

function convertHtml2JsonAndSet() {
  const htmlTextAreaValue = document.getElementById("html").value;
  const jsonObj = html2json(htmlTextAreaValue);
  const jsonArea = document.getElementById("json");
  jsonArea.textContent = textForDisplay(stringifyResult(jsonObj).text);
}

function showExample1() {
  document.getElementById("html").value = EXAMPLE_HTML_1;
  convertHtml2JsonAndSet();
}

function showExample2() {
  document.getElementById("html").value = EXAMPLE_HTML_2;
  convertHtml2JsonAndSet();
}

// Lets the same file be loaded by Node.js for automated tests.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    html2json,
    stringifyResult,
    estimatePrettyIndentation,
    textForDisplay,
    HTML2JSON_LIMITS,
    OUTPUT_LIMITS,
    EXAMPLE_HTML_1,
    EXAMPLE_HTML_2,
  };
}
