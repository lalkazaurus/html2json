# html2json — Jito Software Developer Intern Test Task

`html2json(htmlText)` converts an HTML string into a JSON tree. It is written from
scratch: **no DOM parser** (`DOMParser`, `innerHTML`, `createElement`) is used for
parsing, there are no dependencies, and the function **never throws**: problems in
the input are returned as warnings next to the best possible tree.

- `index.html` — the original page, unchanged. Its buttons now show real results.
- `demo.html` — an extended demo: open or drop an `.html` file, see warnings with
  their positions, view the resulting JSON (exactly the text of the saved file, with
  syntax highlighting), switch whitespace handling, copy it or save it as `.json`.
- Live demo: _link will be added after deployment_

## Repository structure

```
html2json.js            the implementation (plus the glue for index.html)
index.html              original page from the task, unchanged
demo.html, demo.css,    extended demo page
demo.js
html_samples/           HTML files used for testing (see the table below)
tests/                  automated tests, Node.js built-in runner, no dependencies
ai_help/                how AI was used (link to the conversation)
```

## Running

Both pages work by opening the file directly in a browser; no server or build step.

Tests need Node.js 18 or newer:

```
node --test tests/html2json.test.js      # or: npm test
```

Code style is enforced by Prettier (`.prettierrc.json`, line width 120). `index.html`
and the samples are excluded, since their exact bytes matter. Lookup tables are marked
`// prettier-ignore` so they stay compact instead of one item per line.

```
npm run format:check     # or: npm run format
```

## API

```js
html2json(htmlText); // formatting whitespace dropped
html2json(htmlText, { preserveWhitespace: true }); // every text node kept as written
```

The second argument is optional, so the signature required by the task is unchanged.
Invalid options (not an object, a non-boolean value) do not throw: the defaults are
used and an `INVALID_OPTIONS` warning is added.

## Output format

```json
{
  "type": "document",
  "children": [
    {
      "type": "element",
      "tag": "p",
      "attributes": { "class": "a", "hidden": "" },
      "children": [
        { "type": "text", "value": "Hi " },
        { "type": "element", "tag": "br", "attributes": {}, "children": [] },
        { "type": "text", "value": " there" }
      ]
    }
  ],
  "warnings": []
}
```

That is the result for `<p class="a" hidden>Hi <br> there</p>`.

| `type`     | fields                                                  |
| ---------- | ------------------------------------------------------- |
| `document` | `children`, `warnings` (root only)                      |
| `element`  | `tag`, `attributes` (object: name → string), `children` |
| `text`     | `value`                                                 |
| `comment`  | `value`                                                 |
| `doctype`  | `value` (e.g. `"html"`)                                 |

A warning is `{ "code", "message", "line", "column" }`; `line` and `column` are
1-based and point to where the problem is in the input (`null` when there is no
position, e.g. for non-string input).

## Design decisions and why

**One node shape with a `type` field.** I compared three options: this one, a compact
form like `{ "div": [...] }`, and the xml2js style with `$` / `_` keys. The compact
form cannot represent mixed content in order (`<p>a <b>b</b> c</p>`) or two children
with the same tag without extra rules. The xml2js style is hard to read and to explain.
A uniform node is lossless, is the same at every depth, and a consumer handles it
with one `switch (node.type)`. It also matches the DOM's own model (element, text,
comment, doctype nodes), so it is familiar.

**A `document` root.** Input can be a full page (Example 1) or a fragment with several
top-level nodes (`<a></a>text<b></b>`). A root object holds both cases the same way
and gives a place for `warnings`.

**`children` and `warnings` are always present**, even when empty, so consumers never
have to check whether a field exists.

**Attributes as an object.** Reading `node.attributes.href` is simpler than searching
an array. Duplicates are the only thing an object cannot hold, and browsers keep only
the first one anyway, so that is what happens here (with a `DUPLICATE_ATTRIBUTE` warning).
The object has **no prototype** (`Object.create(null)`): an attribute named `__proto__`
would otherwise be silently swallowed. This is a case of valid HTML producing a
wrong result that is easy to miss.

**Boolean attributes get `""`** (`<input disabled>` → `"disabled": ""`), exactly what
`getAttribute` returns in the DOM. Every value stays a string, so the type is uniform.

