import { randomInt } from "crypto";

const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz";
const DIGITS = "23456789";
const CHARSET = LETTERS + DIGITS;

// Matches the initial-password policy enforced in UsersService
// (assertValidInitialPassword): >=10 chars, letters and digits only, at
// least one of each. Ambiguous characters (0/O, 1/l/I) are excluded so the
// password is easy to retype from an email on a phone.
export function generateTemporaryPassword(length = 12): string {
  const chars = [
    LETTERS[randomInt(LETTERS.length)],
    DIGITS[randomInt(DIGITS.length)],
  ];
  for (let i = chars.length; i < length; i++) {
    chars.push(CHARSET[randomInt(CHARSET.length)]);
  }
  // Fisher-Yates shuffle so the guaranteed letter/digit aren't always first.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
