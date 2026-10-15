import type { PdfField } from "./pdf-field-template";

/** An occurrence is addressed by its original array index, never by page alone. */
export function editPdfPlacement(fields: PdfField[], fieldId: string, placementIndex: number, patch: Partial<PdfField["placements"][number]>): PdfField[] {
  return fields.map(field => field.id === fieldId ? { ...field, placements: field.placements.map((area, index) => index === placementIndex ? { ...area, ...patch } : area) } : field);
}
