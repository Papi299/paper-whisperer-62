/**
 * Safe error message extraction for catch blocks.
 *
 * Replaces the widespread `catch (error: any) { error.message }` pattern
 * which produces "undefined" for non-Error throws.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (
    error !== null &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return "An unexpected error occurred";
}
