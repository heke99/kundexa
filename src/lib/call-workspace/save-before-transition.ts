/** Keep the current customer mounted until its draft is durably saved. */
export async function saveBeforeTransition<T>(
  customer: { save: () => Promise<void> } | null,
  next: () => Promise<T>,
): Promise<T> {
  if (!customer) throw new Error("Kundkortet är inte färdigläst. Försök igen.");
  await customer.save();
  return next();
}