**Tag and attribute names are lowercased** (HTML is case-insensitive; only ASCII
letters are changed, as in the spec). Attribute values keep their case.

**Formatting whitespace is dropped, meaningful whitespace is kept.** In a typical
file most text nodes are just the line breaks and indentation between tags: in
Example 1, 35 of 45 text nodes are like `"\n    "`. They come from how the file is
formatted, not from its content, and they make the JSON long and hard to use. But
whitespace cannot be removed blindly: in `<b>Hello</b> <i>world</i>` the space
separates the words, and inside `<pre>` every character counts. So the rule (the same
one JSX in React uses) is:

- a text node made **only of whitespace that contains a line break** is removed;
- whitespace on a single line (`" "`, `"\t"`) is kept: it separates inline content;
- text with any visible character is never trimmed (`"\n  Hello\n"` stays as is);
- `&nbsp;` is content, not whitespace;
- nothing is removed inside `pre`, `listing`, `textarea`, `script`, `style` and the
  other raw text elements, nor inside elements nested in them;
- except one thing browsers drop as well: the single line break right after `<pre>`,
  `<listing>` or `<textarea>` (`<pre>⏎code` is `"code"`). It exists only so the
  content can start on its own line in the source.

The decision is made after the tree is built, on each text node's final value: text
around an ignored tag is merged first (`a</x>\n  ` is one node `"a\n  "` and stays).
Every removal is O(1) and each children array is compacted once.

`{ preserveWhitespace: true }` turns the rule off and gives a lossless record of the
input; browsers keep these nodes too (in Example 2 `div.childNodes` has 7 nodes).
Line endings are normalized to `\n` and a leading BOM is removed in both modes, which
is what browsers do before parsing.

**Entities: the common set, with the browser rules.** The full HTML table has 2231
names; about 80 cover what real pages use: the markup ones (`&amp; &lt; &gt; &quot;
&apos;`), spaces (`&nbsp; &ensp; &emsp; &thinsp;`), typography (`&mdash; &ndash;
&hellip; &laquo; &raquo; &ldquo; &rdquo; &bull;`), symbols (`&copy; &reg; &trade; &euro;
&deg; &times; &rarr;` ...) and numeric references (`&#169;`, `&#xA9;`). The rules are the
browser's:

- the old "legacy" names also work without `;` (`&copy 2024`, `&amp` in old URLs,
  `&copy2024` is `©2024`), newer ones need it (`&mdash` stays as written);
- in attribute values a legacy name without `;` followed by a letter, digit or `=` is not
  decoded, so `href="?a=1&copy=2"` keeps its query string;
- `&#128;`–`&#159;` are the Windows-1252 characters they meant in old pages
  (`&#151;` is `—`);
- names are case-sensitive (`&AMP;` is a legacy name, `&Mdash;` is nothing).

Unknown names stay as written, so nothing is lost or invented. One small difference from
browsers: an unknown name with `;` that starts with a legacy name (`&notin;` is `∉` in the
full table) stays as written here, where a browser that knew only this table would turn it
into `¬in;`. Half-decoding a real reference would be worse than keeping it. Text and attribute values are decoded, including
`<textarea>` and `<title>`; `<script>` and `<style>` are not, because there `&amp;`
is literal code. Invalid code points (`&#0;`, surrogates, beyond U+10FFFF) become
U+FFFD like in browsers instead of making `String.fromCodePoint` throw. The lookup
table is a `Map`, so `&constructor;` is not "decoded" into a function.

**Raw text elements.** The content of `script`, `style` (and the rarer `xmp`, `iframe`,
`noembed`, `noframes`) and of `textarea`, `title` is not markup: `if (a < b)` or
`"<div>"` inside a script stays text up to the real closing tag.

**Void elements** (`br`, `img`, `input`, `meta`, `link`, ...) never take children.

**`<div/>` closes the element.** Strictly by HTML5 the slash is ignored on non-void
elements and the `div` would stay open. I treat it as an empty closed element because
that is what the author means in practice (inline SVG, JSX habits, XHTML).

