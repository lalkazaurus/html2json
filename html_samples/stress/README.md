# Stress samples

Inputs written to break the converter or the pages that display its result.
Every file is converted by the automated tests in both whitespace modes.

| file | what it attacks |
|------|-----------------|
| `01-one-char-lt.html` | a single `<` |
| `02-one-char-gt.html` | a single `>` |
| `03-one-char-amp.html` | a single `&` |
| `04-only-bom.html` | only a UTF-8 byte order mark |
| `05-only-newlines.html` | only line breaks, mixed CRLF / CR / LF |
| `06-lt-slash-only.html` | only `</` |
| `07-empty-tags.html` | `<>`, `</>`, `</ >`, `<!>`, `<?>`, `<!---->` |
| `10-tag-syntax-tricks.html` | `<` inside a tag name, `<<div>>`, `>` in quotes, mixed quotes, attribute named `=x`, slashes, non-ASCII tag names, `svg:rect`, tags named `constructor` / `__proto__` |
| `11-raw-text-tricks.html` | fake `</script>` in strings, `</ScRiPt   >`, `<!--` in script, `<scr<script>`, `</textarea⏎>`, `</ title>` |
| `12-comment-tricks.html` | `--` inside comments, `--->`, "nested" comments, `<!--->`, empty and repeated doctypes, doctype in body, conditional comments, CDATA, `<?php ?>`, comment open until the end |
| `13-entity-tricks.html` | double encoding, malformed numeric references, code points beyond Unicode, surrogate halves, uppercase names, missing `;` |
| `14-structure-tricks.html` | crossed nesting, tables and lists without closing tags, `div` in `p`, nested links, stray closing tags, repeated `html`/`head`/`body`, `</br>`, `<div/>` |
| `15-whitespace-tricks.html` | whitespace-only paragraphs, spaces between inline elements, `pre` inside `pre`, `&nbsp;`, em space, form feed, vertical tab |
| `16-mixed-line-endings.html` | CRLF, CR and LF in one file |
| `17-unicode-tricks.html` | right-to-left text, zero-width characters, a BOM in the middle, emoji sequences, combining marks, NUL and control characters, `<İ>` |
| `18-utf16-encoded.html` | UTF-16 little-endian file with a BOM |
| `18b-utf16-big-endian.html` | UTF-16 big-endian file with a BOM |
| `19-windows-1251-encoded.html` | Windows-1251 file that does not declare its encoding |
| `19b-windows-1251-with-meta.html` | Windows-1251 file with `<meta charset="windows-1251">` |
| `20-binary-garbage.html` | 20 KB of random bytes |
| `21-json-not-html.html` | a JSON file |
| `22-css-not-html.html` | a CSS file |
| `23-many-warnings.html` | 3000 stray closing tags and 500 duplicate attributes (warning cap) |
| `24`–`27` | input ending inside an attribute quote, a closing tag name, a `textarea`, a numeric reference |
| `30-depth-499.html` / `31-depth-501.html` | just below and just above the depth limit |
| `32-depth-100000-unclosed.html` | 100 000 nested elements that are never closed |
| `33-wide-50000-siblings.html` | 50 000 sibling elements |
| `40-one-line-5mb.html` | a 5 MB file on a single line |
| `41-huge-attribute-2mb.html` | one 2 MB attribute value |
| `42-10000-attributes.html` | one element with 10 000 attributes |
| `43-lt-spam-1mb.html` | a million `<` characters |
| `44-unclosed-quote-5mb.html` | an attribute quote opened and never closed, 5 MB |
| `45-big-table-10mb.html` | a 10 MB table (116 279 rows) |

## What they found

The parser never crashed. The weak points were in the code that shows the result and
in how warnings are capped; all are fixed:

1. **Pretty-printing deep results.** `32-depth-100000-unclosed.html` parses in 0.2 s,
   but `JSON.stringify(result, null, 2)` needs about 1 GB of indentation and throws
   `RangeError: Invalid string length`. That call was in the page glue used by the
   original `index.html`, so its Convert button threw. Now `stringifyResult()` estimates
   the indentation first and produces compact JSON when it would be too large.
2. **Showing huge text.** The 10 MB table gives 115 MB of pretty JSON (37 MB compact);
   putting it into a text area crashed the browser tab. Pages now show the first 5 MB
   with a note; Save and Copy in the demo still use the whole result.
3. **File encodings in the demo.** UTF-16 and Windows-1251 files were read as UTF-8 and
   turned into garbage before reaching the parser. The demo now picks the encoding like
   a browser does: BOM, then valid UTF-8, then `<meta charset>`; otherwise it says that
   bytes were replaced.

4. **Which warnings survive the cap.** Found by checking the output of
   `23-many-warnings.html` by hand: the list promised "the first 1000", but it held 500
   stray closing tags from the beginning of the file and 500 duplicate attributes from
   its end. The tokenizer reports before the tree builder, so it took half the places
   first. The cap now keeps the first 1000 by position, whichever pass reported them.

5. **Compact JSON shown as one line.** Compact JSON has no line breaks, and Chromium
   draws nothing for a single line millions of characters long, so the result area of
   `45-big-table-10mb.html` looked empty. The demo now wraps compact JSON.

The review of these results also led to three parser changes that bring it closer to
browsers: the line break right after `<pre>`/`<textarea>` is dropped, about 80 common
entities are decoded (with the legacy no-`;` rules), and optional end tags (`<li>`,
`<p>`, `<td>`...) are closed like browsers do. The demo also shows "Converting…" while a
large input is being converted. See the main README for details.

All parser results on these files were also compared with Chromium's own HTML parser;
the only differences are the deliberate ones listed in the main README.
