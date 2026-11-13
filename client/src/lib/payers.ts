/** "Asha" when one person paid, "Asha +2" when Asha paid most of three. */
export function paidByLabel(mainName: string, payerCount: number): string {
  return payerCount > 1 ? `${mainName} +${payerCount - 1}` : mainName;
}