**Optional end tags are closed like browsers do.** HTML allows leaving out `</li>`,
`</p>`, `</td>` and some others, and real pages do it all the time. Without these rules
`<li>a<li>b<li>c` would become three nested items, and a tree that is deeper than the
page. The rules come from the HTML spec, in a short table instead of the whole algorithm:

- `<li>` closes an open `li`; `<dt>`/`<dd>` close an open `dt`/`dd`. The search stops at
  list and other "special" elements, so a nested `<ul>` is its own scope;
- `<p>` and block elements (`div`, `ul`, `table`, `h1`–`h6`, `hr`, `section`, ...) close an
  open `p`, unless a `button`, `table` or cell lies in between;
- `<td>`/`<th>` close an open cell, `<tr>` an open row, `<thead>`/`<tbody>`/`<tfoot>` an
  open section, all within the nearest `table`;
- `<option>` closes an open `option`; `<optgroup>` closes an open `option` and `optgroup`.

Closing these is valid HTML, so it gives no warning, neither here nor when they are
still open at the end of input or at an ancestor's closing tag (`<ul><li>a</ul>`). If
other elements had to be closed on the way (`<li><b>x<li>`), that is reported.

**Other malformed HTML is repaired in the simplest predictable way:**

- a closing tag closes its nearest open match, and everything opened after it
  (`<b><i>x</b>` closes both, with `IMPLICITLY_CLOSED`);
- a closing tag with no open match is ignored (`UNMATCHED_CLOSING_TAG`);
- elements still open at the end of input are closed there (`UNCLOSED_ELEMENT`);
- a `<` that does not start a tag (`a < b`, `<3`) is text;
- a tag cut off by the end of input (`<div cla`) is kept as text with a warning,
  so no user input silently disappears;
- `<![CDATA[...]]>`, `<?xml ...?>` and other `<!...>` become comments, as browsers do.

**Warnings instead of exceptions.** The task says the code must not crash, and a
converter used on real pages will see broken HTML. Returning the best tree plus a list
of problems with positions is more useful than failing, and it shows exactly what was
repaired. The list is capped at the **first 1000 by position in the input**
(`WARNINGS_TRUNCATED` reports how many more there were), so garbage input cannot produce
millions of them. Warnings come from several passes (tokenizer, tree builder, the final
report of unclosed elements), each in position order; every pass keeps its own first 1000,
then they are merged and the overall first 1000 are kept, so memory stays bounded.

## How it works

1. **Preprocessing:** remove BOM, normalize line endings.
2. **Tokenizer** (`class Tokenizer`): one left-to-right pass over the string producing
   a flat list of tokens: text, start tag (name, attributes, self-closing flag), end tag,
   comment, doctype. Text runs are found with `indexOf("<")`, tag internals are read
   character by character. After a raw text start tag it switches to searching for the
   matching closing tag.
3. **Tree builder** (`buildTree`): walks the tokens with an **explicit stack** of open
   elements. No recursion, so 100 000 nested `<div>`s cannot overflow the call stack.
4. Warnings from both passes are sorted by position and attached to the root.

**Depth limit.** `JSON.stringify` _is_ recursive and throws on extremely deep objects.
So nesting is capped at 500 elements, far beyond any real page. Deeper elements are
still in the output, but their content is placed next to them under the level-500
ancestor instead of inside them (`MAX_DEPTH_EXCEEDED`, reported once). Nothing is lost
and the result can always be serialized.

**Complexity** is linear in the input size. Specific cases that would be quadratic in
a naive implementation are guarded: "is a `<p>` open, and is it above any `<table>`?" and
"is there an open `</x>` to match?" are answered in O(1) from a per-tag list of stack
positions instead of scanning a deep stack; line/column positions are computed
lazily with a binary search over line starts; no regular expression can backtrack
catastrophically. A 10 MB page converts in about 2 seconds in Node.js, including
`JSON.stringify`.

**Safety net.** The body is wrapped in `try/catch` that returns an `INTERNAL_ERROR`
warning. No known input reaches it (the fuzz test checks that); it is there so that
even an environment failure such as running out of memory is reported, not thrown.

