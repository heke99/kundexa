import assert from "node:assert/strict";
import { deflateRawSync, crc32 } from "node:zlib";
import { extractDocumentText, DocumentTextError } from "../src/lib/contracts/document-text";
import {
  allTemplatePlaceholders, buildTemplateRenderContext, describeTemplateVariableProblem,
  missingContextFields, templateContextFields, validateTemplateVariables,
} from "../src/lib/contracts/template-context";
import { renderStrictTemplate, templateVariableNames } from "../src/lib/domain/template";

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

  // --- Placeholders -------------------------------------------------------
  // The whole point is to fail at authoring time rather than at send time, so a
  // correct template must pass untouched and a plausible wrong guess must not.
  assert.deepEqual(
    validateTemplateVariables(["customer.display_name", "seller.legal_name", "price.recurring_fee", "today"]),
    [],
  );

  const guessed = validateTemplateVariables(["customer.address"]);
  assert.equal(guessed.length, 1);
  assert.equal(guessed[0].reason, "unknown_field");
  assert.equal(guessed[0].suggestion, "customer.address_line1");
  assert.match(describeTemplateVariableProblem(guessed[0]), /customer\.address_line1/);

  assert.equal(validateTemplateVariables(["kund.namn"])[0].reason, "unknown_root");
  assert.equal(validateTemplateVariables(["customer"])[0].reason, "root_is_not_a_value");
  assert.equal(validateTemplateVariables(["customer.address_line1.street"])[0].reason, "too_deep");
  assert.equal(validateTemplateVariables(["today.now"])[0].reason, "too_deep");
  // A wrong field that resembles nothing gets no suggestion: a confident wrong
  // hint is worse than none.
  assert.equal(validateTemplateVariables(["customer.zzzzzzzzzz"])[0].suggestion, null);

  // The seller's branding is a JSON object, and renderStrictTemplate refuses a
  // non-scalar. Advertising it would hand the author a placeholder that always
  // fails, so it must not be in the declaration.
  assert.ok(!(templateContextFields.seller as readonly string[]).includes("branding"));

  // --- One context for both paths -----------------------------------------
  const context = buildTemplateRenderContext({
    seller: { id: "s1", legal_name: "Kundexa AB", organization_number: "5560000000", address_line1: "Gatan 1",
      postal_code: "21115", city: "Malmö", country_code: "SE", email: "avtal@example.test",
      phone_e164: "+46401234567", website: "https://example.test" },
    customer: { id: "c1", customer_type: "company", display_name: "Kund AB", first_name: "Anna", last_name: "Andersson",
      company_name: "Kund AB", personal_identity_number: "19800101-0000", organization_number: "5569999999",
      email: "kund@example.test", phone_e164: "+46700000000", address_line1: "Kundgatan 2",
      postal_code: "11122", city: "Stockholm", country_code: "SE" },
    product: null,
    price: { currency: "SEK", setup_fee: 0, recurring_fee: 499, variable_fee: 0,
      binding_months: null, notice_months: null, payment_terms_days: null },
    contract: { title: "Avtal", sales_channel: "telephone", audience: "B2B", language: "sv" },
  });
  assert.deepEqual(missingContextFields(context), []);

  // Every placeholder the authoring screen advertises must actually render. This
  // is what stops the list on the page from promising a field that blows up.
  const everyPlaceholder = allTemplatePlaceholders().map((name) => `{{${name}}}`).join(" ");
  assert.deepEqual(templateVariableNames(everyPlaceholder), allTemplatePlaceholders());
  const rendered = renderStrictTemplate(everyPlaceholder, context);
  assert.match(rendered, /Kund AB/);
  // An absent optional value arrives as readable Swedish rather than as nothing,
  // or the strict renderer would refuse the whole template.
  assert.match(rendered, /Ingen bindningstid/);
  assert.match(rendered, /Ingen produkt/);
  assert.match(rendered, /Inga särskilda villkor/);

  console.log("Contract template placeholder tests passed: correct templates accepted, a misremembered field is rejected with the real name, no non-scalar field is advertised, one context serves both render paths, and every advertised placeholder renders.");

  console.log("Contract template document tests passed: docx paragraphs, tabs, line breaks, entities, stored entries, blank-line collapsing, plain text, HTML, and every refused format.");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
