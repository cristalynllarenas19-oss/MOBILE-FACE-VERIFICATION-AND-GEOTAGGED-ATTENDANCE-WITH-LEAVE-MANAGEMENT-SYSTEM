// Standard for a brand-new employee's first password: at least 10
// characters, letters and digits only, with at least one of each.
export type PasswordRequirements = {
  minLength: boolean;
  hasLetter: boolean;
  hasDigit: boolean;
  validCharset: boolean;
  isValid: boolean;
};

export function checkRequirements(password: string): PasswordRequirements {
  const minLength = password.length >= 10;
  const hasLetter = /[A-Za-z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  const validCharset = /^[A-Za-z0-9]*$/.test(password);
  return {
    minLength,
    hasLetter,
    hasDigit,
    validCharset,
    isValid: minLength && hasLetter && hasDigit && validCharset,
  };
}

// Common passwords/words and easily-guessable patterns — a valid (10-char,
// alphanumeric) password can still be weak if it's something an attacker
// would try first.
const COMMON_SUBSTRINGS = [
  "password", "qwerty", "letmein", "welcome", "admin", "login",
  "monkey", "dragon", "master", "changeme", "iloveyou", "trustno",
  "employee", "company", "unileaf", "sunshine", "football", "baseball",
  "princess", "superman", "starwars",
];

function isSequential(password: string): boolean {
  const lower = password.toLowerCase();
  if (lower.length < 5) return false;

  let ascending = true;
  let descending = true;
  for (let i = 1; i < lower.length; i++) {
    const diff = lower.charCodeAt(i) - lower.charCodeAt(i - 1);
    if (diff !== 1) ascending = false;
    if (diff !== -1) descending = false;
  }
  return ascending || descending;
}

function isLowVariety(password: string): boolean {
  return new Set(password.toLowerCase()).size <= 3;
}

// Catches passwords built from a short repeating unit, e.g. "abcabcabca".
function isRepeatingPattern(password: string): boolean {
  for (let unitLength = 1; unitLength <= 4; unitLength++) {
    const unit = password.slice(0, unitLength);
    const rebuilt = unit.repeat(Math.ceil(password.length / unitLength)).slice(0, password.length);
    if (rebuilt === password) return true;
  }
  return false;
}

export type PasswordStrength = "weak" | "strong" | null;

// null means the password doesn't even meet the minimum requirements yet
// (checkRequirements should gate form submission separately).
export function getStrength(password: string): PasswordStrength {
  if (!checkRequirements(password).isValid) return null;

  const lower = password.toLowerCase();
  const isCommon =
    COMMON_SUBSTRINGS.some((word) => lower.includes(word)) ||
    isSequential(password) ||
    isLowVariety(password) ||
    isRepeatingPattern(password);

  return isCommon ? "weak" : "strong";
}