**Showing the result in a page.** Converting is linear, but pretty-printed JSON is not:
every line repeats indentation proportional to its depth. 100 000 nested elements
convert in 0.2 s, yet `JSON.stringify(result, null, 2)` would need about 1 GB of spaces
and throws `RangeError: Invalid string length` (this was found by the stress samples,
and it affected the original `index.html` glue code). So both pages use
`stringifyResult(result)`: it first estimates how much indentation pretty-printing would
add (each line at level L costs `1 + 2·L` characters, counted with an iterative walk that
stops early) and produces compact JSON above 32 MB. The estimate is within a few percent
of the real size. Pages also show at most 5 MB of text, with a note, because a larger
text field crashes the browser tab; the demo's Save and Copy still use the whole result.
The demo wraps compact JSON, because a browser draws nothing for one line that is
millions of characters long. Converting runs on the page's thread (a Web Worker is not
allowed when the page is opened from disk), so for inputs over 200 KB the demo first
shows "Converting…" on the button and only then starts the work.

**File encodings (demo).** `html2json` receives a string, so decoding a file is the
page's job. The demo does it the way browsers do for HTML: byte order mark (UTF-8,
UTF-16 LE/BE), then valid UTF-8, then a `<meta charset>` in the first 1024 bytes;
otherwise UTF-8 with a notice that unreadable bytes were replaced.

## Warning codes

| code                                            | when                                                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `INVALID_INPUT`                                 | the argument is not a string                                                                                          |
| `INVALID_OPTIONS`                               | the options argument is not usable; defaults are used                                                                 |
| `UNTERMINATED_TAG`                              | a tag is cut off by the end of input; kept as text                                                                    |
| `UNTERMINATED_COMMENT` / `UNTERMINATED_DOCTYPE` | no closing `-->` / `>`                                                                                                |
| `BOGUS_COMMENT`                                 | `<!...>`, `<?...>`, `</ 1>` stored as a comment                                                                       |
| `DUPLICATE_ATTRIBUTE`                           | the same attribute twice; the first one is kept                                                                       |
| `ATTRIBUTES_ON_CLOSING_TAG`                     | `</div class="x">`                                                                                                    |
| `EMPTY_CLOSING_TAG`                             | `</>`                                                                                                                 |
| `UNMATCHED_CLOSING_TAG`                         | closing tag without an open element                                                                                   |
| `VOID_CLOSING_TAG`                              | `</img>` and similar                                                                                                  |
| `STRAY_BR_CLOSING_TAG`                          | `</br>`, treated as `<br>` like browsers do                                                                           |
| `IMPLICITLY_CLOSED`                             | an element without an optional end tag was closed by an ancestor's closing tag or by a start tag that ends its parent |
| `UNCLOSED_ELEMENT`                              | still open at the end of input (not reported for `li`, `p`, `td`... whose end tag is optional)                        |
| `MAX_DEPTH_EXCEEDED`                            | nesting deeper than 500                                                                                               |
| `WARNINGS_TRUNCATED`                            | more than 1000 warnings                                                                                               |
| `INTERNAL_ERROR`                                | safety net, never expected                                                                                            |

## Known limitations (deliberate)

These are scope decisions, not bugs; each would add a lot of code for little value in
a converter.

- Optional end tags follow a short rule table, not the full tree construction
  algorithm. Browsers also reopen formatting elements that were cut by such a close
  (`<li><b>x<li>y` puts `y` in a new `<b>` too); here `<b>` is closed with
  `IMPLICITLY_CLOSED` and not reopened.
- Browsers also create missing `html`/`head`/`body`/`tbody` and move misplaced table
  content; this converter keeps the structure that is written.
- About 80 entity names are decoded, not all 2231; the rest stay as written.
- `<!--` inside `<script>` (the legacy "script data escaped" states) has no special
  meaning here; the script ends at the first `</script>`.
- By default, two inline elements written on separate lines (`<b>a</b>⏎<b>b</b>`)
  lose the line break between them, while a browser would render it as a space. JSX
  has the same trade-off; use `preserveWhitespace: true` when this matters.

## Testing

`tests/html2json.test.js` (76 tests, all passing) covers:

