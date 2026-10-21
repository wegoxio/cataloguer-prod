/**
 * Password policy for NEW passwords — must match the backend's
 * IsStrongUserPassword decorator (10+ chars, upper, lower, number, symbol).
 * Existing passwords keep working; only creation/change is validated.
 */
export const PASSWORD_POLICY_HINT = 'At least 10 characters, with uppercase, lowercase, a number and a symbol.';

export function isStrongPassword(password: string): boolean {
  return (
    password.length >= 10 &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  );
}
