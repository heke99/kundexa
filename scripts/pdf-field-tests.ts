import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PDFDocument, degrees } from "pdf-lib";
import { freezePdfTemplate, isTenantPdfTemplatePath, validatePdfTemplate, type PdfFieldTemplate } from "../src/lib/contracts/pdf-field-template";
import { inspectTemplatePdf, renderPdfFields } from "../src/lib/contracts/render-pdf-fields";

async function main() {
  const pdf = await PDFDocument.create(); pdf.addPage([600, 800]); pdf.addPage([600, 800]);
  const bytes = await pdf.save();
  const tenant = "tenant-a";
  const template: PdfFieldTemplate = { schemaVersion: 1, storagePath: `${tenant}/templates/source/${"a".repeat(64)}.pdf`, sha256: createHash("sha256").update(bytes).digest("hex"), pageSizes: await inspectTemplatePdf(bytes), fields: [{ id: "customer_name", label: "Kundnamn", providerName: "customer_name", type: "text", source: "customer.display_name", required: true, fontSize: 11, placements: [{ page: 0, x: .1, y: .1, width: .7, height: .05 }, { page: 1, x: .1, y: .2, width: .7, height: .05 }] }] };
  assert.equal(isTenantPdfTemplatePath(template.storagePath, tenant), true);
  for (const unsafe of [
    `${tenant}/templates/%2e%2e/%2e%2e/tenant-b/source/${"a".repeat(64)}.pdf`,
    `${tenant}/templates/source/${"a".repeat(64)}.pdf?download=other`,
    `${tenant}/templates/source/${"a".repeat(64)}.pdf#fragment`,
    `${tenant}/templates/source\\${"a".repeat(64)}.pdf`,
  ]) {
    assert.equal(isTenantPdfTemplatePath(unsafe, tenant), false);
    assert.throws(() => validatePdfTemplate({ ...template, storagePath: unsafe }, tenant), /tenant_mismatch/);
  }
  assert.throws(() => validatePdfTemplate(template, "tenant-b"), /tenant_mismatch/);
  assert.throws(() => validatePdfTemplate({ ...template, fields: [...template.fields, template.fields[0]] }, tenant), /duplicate/);
  assert.throws(() => validatePdfTemplate({ ...template, fields: [{ ...template.fields[0], source: "customer.secret" }] }, tenant), /unknown_source/);
  assert.throws(() => validatePdfTemplate({ ...template, fields: [{ ...template.fields[0], placements: [{ page: 2, x: 0, y: 0, width: .2, height: .1 }] }] }, tenant), /outside_page/);
  const context = { customer: { display_name: "Åsa Ängström Öberg" } };
  const frozen = freezePdfTemplate({ pdf_template: template }, context, tenant)!;
  context.customer.display_name = "Ändrat efter fryst avtal";
  assert.equal(frozen.values.customer_name, "Åsa Ängström Öberg");
  assert.throws(() => freezePdfTemplate({ pdf_template: template }, { customer: {} }, tenant), /required_value/);
  const rendered = await renderPdfFields(bytes, frozen);
  assert.equal((await PDFDocument.load(rendered)).getPageCount(), 2);
  assert.equal(createHash("sha256").update(rendered).digest("hex"), createHash("sha256").update(await renderPdfFields(bytes, frozen)).digest("hex"), "Identical snapshot produces identical PDF bytes for retry");
  assert.notEqual(createHash("sha256").update(rendered).digest("hex"), template.sha256);
  await assert.rejects(renderPdfFields(bytes, { ...frozen, values: { customer_name: "X".repeat(1000) } }), /overflow/);
  const rotated = await PDFDocument.create(); rotated.addPage([600, 800]).setRotation(degrees(90));
  await assert.rejects(inspectTemplatePdf(await rotated.save()), /rotation/);
  const interactive = await PDFDocument.create(); const page = interactive.addPage(); interactive.getForm().createTextField("hidden").addToPage(page);
  await assert.rejects(inspectTemplatePdf(await interactive.save()), /interactive_fields/);
  const customTemplate: PdfFieldTemplate = { ...template,
    customFields: [{ id: "delivery_date", label: "Leveransdatum", type: "date", required: true }, { id: "quantity", label: "Antal", type: "number", required: true }],
    fields: [{ ...template.fields[0], source: "custom.delivery_date", type: "date" }, { ...template.fields[0], id: "quantity", providerName: "quantity", source: "custom.quantity" }],
  };
  const custom = freezePdfTemplate({ pdf_template: customTemplate }, {}, tenant, { delivery_date: "2026-10-15", quantity: 0 })!;
  assert.equal(custom.values.customer_name, "2026-10-15"); assert.equal(custom.values.quantity, "0");
  assert.throws(() => freezePdfTemplate({ pdf_template: customTemplate }, {}, tenant, { delivery_date: "2026-02-31", quantity: 1 }), /invalid_date/);
  assert.throws(() => freezePdfTemplate({ pdf_template: customTemplate }, {}, tenant, { delivery_date: "2026-10-15", quantity: "not a number" }), /invalid_number/);
  assert.throws(() => freezePdfTemplate({ pdf_template: customTemplate }, {}, tenant, { delivery_date: "2026-10-15", quantity: 1, recurring_fee: 0 }), /unknown_custom_value/);
  assert.throws(() => freezePdfTemplate({ pdf_template: customTemplate }, {}, tenant, { delivery_date: "2026-10-15" }), /required_value/);
  assert.throws(() => validatePdfTemplate({ ...customTemplate, customFields: [...customTemplate.customFields!, customTemplate.customFields![0]] }, tenant), /duplicate_custom/);
  assert.throws(() => validatePdfTemplate({ ...customTemplate, fields: [{ ...template.fields[0], source: "custom.undefined" }] }, tenant), /unknown_source/);
  const todayTemplate = { ...template, fields: [{ ...template.fields[0], type: "date" as const, source: "today" }] };
  assert.equal(freezePdfTemplate({ pdf_template: todayTemplate }, { today: "15 oktober 2026", today_iso: "2026-10-15" }, tenant)!.values.customer_name, "2026-10-15");
  assert.equal(freezePdfTemplate({}, {}, tenant), null);
  console.log("PDF field tests PASS: two pages, Swedish text, immutable values, tenant/source validation, overflow, rotation and interactive fields.");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