- every design decision above with exact expected output;
- the whitespace rule: indentation removed, same-line spaces kept, `&nbsp;`, `pre` /
  `textarea` / `script` / `style` untouched (also nested and unclosed), merged text
  nodes, both modes, invalid options;
- malformed input with the exact warning codes and positions;
- the browser rules added after the stress tests: the line break after `<pre>`, entities
  with and without `;` (in text and in attributes), Windows-1252 numbers, optional end
  tags for lists, paragraphs, tables and `select`, with their scopes and warnings, and
  speed on 100 000 omitted end tags under 20 000 open elements;
- every file in `html_samples/` and `html_samples/stress/`, in both modes (valid shape,
  no safety-net hit, serialized text parses back);
- serialization: pretty output identical to `JSON.stringify(result, null, 2)` for normal
  results, compact fallback for 100 000 nested elements, the size estimate's accuracy,
  shortening for display;
- the original page's `convertHtml2JsonAndSet()`, run against a stand-in `document`,
  never throws on empty, deep or huge input;
- **round trip:** 2000 random well-formed trees are serialized to HTML and parsed back
  with `preserveWhitespace: true`; the result must equal the original tree with no
  warnings. Another 2000 in the default mode must equal the original tree minus its
  formatting whitespace;
- **fuzzing:** 5000 random strings made of markup fragments (`<`, `</`, `<!--`, quotes,
  `&#`, lone surrogates, ...), in both modes, must never throw or hit the safety net;
- **size and speed:** a 10 MB table, a 10 MB text node, 500 000 lone `<`, 100 000 nested
  elements, deep stack with many unmatched closing tags, an unterminated 5 MB attribute.

**Comparison with a real browser.** As an independent check during development, the
samples were also parsed by Chromium's own parser and the trees were compared. For
Example 1 and the 6000-row table the result is **identical** to Chromium's (with
`preserveWhitespace: true`, ignoring the whitespace nodes the browser moves between
`head` and `body`). The only differences in other samples, the stress samples included,
are the deliberate ones listed in the limitations above, plus one more: browsers drop
U+0000 characters from text, while this converter keeps them (JSON encodes them as
`\u0000`).

### Samples

| file                               | what it checks                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `01-example-1-full-page.html`      | Example 1 from the task                                                                         |
| `02-example-2-fragment.html`       | Example 2: fragment, long text in `textarea`                                                    |
| `03-attributes.html`               | every attribute syntax, duplicates, `>` in values, `__proto__`                                  |
| `04-raw-text-elements.html`        | `script`/`style`/`textarea`/`title` with markup-like content                                    |
| `05-comments-doctype-cdata.html`   | comment variants, doctype, CDATA, `<?xml?>`                                                     |
| `06-entities.html`                 | named, numeric, legacy without `;`, in attributes, Windows-1252, invalid and unknown references |
| `07-malformed.html`                | unmatched, crossed, unclosed and odd closing tags                                               |
| `08-void-and-self-closing.html`    | void elements, `<br/>`, `<div/>`, inline SVG                                                    |
| `09-unicode-and-whitespace.html`   | Cyrillic, CJK, Arabic, emoji, `pre`, tabs                                                       |
| `10-empty.html`                    | empty file                                                                                      |
| `11-only-text.html`                | text without tags, `<` and `&` in text                                                          |
| `12-windows-line-endings-bom.html` | CRLF line endings and a BOM                                                                     |
| `13-large-table.html`              | ~0.8 MB, 6000 rows                                                                              |
| `14-deep-nesting.html`             | 2000 nested elements (above the depth limit)                                                    |
| `15-unterminated-at-end.html`      | input that ends inside a script, comment and tag                                                |
| `16-real-world-page.html`          | a realistic page: forms, tables, JSON-LD, `template`                                            |

`html_samples/stress/` holds 37 more files written to break the converter: from a single
`<` to a 10 MB table, 100 000 unclosed nested elements, binary garbage, UTF-16 and
Windows-1251 files. Its own [README](html_samples/stress/README.md) lists what each file
attacks and what the stress test found.

## AI usage

As required, the whole solution was developed in one AI conversation (Claude by
Anthropic): analysis of the task, agreeing on the design decisions listed above, then
the implementation, tests and demo. See `ai_help/` for the link and an export.
