/* Shared by streaming and final answers. Model text is never trusted HTML. */
(function (root) {
  function createAnswerFormatter({ Marked, DOMPurify, katex }) {
    const parser = new Marked({ gfm: true, breaks: true });
    const math = (name, level, pattern, start) => ({
      name, level,
      start,
      tokenizer(source) {
        const match = pattern.exec(source);
        if (match) return { type: name, raw: match[0], text: match[1] ?? match[2] };
      },
      renderer(token) {
        return katex.renderToString(token.text.trim(), {
          displayMode: name === 'displayMath', throwOnError: false, trust: false, maxExpand: 1000
        });
      }
    });
    parser.use({ extensions: [
      math('displayMath', 'block', /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])(?:\n|$)/, source => {
        const index = source.search(/\$\$|\\\[/); return index < 0 ? undefined : index;
      }),
      math('inlineMath', 'inline', /^\$([^$\n]+?)\$(?!\d)/, source => {
        const index = source.indexOf('$'); return index < 0 ? undefined : index;
      }),
      math('parenMath', 'inline', /^\\\(([\s\S]+?)\\\)/, source => {
        const index = source.indexOf('\\('); return index < 0 ? undefined : index;
      })
    ] });
    return text => DOMPurify.sanitize(parser.parse(String(text)), {
      FORBID_TAGS: ['img', 'style', 'iframe', 'form', 'input', 'button'],
      FORBID_ATTR: ['id', 'name'], ALLOW_DATA_ATTR: false
    });
  }
  if (typeof module === 'object' && module.exports) module.exports = { createAnswerFormatter };
  else root.createAnswerFormatter = createAnswerFormatter;
})(globalThis);
