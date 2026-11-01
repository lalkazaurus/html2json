/*
 * UI logic for demo.html. Parsing is done only by html2json() from
 * html2json.js; the DOM is used here just to display the result.
 * User content is always inserted with textContent, never innerHTML.
 */
"use strict";

(function initDemo() {
  const BROKEN_EXAMPLE = `<div class="card">
  </span>closing tag without an opening one
  <b><i>crossed nesting</b></i>
  <img src="photo.jpg" alt="duplicate" alt="attributes">
  <p>2 < 3 is text, &copy; and &#x1F600; are decoded
  <![CDATA[ not HTML ]]>
  </br>
  <section>
    <p>never closed
`;

  const EXAMPLES = {
    example1: { html: EXAMPLE_HTML_1, name: "example-1" },
    example2: { html: EXAMPLE_HTML_2, name: "example-2" },
    broken: { html: BROKEN_EXAMPLE, name: "broken-html" },
  };

  // Highlighting creates one DOM node per token. Above this size the JSON is
  // shown as plain text so the page stays responsive on multi-megabyte results.
  const HIGHLIGHT_LIMIT = 2 * 1024 * 1024;

  // Strings (and whether they are object keys), literals, numbers.
  const JSON_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

  const elements = {
    input: document.getElementById("html-input"),
    inputMeta: document.getElementById("input-meta"),
    fileInput: document.getElementById("file-input"),
    fileName: document.getElementById("file-name"),
    dropzone: document.getElementById("dropzone"),
    convertButton: document.getElementById("convert-button"),
    convertLabel: document.getElementById("convert-label"),
    clearButton: document.getElementById("clear-button"),
    copyButton: document.getElementById("copy-button"),
    saveButton: document.getElementById("save-button"),
    outputMeta: document.getElementById("output-meta"),
    preserveWhitespace: document.getElementById("preserve-whitespace"),
    jsonView: document.getElementById("json-view"),
    outputEmpty: document.getElementById("output-empty"),
    stats: document.getElementById("stats"),
    warningsList: document.getElementById("warnings-list"),
    warningsCount: document.getElementById("warnings-count"),
    warningsEmpty: document.getElementById("warnings-empty"),
    toast: document.getElementById("toast"),
  };

  const state = {
    result: null,
    jsonText: "",
    baseName: "result",
  };

  /* ---------------------------------------------------------------------- */
  /* Small DOM helpers                                                      */
  /* ---------------------------------------------------------------------- */

  function create(tag, className, textContent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (textContent !== undefined) node.textContent = textContent;
    return node;
  }

  function token(className, text) {
    return create("span", className, text);
  }

  let toastTimer = 0;
  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elements.toast.classList.remove("is-visible"), 2200);
  }

  function formatNumber(value) {
    return value.toLocaleString("en-US");
  }

  function formatBytes(chars) {
    if (chars < 1024) return `${chars} B`;
    if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} KB`;
    return `${(chars / 1024 / 1024).toFixed(1)} MB`;
  }

  /* ---------------------------------------------------------------------- */
  /* Input                                                                  */
  /* ---------------------------------------------------------------------- */

  function updateInputMeta() {
    const { value } = elements.input;
    let lines = value.length === 0 ? 0 : 1;
    for (let i = value.indexOf("\n"); i !== -1; i = value.indexOf("\n", i + 1)) lines += 1;
    elements.inputMeta.textContent = `${formatNumber(value.length)} characters · ${formatNumber(lines)} lines`;
  }

  function setInput(html, baseName, label) {
    elements.input.value = html;
    elements.input.scrollTop = 0;
    state.baseName = baseName;
    elements.fileName.textContent = label || "";
    updateInputMeta();
    convert();
  }

  /**
   * Turns file bytes into text the way browsers pick an encoding for HTML:
   * a byte order mark first, then valid UTF-8, then a <meta charset> near the
   * top of the file. If none of these works, UTF-8 is used and invalid bytes
   * become U+FFFD. Decoding is the page's job; html2json receives a string.
   */
  function decodeHtmlFile(buffer) {
    const bytes = new Uint8Array(buffer);
    const decode = (label, fatal = false) => new TextDecoder(label, { fatal }).decode(bytes);

    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
      return { text: decode("utf-8"), encoding: "UTF-8" };
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: decode("utf-16le"), encoding: "UTF-16LE" };
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: decode("utf-16be"), encoding: "UTF-16BE" };

    try {
      return { text: decode("utf-8", true), encoding: "UTF-8" };
    } catch {
      // Not valid UTF-8: look for a declared charset below.
    }

    const head = new TextDecoder("windows-1252").decode(bytes.subarray(0, 1024));
    const declared = head.match(/<meta[^>]*?charset\s*=\s*["']?\s*([\w.:-]+)/i);
    if (declared) {
      try {
        return { text: decode(declared[1]), encoding: declared[1] };
      } catch {
        // Unknown encoding label: fall through to lossy UTF-8.
      }
    }
    return { text: decode("utf-8"), encoding: "UTF-8", lossy: true };
  }

  async function loadFile(file) {
    if (!file) return;
    let decoded;
    try {
      decoded = decodeHtmlFile(await file.arrayBuffer());
    } catch (error) {
      showToast(`Could not read the file: ${error.message}`);
      return;
    }
    const baseName = file.name.replace(/\.[^.]+$/, "") || "result";
    setInput(decoded.text, baseName, `${file.name} · ${formatBytes(file.size)} · ${decoded.encoding}`);
    showToast(
      decoded.lossy
        ? `${file.name} is not valid UTF-8 and declares no charset; unreadable bytes were replaced with \u{FFFD}`
        : `Loaded ${file.name}`,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Conversion                                                             */
  /* ---------------------------------------------------------------------- */

  // Conversion runs on the page's thread (a Web Worker is not allowed when the
  // page is opened from disk), so a big input blocks the page for a moment.
  // For those, the button first shows "Converting…" and the browser gets two
  // frames to paint it before the work starts.
  const BUSY_INDICATOR_FROM = 200 * 1024;
  let converting = false;

  function convert() {
    if (converting) return;
    if (elements.input.value.length < BUSY_INDICATOR_FROM) {
      runConversion();
      return;
    }
    converting = true;
    setBusy(true);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        try {
          runConversion();
        } finally {
          converting = false;
          setBusy(false);
        }
      }),
    );
  }

  function setBusy(busy) {
    elements.convertButton.disabled = busy;
    elements.convertButton.classList.toggle("is-busy", busy);
    elements.convertButton.setAttribute("aria-busy", String(busy));
    elements.convertLabel.textContent = busy ? "Converting…" : "Convert to JSON";
    document.body.style.cursor = busy ? "progress" : "";
  }

  function runConversion() {
    const html = elements.input.value;
    const started = performance.now();
    const result = html2json(html, { preserveWhitespace: elements.preserveWhitespace.checked });
    const elapsed = performance.now() - started;

    // Pretty-printed when affordable, compact for huge or very deep results
    // (see stringifyResult in html2json.js).
    const { text, pretty } = stringifyResult(result);
    state.result = result;
    state.jsonText = text;

    renderStats(result, elapsed);
    renderWarnings(result.warnings);
    renderJson(text, pretty);

    elements.outputEmpty.hidden = true;
    elements.copyButton.disabled = false;
    elements.saveButton.disabled = false;
  }

  function collectStats(result) {
    const counts = { element: 0, text: 0, comment: 0, doctype: 0 };
    let maxDepth = 0;
    const pending = result.children.map((node) => [node, 1]);
    while (pending.length > 0) {
      const [node, depth] = pending.pop();
      counts[node.type] += 1;
      if (node.type === "element") {
        maxDepth = Math.max(maxDepth, depth);
        for (const child of node.children) pending.push([child, depth + 1]);
      }
    }
    return { counts, maxDepth };
  }

  function renderStats(result, elapsed) {
    const { counts, maxDepth } = collectStats(result);
    const items = [
      ["elements", counts.element],
      ["text nodes", counts.text],
      ["comments", counts.comment],
      ["max depth", maxDepth],
    ];
    elements.stats.replaceChildren();
    for (const [label, value] of items) {
      const item = create("span");
      item.append(create("strong", "", formatNumber(value)), ` ${label}`);
      elements.stats.append(item);
    }
    const time = create("span");
    time.append(create("strong", "", `${elapsed < 10 ? elapsed.toFixed(1) : Math.round(elapsed)} ms`));
    elements.stats.append(time);
  }

  /* ---------------------------------------------------------------------- */
  /* Warnings                                                               */
  /* ---------------------------------------------------------------------- */

  function renderWarnings(warnings) {
    elements.warningsList.replaceChildren();
    elements.warningsCount.textContent = formatNumber(warnings.length);
    elements.warningsCount.classList.toggle("has-warnings", warnings.length > 0);
    elements.warningsEmpty.hidden = warnings.length > 0;
    elements.warningsEmpty.textContent = "No warnings: the input was parsed without problems.";

    const fragment = document.createDocumentFragment();
    for (const warning of warnings) {
      const hasPosition = warning.line !== null;
      const item = create("li");
      const button = create("button", "warning");
      button.type = "button";
      button.disabled = !hasPosition;
      button.append(
        create("span", "warning__code", warning.code),
        create("span", "warning__message", warning.message),
        create("span", "warning__position", hasPosition ? `${warning.line}:${warning.column}` : ""),
      );
      if (hasPosition) {
        button.title = `Go to line ${warning.line}, column ${warning.column}`;
        button.addEventListener("click", () => revealPosition(warning.line, warning.column));
      }
      item.append(button);
      fragment.append(item);
    }
    elements.warningsList.append(fragment);
  }

  // Selects the character a warning points to and scrolls the input to it.
  function revealPosition(line, column) {
    const { input } = elements;
    const { value } = input;
    let offset = 0;
    for (let currentLine = 1; currentLine < line; currentLine += 1) {
      const next = value.indexOf("\n", offset);
      if (next === -1) break;
      offset = next + 1;
    }
    // The parser drops a leading BOM; the textarea may still contain it.
    const bomShift = value.charCodeAt(0) === 0xfeff && line === 1 ? 1 : 0;
    const start = Math.min(offset + column - 1 + bomShift, value.length);
    const lineEnd = value.indexOf("\n", start);
    const end = lineEnd === -1 ? value.length : lineEnd;

    input.focus({ preventScroll: true });
    input.setSelectionRange(start, Math.max(end, start + 1));
    const lineHeight = parseFloat(getComputedStyle(input).lineHeight) || 20;
    input.scrollTop = Math.max(0, (line - 4) * lineHeight);
  }

  /* ---------------------------------------------------------------------- */
  /* JSON view: exactly the text that "Save .json" writes, highlighted       */
  /* ---------------------------------------------------------------------- */

  function renderJson(fullText, pretty) {
    const view = elements.jsonView;
    view.hidden = false;
    view.scrollTop = 0;
    view.scrollLeft = 0;
    // Compact JSON is one line; browsers do not draw a line millions of
    // characters long, so it is wrapped instead.
    view.classList.toggle("json-view--wrap", !pretty);

    // Only the beginning of a huge result is shown; Copy and Save use all of it.
    const jsonText = textForDisplay(fullText);
    const notes = [formatBytes(fullText.length)];
    if (!pretty) notes.push("compact: too large or deep to indent");
    if (jsonText.length < fullText.length) notes.push("beginning shown, Save .json has all");
    if (jsonText.length > HIGHLIGHT_LIMIT) notes.push("no highlighting");
    elements.outputMeta.textContent = notes.join(" · ");

    if (jsonText.length > HIGHLIGHT_LIMIT) {
      view.textContent = jsonText;
      return;
    }

    const fragment = document.createDocumentFragment();
    let last = 0;
    JSON_TOKEN.lastIndex = 0;
    for (let match = JSON_TOKEN.exec(jsonText); match !== null; match = JSON_TOKEN.exec(jsonText)) {
      if (match.index > last) fragment.append(jsonText.slice(last, match.index));
      if (match[1] !== undefined) {
        fragment.append(token(match[2] ? "tok-key" : "tok-string", match[1]));
        if (match[2]) fragment.append(token("tok-punct", match[2]));
      } else {
        fragment.append(token(/^[tfn]/.test(match[0]) ? "tok-literal" : "tok-number", match[0]));
      }
      last = JSON_TOKEN.lastIndex;
    }
    if (last < jsonText.length) fragment.append(jsonText.slice(last));
    view.replaceChildren(fragment);
  }

  /* ---------------------------------------------------------------------- */
  /* Copy, save                                                             */
  /* ---------------------------------------------------------------------- */

  async function copyJson() {
    if (!state.result) return;
    try {
      await navigator.clipboard.writeText(state.jsonText);
      showToast("JSON copied to clipboard");
    } catch {
      showToast("Copying is not allowed here; use Save .json instead");
    }
  }

  function saveJson() {
    if (!state.result) return;
    const blob = new Blob([state.jsonText], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = create("a");
    link.href = url;
    link.download = `${state.baseName}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`Saved ${state.baseName}.json`);
  }

  /* ---------------------------------------------------------------------- */
  /* Events                                                                 */
  /* ---------------------------------------------------------------------- */

  elements.convertButton.addEventListener("click", convert);
  elements.preserveWhitespace.addEventListener("change", convert);
  elements.copyButton.addEventListener("click", copyJson);
  elements.saveButton.addEventListener("click", saveJson);

  elements.clearButton.addEventListener("click", () => {
    elements.input.value = "";
    elements.fileName.textContent = "";
    state.baseName = "result";
    updateInputMeta();
    elements.input.focus();
  });

  for (const button of document.querySelectorAll("[data-example]")) {
    button.addEventListener("click", () => {
      const example = EXAMPLES[button.dataset.example];
      setInput(example.html, example.name, `${example.name}.html`);
    });
  }

  let metaTimer = 0;
  elements.input.addEventListener("input", () => {
    clearTimeout(metaTimer);
    metaTimer = setTimeout(updateInputMeta, 150);
  });

  elements.input.addEventListener("keydown", (event) => {
    // Tab inserts indentation instead of leaving the editor.
    if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      elements.input.setRangeText("  ", elements.input.selectionStart, elements.input.selectionEnd, "end");
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      convert();
    }
  });

  elements.fileInput.addEventListener("change", () => {
    loadFile(elements.fileInput.files[0]);
    elements.fileInput.value = ""; // allows loading the same file again
  });

  // Drag and drop. A counter is used because dragenter/dragleave also fire
  // when the pointer moves over child elements.
  let dragDepth = 0;
  elements.dropzone.addEventListener("dragenter", (event) => {
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    dragDepth += 1;
    elements.dropzone.classList.add("is-dragging");
  });
  elements.dropzone.addEventListener("dragover", (event) => {
    if (dragDepth > 0) event.preventDefault();
  });
  elements.dropzone.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) elements.dropzone.classList.remove("is-dragging");
  });
  elements.dropzone.addEventListener("drop", (event) => {
    if (dragDepth === 0) return;
    event.preventDefault();
    dragDepth = 0;
    elements.dropzone.classList.remove("is-dragging");
    loadFile(event.dataTransfer.files[0]);
  });

  // Start with something to look at.
  setInput(EXAMPLE_HTML_1, "example-1", "example-1.html");
})();
