// DOCX output (Office Open XML, minimal parts). Fixed part order and timestamps, no random ids: same input, same bytes.
import { chapterHeading, partHeading } from './markdown.mjs';
import { parseBlocks, xmlEscape, xmlSafe } from './text.mjs';
import { writeZip } from './zip.mjs';

const NS_W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const PAGES = { letter: { w: 12240, h: 15840 }, a4: { w: 11906, h: 16838 } };

/** @param {string} text @param {{ em?: boolean, strong?: boolean }} [fmt] */
function run(text, { em = false, strong = false } = {}) {
  const props = `${strong ? '<w:b/>' : ''}${em ? '<w:i/>' : ''}`;
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlEscape(xmlSafe(text))}</w:t></w:r>`;
}

/** @param {string} style @param {string} inner @param {string} [extraProps] */
const para = (style, inner, extraProps = '') => `<w:p><w:pPr><w:pStyle w:val="${style}"/>${extraProps}</w:pPr>${inner}</w:p>`;

/** @param {import('./text.mjs').Run[]} runs */
const runsXml = (runs) => runs.map((r) => run(r.text, r)).join('');

/** @param {import('./manuscript.mjs').Manuscript} m */
function documentXml(m) {
  const page = PAGES[m.options.page];
  /** @type {string[]} */
  const body = [];
  if (m.options.titlePage) {
    if (m.title !== '') body.push(para('Title', run(m.title)));
    if (m.subtitle !== '') body.push(para('Subtitle', run(m.subtitle)));
    if (m.author !== '') body.push(para('Author', run(m.author)));
  }
  let first = true;
  for (const part of m.parts) {
    if (m.options.includeActs) body.push(para('PartTitle', run(partHeading(part))));
    let firstInPart = true;
    for (const chapter of part.chapters) {
      // a part title or the start of the document already begins a page; the chapter heading must not add a blank one
      const noBreak = (m.options.includeActs && firstInPart) || (first && !m.options.titlePage);
      body.push(para('Heading1', run(chapterHeading(chapter)), noBreak ? '<w:pageBreakBefore w:val="0"/>' : ''));
      first = false;
      firstInPart = false;
      chapter.scenes.forEach((scene, i) => {
        if (m.options.sceneTitles) {
          if (scene.title !== '') body.push(para('Heading2', run(scene.title)));
        } else if (i > 0) {
          body.push(para('SceneBreak', run('* * *')));
        }
        for (const b of parseBlocks(scene.markdown)) {
          if (b.type === 'break') body.push(para('SceneBreak', run('* * *')));
          else if (b.type === 'heading') body.push(para('Heading2', runsXml(b.runs)));
          else body.push(para('Normal', runsXml(b.runs)));
        }
      });
    }
  }
  const sect = `<w:sectPr><w:pgSz w:w="${page.w}" w:h="${page.h}"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;
  return `${XML_DECL}<w:document ${NS_W}><w:body>${body.join('')}${sect}</w:body></w:document>\n`;
}

function stylesXml(lang) {
  const font = '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/>';
  return `${XML_DECL}<w:styles ${NS_W}>
<w:docDefaults><w:rPrDefault><w:rPr>${font}<w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="${xmlEscape(lang)}"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="480" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:firstLine="720"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="4000" w:after="240" w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240" w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/><w:jc w:val="center"/></w:pPr><w:rPr><w:i/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Author"><w:name w:val="Author"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="480" w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/><w:jc w:val="center"/></w:pPr><w:rPr><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="PartTitle"><w:name w:val="Part Title"/><w:basedOn w:val="Normal"/><w:next w:val="Heading1"/><w:qFormat/><w:pPr><w:pageBreakBefore/><w:spacing w:before="3600" w:after="480" w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:pageBreakBefore/><w:spacing w:before="2400" w:after="480" w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/><w:jc w:val="center"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="240" w:line="240" w:lineRule="auto"/><w:ind w:firstLine="0"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="SceneBreak"><w:name w:val="Scene Break"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:firstLine="0"/><w:jc w:val="center"/></w:pPr></w:style>
</w:styles>
`;
}

/** @param {import('./manuscript.mjs').Manuscript} m @returns {Buffer} */
export function renderDocx(m) {
  const title = xmlEscape(xmlSafe(m.title));
  const files = [
    ['[Content_Types].xml', `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>\n`],
    ['_rels/.rels', `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>\n`],
    ['word/document.xml', documentXml(m)],
    ['word/styles.xml', stylesXml(m.language)],
    ['word/_rels/document.xml.rels', `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>\n`],
    ['docProps/core.xml', `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${title}</dc:title><dc:creator>${xmlEscape(xmlSafe(m.author))}</dc:creator><dc:language>${xmlEscape(m.language)}</dc:language><dcterms:created xsi:type="dcterms:W3CDTF">${m.modified}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${m.modified}</dcterms:modified></cp:coreProperties>\n`],
  ];
  return writeZip(files.map(([name, text]) => ({ name, data: Buffer.from(text, 'utf8') })));
}
