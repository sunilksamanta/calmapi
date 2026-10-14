// Password rules beyond length (NIST SP 800-63B style): no composition rules,
// but refuse passwords that are known-bad or trivially guessable.

// The most common leaked passwords that are 8+ characters (shorter ones fail the length rule).
const COMMON = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd', 'p@ssw0rd', 'p@ssword',
  '12345678', '123456789', '1234567890', '0987654321', '987654321', '87654321', '11111111', '00000000',
  '88888888', '12341234', '11223344', '12121212', '123123123', '1q2w3e4r', '1q2w3e4r5t', 'q1w2e3r4',
  'qwerty123', 'qwertyuiop', 'qwerty12', 'qwerty1234', '1qaz2wsx', 'zaq12wsx', 'asdfghjkl', 'asdfasdf',
  'aa123456', 'a1234567', 'abcd1234', 'abc12345', 'abcdefgh', 'iloveyou', 'iloveyou1', 'sunshine',
  'princess', 'football', 'baseball', 'superman', 'starwars', 'whatever', 'trustno1', 'welcome1',
  'welcome123', 'admin123', 'administrator', 'changeme', 'letmein1', 'computer', 'michelle', 'jennifer',
  'jordan23', 'liverpool', 'chelsea1', 'pokemon1', 'basketball', 'internet', 'samsung1', 'blink182',
  'test1234', 'testtest', 'pass1234', 'mypassword', 'secret123', 'default1', 'letmein123', 'monkey123',
  'dragon123', 'master123', 'shadow123', 'football1', 'baseball1', 'qazwsxedc', 'zxcvbnm1', 'zxcvbnmm',
  'q1w2e3r4t5', 'hello123', 'charlie1', 'freedom1', 'whatever1', 'unknown1', 'calmapi1', 'calmapi123',
]);

/** Returns an error message, or null when the password is acceptable. */
export function passwordProblem(password) {
  const p = String(password).toLowerCase();
  if (COMMON.has(p)) return 'This password is too common, choose another one';
  if (/^(.)\1+$/.test(p)) return 'This password is too easy to guess';
  if ('01234567890123456789'.includes(p) || 'abcdefghijklmnopqrstuvwxyz'.includes(p) || 'qwertyuiopasdfghjklzxcvbnm'.includes(p)) {
    return 'This password is too easy to guess';
  }
  return null;
}

/** Context rules: the password must not contain the user's email name or their name. */
export function passwordContextProblem(password, { email, name } = {}) {
  const p = String(password).toLowerCase();
  const local = typeof email === 'string' ? email.split('@')[0].toLowerCase() : '';
  if (local.length >= 4 && p.includes(local)) return 'Your password must not contain your email address';
  for (const part of String(name ?? '').toLowerCase().split(/\s+/)) {
    if (part.length >= 4 && p.includes(part)) return 'Your password must not contain your name';
  }
  return null;
}
