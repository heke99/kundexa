"use client";

import { useMemo, useState } from "react";
import { assignPlatformPhoneNumber } from "@/app/actions/rinkel";
import { Field, SelectField } from "@/components/ui/form-field";

type NumberOption = {
  id: string;
  number: string;
  label: string | null;
};

type TenantOption = {
  id: string;
  name: string;
};

type TeamOption = {
  id: string;
  tenantId: string;
  name: string;
  memberCount: number;
};

type SellerOption = {
  userId: string;
  tenantId: string;
  label: string;
  mapped: boolean;
};

type ProviderUserOption = {
  id: string;
  label: string;
  hasDevice: boolean;
  allocatedTenantId: string | null;
};

type Scope = "tenant" | "team" | "user";

const scopeLabels: Record<Scope, string> = {
  tenant: "Hela bolaget",
  team: "Ett eller flera team",
  user: "En enskild säljare",
};

const scopeHints: Record<Scope, string> = {
  tenant: "Alla aktiva medlemmar i bolaget får ringa med numret, och numret blir bolagets standard-caller-ID.",
  team: "Alla aktiva medlemmar i de valda teamen får ringa med numret, som också blir teamets standard-caller-ID.",
  user: "Bara den valda säljaren får numret som sitt personliga standard-caller-ID.",
};

export function PlatformNumberAssignmentForm({
  numbers,
  tenants,
  teams,
  sellers,
  providerUsers,
}: {
  numbers: NumberOption[];
  tenants: TenantOption[];
  teams: TeamOption[];
  sellers: SellerOption[];
  providerUsers: ProviderUserOption[];
}) {
  const [scope, setScope] = useState<Scope>("tenant");
  const [tenantId, setTenantId] = useState("");
  const [sellerId, setSellerId] = useState("");

  const scopedTeams = useMemo(
    () => teams.filter((team) => !tenantId || team.tenantId === tenantId),
    [teams, tenantId],
  );
  const scopedSellers = useMemo(
    () => sellers.filter((seller) => !tenantId || seller.tenantId === tenantId),
    [sellers, tenantId],
  );
  const selectedSeller = scopedSellers.find((seller) => seller.userId === sellerId) ?? null;
  const selectableProviderUsers = useMemo(
    () => providerUsers.filter(
      (user) => !user.allocatedTenantId || !selectedSeller || user.allocatedTenantId === selectedSeller.tenantId,
    ),
    [providerUsers, selectedSeller],
  );
  const teamsByTenant = useMemo(() => {
    const grouped = new Map<string, TeamOption[]>();
    for (const team of scopedTeams) grouped.set(team.tenantId, [...(grouped.get(team.tenantId) ?? []), team]);
    return grouped;
  }, [scopedTeams]);

  return <form action={assignPlatformPhoneNumber} className="form-stack">
    <input type="hidden" name="scope" value={scope} />

    <SelectField label="Telefonnummer" name="number_id" required>
      <option value="">Välj nummer</option>
      {numbers.map((number) => <option key={number.id} value={number.id}>
        {number.number}{number.label ? ` · ${number.label}` : ""}
      </option>)}
    </SelectField>

    <fieldset className="team-assignment-grid">
      <legend>Vem ska få numret?</legend>
      <div className="team-assignment-group">
        {(Object.keys(scopeLabels) as Scope[]).map((option) => <label className="team-assignment-option" key={option}>
          <input
            type="radio"
            name="scope_choice"
            value={option}
            checked={scope === option}
            onChange={() => setScope(option)}
          />
          <span style={{ flex: 1 }}>{scopeLabels[option]}</span>
        </label>)}
      </div>
      <p className="muted">{scopeHints[scope]}</p>
    </fieldset>

    <SelectField
      label={scope === "team" ? "Bolag (valfritt filter)" : "Bolag"}
      name="tenant_id"
      value={tenantId}
      required={scope === "tenant"}
      onChange={(event) => { setTenantId(event.target.value); setSellerId(""); }}
    >
      <option value="">{scope === "team" ? "Alla bolag" : "Välj bolag"}</option>
      {tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}
    </SelectField>

    {scope === "team" ? <fieldset className="team-assignment-grid">
      <legend>Team som ska få numret</legend>
      {[...teamsByTenant.entries()].map(([tenant, tenantTeams]) => <div className="team-assignment-group" key={tenant}>
        <strong>{tenants.find((item) => item.id === tenant)?.name ?? tenant}</strong>
        {tenantTeams.map((team) => <label className="team-assignment-option" key={team.id}>
          <input type="checkbox" name="team_ids" value={team.id} />
          <span style={{ flex: 1 }}>{team.name} · {team.memberCount} aktiva medlemmar</span>
        </label>)}
      </div>)}
      {scopedTeams.length ? null : <p className="muted">Inga aktiva team i urvalet.</p>}
    </fieldset> : null}

    {scope === "user" ? <>
      <SelectField
        label="Säljare"
        name="user_ids"
        value={sellerId}
        required
        onChange={(event) => setSellerId(event.target.value)}
      >
        <option value="">Välj säljare</option>
        {scopedSellers.map((seller) => <option key={`${seller.tenantId}:${seller.userId}`} value={seller.userId}>
          {seller.label}{seller.mapped ? " · redan kopplad" : ""}
        </option>)}
      </SelectField>
      <SelectField
        label="Telefoni-användare hos leverantören (valfritt)"
        name="rinkel_user_id"
      >
        <option value="">Matcha automatiskt på e-postadress</option>
        {selectableProviderUsers.map((user) => <option key={user.id} value={user.id}>
          {user.label}{user.hasDevice ? "" : " · saknar registrerad enhet"}
        </option>)}
      </SelectField>
      <p className="muted">
        Välj telefoni-användare manuellt när säljarens Kundexa-adress skiljer sig från adressen hos telefonileverantören.
        Utan val kopplas säljaren automatiskt när adresserna matchar entydigt.
      </p>
    </> : null}

    <Field label="Anledning (valfritt)" name="reason" placeholder="Loggas i plattformens revisionsspår" />
    <button className="button button-primary">Tilldela och aktivera</button>
  </form>;
}
