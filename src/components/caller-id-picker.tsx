import { saveCallerIdDefault } from "@/app/actions/telephony";
import { SelectField } from "@/components/ui/form-field";

export type CallerIdNumber = { id: string; number_e164: string };

/**
 * Vilket nummer mottagaren ser.
 *
 * Samma formulär på företaget, teamet, listan och kampanjen, därför att det är
 * samma val. Att skriva det fyra gånger hade gjort att fyra ställen behöver
 * ändras nästa gång regeln gör det -- och att tre av dem hade glömts bort.
 *
 * `inherits` är hela poängen med att visa det per nivå. Utan den meningen ser
 * "Inget valt" ut som "ingen ringer härifrån", när det i själva verket betyder
 * att nivån ovanför bestämmer. Den som ska byta nummer för ett team behöver
 * veta vilket nummer teamet visar i dag, inte bara att fältet är tomt.
 */
export function CallerIdPicker({
  scope,
  scopeId,
  label,
  current,
  numbers,
  inherits,
  returnTo,
}: {
  scope: "tenant" | "team" | "list" | "campaign";
  scopeId?: string;
  label: string;
  current: string | null;
  numbers: CallerIdNumber[];
  /** Numret som gäller när inget är valt här, med var det kommer ifrån. */
  inherits?: { number: string; source: string } | null;
  returnTo: string;
}) {
  if (numbers.length === 0) {
    return <div className="notice warning">
      Företaget har inget aktivt nummer med rösttrafik, så det finns inget att välja.
      Lägg till ett nummer under Integrationer först.
    </div>;
  }

  const inheritedLabel = inherits
    ? `Ärver ${inherits.number} från ${inherits.source}`
    : "Inget valt";

  return <form action={saveCallerIdDefault} className="form-stack">
    <input type="hidden" name="scope" value={scope} />
    {scopeId ? <input type="hidden" name="scope_id" value={scopeId} /> : null}
    <input type="hidden" name="return_to" value={returnTo} />
    <SelectField label={label} name="phone_number_id" defaultValue={current ?? ""}>
      <option value="">{inheritedLabel}</option>
      {numbers.map((number) => (
        <option key={number.id} value={number.id}>{number.number_e164}</option>
      ))}
    </SelectField>
    <button className="button button-secondary">Spara utgående nummer</button>
  </form>;
}
