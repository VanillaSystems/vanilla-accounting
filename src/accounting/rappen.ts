/**
 * The one rounding rule for money: to the Rappen, half away from zero, so a storno
 * rounds to the exact negative of the entry it reverses (Math.round alone sends
 * -0.125 to -0.12 but 0.125 to 0.13).
 */
export function toRappen(amount: number): number {
  const rappen = Math.round(Math.abs(amount) * 100);
  return amount < 0 ? 0 - rappen : rappen; // 0 - 0 is +0; -rappen would yield -0
}

export function fromRappen(rappen: number): number {
  return rappen / 100;
}

export function roundCHF(amount: number): number {
  return fromRappen(toRappen(amount));
}
