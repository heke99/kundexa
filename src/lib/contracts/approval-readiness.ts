import { requiredTemplateVariableNames } from "@/lib/domain/template";

export function contractApprovalProblems(input: {
  productId: string | null; productActive: boolean;
  title: string; body: string; terms: string;
  price: Record<string, unknown> | null;
}): string[] {
  const problems:string[]=[];
  const plainText = (value: string) => value.replace(/<[^>]*>/g, " ").trim();
  if(!plainText(input.title) || !plainText(input.body))problems.push("Mallen behöver en titel och fullständig avtalstext.");
  if(!input.productId || !input.productActive)problems.push("Koppla mallen till en aktiv produkt före godkännande.");
  const plain=plainText(input.terms);
  if(!plain || /(?:här\s+ska|\bTODO\b|\bTBD\b|\[fyll\s+i)/i.test(plain))problems.push("Villkoren innehåller instruktionstext. Ersätt den med beslutade slutvillkor.");
  if(!input.price)problems.push("Produkten behöver en aktiv prisversion som gäller idag.");
  const required=requiredTemplateVariableNames(input.title,input.body,input.terms);
  for(const name of required.filter(name=>name.startsWith("price."))) {
    const value=input.price?.[name.slice(6)];
    if(value===null || value===undefined || value==="")problems.push(`Prisversionen saknar obligatoriskt värde för ${name}. Ange det beslutade värdet eller gör variabeln uttryckligen valfri.`);
  }
  return problems;
}
