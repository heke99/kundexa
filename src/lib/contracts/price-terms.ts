export function normalizeVariableFees(value: unknown) {
  const fees = Array.isArray(value) ? value : [];
  const total = fees.reduce((sum, fee) => {
    if (!fee || typeof fee !== "object") return sum;
    const row = fee as Record<string, unknown>;
    const candidate = row.amount ?? row.value ?? row.price ?? row.unit_price ?? 0;
    const numeric = Number(candidate);
    return Number.isFinite(numeric) ? sum + numeric : sum;
  }, 0);
  return { fees, total };
}
