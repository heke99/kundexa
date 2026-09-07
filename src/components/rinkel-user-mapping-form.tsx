"use client";

import { useMemo, useState } from "react";
import { saveRinkelUserMapping } from "@/app/actions/rinkel";
import { SelectField } from "@/components/ui/form-field";

type MemberOption = {
  userId: string;
  label: string;
};

type DeviceOption = {
  id: string;
  displayName: string | null;
  status: string;
  active: boolean;
};

type TelephonyUserOption = {
  allocationId: string;
  displayName: string;
  hasDevice: boolean;
  activeDeviceCount?: number;
  deviceInventoryComplete?: boolean;
  deviceInventorySource?: string | null;
  deviceInventoryError?: string | null;
  active: boolean;
  devices: DeviceOption[];
};

type NumberOption = {
  allocationId: string;
  number: string;
  displayName: string | null;
  active: boolean;
};

export function RinkelUserMappingForm({
  members,
  users,
  numbers,
}: {
  members: MemberOption[];
  users: TelephonyUserOption[];
  numbers: NumberOption[];
}) {
  const [selectedUserAllocationId, setSelectedUserAllocationId] = useState("");
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const selectedUser = useMemo(
    () => users.find((user) => user.allocationId === selectedUserAllocationId) ?? null,
    [selectedUserAllocationId, users],
  );
  const activeDevices = selectedUser?.devices.filter((device) => device.active) ?? [];

  return <form action={saveRinkelUserMapping} className="form-stack">
    <SelectField label="Kundexa-användare" name="kundexa_user_id" required>
      <option value="">Välj användare</option>
      {members.map((member) => <option key={member.userId} value={member.userId}>{member.label}</option>)}
    </SelectField>
    <SelectField
      label="Tilldelad telefoni-användare"
      name="rinkel_user_allocation_id"
      required
      value={selectedUserAllocationId}
      onChange={(event) => {
        const allocationId = event.target.value;
        setSelectedUserAllocationId(allocationId);
        setSelectedDeviceId("");
        const nextUser = users.find((user) => user.allocationId === allocationId);
        const nextDevices = nextUser?.devices.filter((device) => device.active) ?? [];
        if (nextDevices.length === 1) setSelectedDeviceId(nextDevices[0].id);
      }}
    >
      <option value="">Välj telefoni-användare</option>
      {users.map((user) => <option
        key={user.allocationId}
        value={user.allocationId}
        disabled={!user.active}
      >
        {user.displayName} · {user.hasDevice
          ? `${user.activeDeviceCount ?? user.devices.filter((device) => device.active).length} registrerade enheter`
          : user.deviceInventoryError
            ? `enhetsuppgifter kunde inte läsas (${user.deviceInventoryError})`
            : "ingen registrerad enhet ännu"}{user.active ? "" : " · inaktiv"}
      </option>)}
    </SelectField>
    {selectedUser && activeDevices.length === 0 ? <p className="notice warning">
      {selectedUser.deviceInventoryError
        ? `Enhetsuppgifterna hos telefonileverantören kunde inte läsas (${selectedUser.deviceInventoryError}). Mappningen kan sparas ändå; be plattformsadministratören synkronisera katalogen igen.`
        : "Telefonileverantören rapporterar ingen registrerad enhet för den här användaren ännu. Du kan spara mappningen nu — säljaren blir ringklar automatiskt så snart hen loggat in i leverantörens webbtelefon eller app och katalogen synkats om."}
    </p> : null}
    <SelectField
      label="Telefonienhet"
      name="selected_device_id"
      value={selectedDeviceId}
      onChange={(event) => setSelectedDeviceId(event.target.value)}
      disabled={!selectedUserAllocationId || activeDevices.length === 0}
    >
      <option value="">
        {!selectedUserAllocationId
          ? "Välj först telefoni-användare"
          : activeDevices.length
            ? "Använd leverantörens aktuella enhet"
            : "Ingen registrerad enhet ännu"}
      </option>
      {activeDevices.map((device) => <option key={device.id} value={device.id}>
        {device.displayName ?? "Telefonienhet"} · {device.status}
      </option>)}
    </SelectField>
    <SelectField label="Tilldelat standardnummer" name="default_number_allocation_id" required>
      <option value="">Välj telefonnummer</option>
      {numbers.map((number) => <option key={number.allocationId} value={number.allocationId} disabled={!number.active}>
        {number.displayName ? `${number.displayName} · ` : ""}{number.number}{number.active ? "" : " · inaktivt"}
      </option>)}
    </SelectField>
    <p className="muted">
      När mappningen sparas får säljaren automatiskt ringbehörighet till det valda standardnumret. Lämna enheten tom
      för att alltid använda den enhet telefonileverantören rapporterar just nu.
    </p>
    <button className="button button-primary" disabled={!selectedUserAllocationId}>Spara mappning</button>
  </form>;
}
