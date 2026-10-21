import { IsStrongPassword } from 'class-validator';

/**
 * Password policy for every NEWLY created or changed password (existing
 * hashes keep working — login never re-validates). One decorator so the
 * rule can only ever change in one place.
 */
export const PASSWORD_POLICY_MESSAGE =
  'Password must be at least 10 characters and include an uppercase letter, a lowercase letter, a number and a symbol';

export function IsStrongUserPassword(): PropertyDecorator {
  return IsStrongPassword(
    { minLength: 10, minLowercase: 1, minUppercase: 1, minNumbers: 1, minSymbols: 1 },
    { message: PASSWORD_POLICY_MESSAGE },
  );
}
