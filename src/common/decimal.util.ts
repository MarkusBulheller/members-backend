/** Converts a DTO's `number | null | undefined` field into the string form TypeORM decimal
 * columns expect — undefined stays undefined (leave unchanged on update), null stays null (clear
 * the value), a number becomes its string form. */
export function toDecimalString(value: number | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return String(value);
}
