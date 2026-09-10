import assert from "node:assert/strict";
import { deflateRawSync, crc32 } from "node:zlib";
import { extractDocumentText, DocumentTextError } from "../src/lib/contracts/document-text";

// Build a real .docx rather than a fixture file, so the test proves the reader
// against the actual container format instead of against one saved example.
function buildDocx(documentXml: string, { store = false } = {}) {
  const entries = [
    { name: "[Content_Types].xml", body: Buffer.from('<?xml version="1.0"?><Types/>', "utf8") },
    { name: "word/document.xml", body: Buffer.from(documentXml, "utf8") },
  ];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = store ? entry.body : deflateRawSync(entry.body);
    const checksum = crc32(entry.body);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.body.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

const paragraph = (runs: string) => `<w:p><w:r>${runs}</w:r></w:p>`;

async function main() {
  // A contract arrives as paragraphs, and the placeholders the seller will rely on
  // must survive the round trip character for character.
  const body = [
    paragraph('<w:t>Avtal mellan {{seller.legal_name}} och {{customer.display_name}}.</w:t>'),
    paragraph('<w:t xml:space="preserve">Org.nr: </w:t><w:t>{{customer.organization_number}}</w:t>'),
    paragraph('<w:t>Adress:</w:t><w:tab/><w:t>{{customer.address_line1}}</w:t>'),
    paragraph('<w:t>Pris &amp; villkor &lt;se nedan&gt;</w:t>'),
  ].join("");
  const docx = buildDocx(`<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`);
  const extracted = extractDocumentText(docx, "Avtal.docx");
  assert.equal(extracted.sourceType, "docx");
  assert.deepEqual(extracted.text.split("\n"), [
    "Avtal mellan {{seller.legal_name}} och {{customer.display_name}}.",
    "Org.nr: {{customer.organization_number}}",
    "Adress:\t{{customer.address_line1}}",
    "Pris & villkor <se nedan>",
  ]);

  // Word litters documents with empty paragraphs; the body should read like the
  // document, not like its markup.
  const spaced = buildDocx(
    `<?xml version="1.0"?><w:document><w:body>${paragraph("<w:t>Ett</w:t>")}<w:p/><w:p/><w:p/>${paragraph("<w:t>Två</w:t>")}</w:body></w:document>`,
  );
  assert.equal(extractDocumentText(spaced, "spaced.docx").text, "Ett\n\nTvå");

  // Uncompressed entries are legal in a ZIP and some writers emit them.
  const stored = buildDocx(
    `<?xml version="1.0"?><w:document><w:body>${paragraph("<w:t>Okomprimerad</w:t>")}</w:body></w:document>`,
    { store: true },
  );
  assert.equal(extractDocumentText(stored, "stored.docx").text, "Okomprimerad");

  // A line break inside a paragraph is a line break in the template too.
  const withBreak = buildDocx(
    `<?xml version="1.0"?><w:document><w:body>${paragraph("<w:t>Rad ett</w:t><w:br/><w:t>Rad två</w:t>")}</w:body></w:document>`,
  );
  assert.equal(extractDocumentText(withBreak, "break.docx").text, "Rad ett\nRad två");

  assert.equal(extractDocumentText(Buffer.from("Ren text {{customer.city}}"), "avtal.txt").text, "Ren text {{customer.city}}");
  assert.equal(
    extractDocumentText(Buffer.from("<p>Ett</p><p>Tv&aring;</p><script>ignorera()</script>"), "avtal.html").text,
    "Ett\nTvå",
  );

  // PDF is refused deliberately: a garbled contract template is worse than none,
  // and the refusal has to say what to do instead.
  let pdfRefusal: unknown;
  try {
    extractDocumentText(Buffer.from("%PDF-1.4 ..."), "avtal.pdf");
  } catch (error) {
    pdfRefusal = error;
  }
  assert.ok(pdfRefusal instanceof DocumentTextError, "A PDF must be refused with a DocumentTextError");
  assert.match(pdfRefusal.message, /\.docx/);

  assert.throws(() => extractDocumentText(Buffer.from("x"), "avtal.doc"), /\.docx/);
  assert.throws(() => extractDocumentText(Buffer.from("x"), "avtal.rtf"), /stöds inte/);
  assert.throws(() => extractDocumentText(Buffer.alloc(0), "tom.docx"), /tom/);
  assert.throws(() => extractDocumentText(Buffer.from("inte en zip"), "trasig.docx"), /giltigt \.docx/);
  assert.throws(
    () => extractDocumentText(buildDocx('<?xml version="1.0"?><w:document><w:body><w:p/></w:body></w:document>'), "blank.docx"),
    /ingen läsbar text/,
  );

  console.log("Contract template document tests passed: docx paragraphs, tabs, line breaks, entities, stored entries, blank-line collapsing, plain text, HTML, and every refused format.");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
