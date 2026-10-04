/** True when the session went from empty (you alone) to having a player — the
 *  moment to raise the border alert. False for later arrivals once someone is
 *  already in, for a player leaving, or while still alone. */
export function enteredWhileAlone(prevCount: number, currCount: number): boolean {
  return prevCount === 0 && currCount > 0;
}
