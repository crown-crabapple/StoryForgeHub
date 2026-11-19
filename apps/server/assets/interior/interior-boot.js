// Book interior preview (contract M13-J05 section 5). Runs inside the preview document, after paged.js. No imports and no network: it moves the body into a template, waits for the
// fonts, lays the pages out with Paged.js from the CSS text of the document's own style element, measures the pages, and publishes the summary on window.storyforgeInterior and to
// the parent page (same origin only).
/* global Paged */
(function () {
  'use strict';
  var startedAt = typeof performance === 'undefined' ? 0 : performance.now();

  function publish(summary) {
    window.storyforgeInterior = summary;
    try {
      window.parent.postMessage(Object.assign({ type: 'storyforge-interior' }, summary), location.origin);
    } catch {
      /* no parent page to tell */
    }
  }

  function failed(error) {
    var message = error && error.message ? error.message : String(error);
    publish({ state: 'failed', pages: 0, ms: Math.round(performance.now() - startedAt), problems: [], message: message });
  }

  var collapse = function (text) {
    return String(text).replace(/\s+/g, '');
  };

  function isHeading(el) {
    return /^H[1-6]$/.test(el.tagName);
  }

  /** The first (or last) heading or paragraph of a page's flow, going down through the wrapper elements. */
  function edgeBlock(root, last) {
    var el = root;
    for (var depth = 0; depth < 20; depth++) {
      var child = last ? el.lastElementChild : el.firstElementChild;
      if (!child) return el === root ? null : el;
      if (isHeading(child) || child.tagName === 'P') return child;
      el = child;
    }
    return el === root ? null : el;
  }

  /**
   * The number of distinct line boxes in a list of client rects (an element's Range client rects). Rects with no width or height are ignored; the rest are grouped by their vertical
   * centres, so rects on one line (inline elements, several text fragments) count once. Two rects are on the same line when their centres are within half a line height.
   * @param {{ top: number, bottom: number, width: number, height: number }[]} rects
   */
  function countLines(rects) {
    var boxes = Array.prototype.slice.call(rects || []).filter(function (r) {
      return r.width > 0 && r.height > 0;
    });
    if (boxes.length === 0) return 0;
    var heights = boxes
      .map(function (r) {
        return r.height;
      })
      .sort(function (a, b) {
        return a - b;
      });
    var half = heights[Math.floor(heights.length / 2)] / 2;
    var centres = boxes
      .map(function (r) {
        return (r.top + r.bottom) / 2;
      })
      .sort(function (a, b) {
        return a - b;
      });
    var lines = 1;
    var lineCentre = centres[0];
    centres.forEach(function (c) {
      if (c - lineCentre > half) {
        lines += 1;
        lineCentre = c;
      }
    });
    return lines;
  }

  /**
   * The widow and orphan problems of one page, from its first and last block. Each is null or { paragraph, continuesFrom, continuesOnto, lines }.
   * A widow is the first paragraph, continued from the page before, filling one line here; an orphan is the last paragraph, continued onto the next page, filling one line here.
   * A paragraph that is not split is never either.
   */
  function edgeProblems(first, last) {
    var kinds = [];
    if (first && first.paragraph && first.continuesFrom && first.lines === 1) kinds.push('widow');
    if (last && last.paragraph && last.continuesOnto && last.lines === 1) kinds.push('orphan');
    return kinds;
  }

  globalThis.StoryforgeInteriorCheck = { countLines: countLines, edgeProblems: edgeProblems };
  if (typeof document === 'undefined') return;

  function lineCount(el) {
    var range = document.createRange();
    range.selectNodeContents(el);
    return countLines(range.getClientRects());
  }

  function measure(pages, sourceText) {
    var problems = [];
    var text = '';
    pages.forEach(function (page, index) {
      var number = Number(page.getAttribute('data-page-number')) || index + 1;
      var content = page.querySelector('.pagedjs_page_content');
      if (!content) return;
      text += content.textContent;
      if (content.scrollHeight > content.clientHeight + 1) {
        problems.push({ kind: 'clipped', page: number, message: 'The text on this page is taller than the page area and is cut off.' });
      }
      var flow = content.firstElementChild || content;
      var first = edgeBlock(flow, false);
      var last = edgeBlock(flow, true);
      if (last && isHeading(last) && !last.closest('.front, .part')) {
        problems.push({ kind: 'strandedHeading', page: number, message: 'A heading is the last thing on this page; its text starts on the next page.' });
      }
      var describe = function (el) {
        if (!el || el.tagName !== 'P') return null;
        return {
          paragraph: true,
          continuesFrom: el.hasAttribute('data-split-from'),
          continuesOnto: el.hasAttribute('data-split-to'),
          lines: lineCount(el),
        };
      };
      edgeProblems(describe(first), describe(last)).forEach(function (kind) {
        problems.push(
          kind === 'widow'
            ? { kind: 'widow', page: number, message: 'This page starts with a single line that finishes a paragraph from the page before.' }
            : { kind: 'orphan', page: number, message: 'This page ends with a single line that begins a paragraph continued on the next page.' },
        );
      });
    });
    var got = collapse(text);
    var want = collapse(sourceText);
    if (got !== want) {
      var at = 0;
      while (at < got.length && at < want.length && got.charAt(at) === want.charAt(at)) at += 1;
      problems.push({
        kind: 'missingText',
        page: null,
        message: 'The text of the laid-out pages differs from the text of the book (' + got.length + ' characters on the pages, ' + want.length + ' in the book), from character ' + (at + 1) + '.',
        expected: want.slice(Math.max(0, at - 20), at + 40),
        actual: got.slice(Math.max(0, at - 20), at + 40),
      });
    }
    return problems;
  }

  async function run() {
    var styleEl = document.querySelector('style');
    var cssText = styleEl ? styleEl.textContent : '';
    if (styleEl) styleEl.remove();
    var template = document.createElement('template');
    while (document.body.firstChild) template.content.appendChild(document.body.firstChild);
    var sourceText = template.content.textContent;
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    if (typeof Paged === 'undefined' || !Paged.Previewer) throw new Error('paged.js did not load');
    var sheets = {};
    sheets[location.href] = cssText;
    var flow = await new Paged.Previewer().preview(template.content, [sheets], document.body);
    var pages = Array.prototype.slice.call(document.querySelectorAll('.pagedjs_page'));
    var problems = measure(pages, sourceText);
    publish({ state: 'done', pages: flow && flow.total ? flow.total : pages.length, ms: Math.round(performance.now() - startedAt), problems: problems });
  }

  function start() {
    run().catch(failed);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
