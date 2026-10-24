// User accounts: validation of the details an admin enters, roles, and who may sign in.
// Admins are the addresses listed in ADMIN_EMAIL and sign in with ADMIN_PASSWORD; everyone else is a user
// created and invited by an admin, who signs in with a code emailed to them.

export const GENDERS = { female: 'Female', male: 'Male', other: 'Other', undisclosed: 'Prefer not to say' };
export const CAPABILITIES = { digital: 'Digital', core: 'Core' };
export const MIN_AGE = 10;
export const MAX_AGE = 100;

export const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();

// Deliberately narrower than RFC 5322: no quotes, spaces, commas, semicolons or angle brackets, so an
// address can never be read as several recipients by the mailer.
const EMAIL_PATTERN = /^[a-z0-9._%+'-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
export const isEmail = (email) => email.length <= 254 && EMAIL_PATTERN.test(email);

export function adminEmails() {
  return String(process.env.ADMIN_EMAIL ?? '')
    .split(',')
    .map(normalizeEmail)
    .filter(isEmail);
}

export const isAdmin = (user) => adminEmails().includes(user.email);

// Users need an invite and must be enabled; admins can always sign in.
export const canSignIn = (user) => isAdmin(user) || (user.enabled !== false && Boolean(user.invitedAt));

// Admins see every document; users see the documents of the courses an admin has given them.
export const canSeeDocument = (user, doc) => isAdmin(user) || (Boolean(doc.courseId) && (user.courses ?? []).includes(doc.courseId));

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Cleans the fields of the add/edit user form. Returns the cleaned values and an error message per field.
// `courses` is reduced to well-formed ids here; the server also drops ids of courses that don't exist.
export function validateUser(input = {}) {
  const wanted = [].concat(input.capabilities ?? []);
  const user = {
    name: String(input.name ?? '').replace(/\s+/g, ' ').trim(),
    age: Number(String(input.age ?? '').trim() || NaN),
    gender: String(input.gender ?? ''),
    email: normalizeEmail(input.email),
    mobile: String(input.mobile ?? '').replace(/[\s()-]/g, ''),
    capabilities: Object.keys(CAPABILITIES).filter((key) => wanted.includes(key)),
    courses: [...new Set([].concat(input.courses ?? []).map(String))].filter((id) => ID_PATTERN.test(id)),
  };
  const errors = {};
  if (user.name.length < 2 || user.name.length > 60) errors.name = 'Enter the full name (2–60 characters).';
  if (!Number.isInteger(user.age) || user.age < MIN_AGE || user.age > MAX_AGE) {
    errors.age = `Enter the age as a whole number from ${MIN_AGE} to ${MAX_AGE}.`;
  }
  if (!Object.hasOwn(GENDERS, user.gender)) errors.gender = 'Choose a gender.';
  if (!isEmail(user.email)) errors.email = 'Enter a valid email address, such as name@example.com.';
  if (!/^\+?\d{10,15}$/.test(user.mobile)) errors.mobile = 'Enter a valid mobile number: 10–15 digits, optionally starting with +.';
  if (!user.capabilities.length) errors.capabilities = 'Choose at least one capability.';
  return { user, errors };
}

export const publicUser = (user) => ({
  id: user.id,
  role: isAdmin(user) ? 'admin' : 'user',
  name: user.name,
  age: user.age ?? null,
  gender: user.gender ?? null,
  email: user.email,
  mobile: user.mobile ?? '',
  capabilities: user.capabilities ?? [],
  courses: user.courses ?? [],
  enabled: user.enabled !== false,
  invitedAt: user.invitedAt ?? null,
  lastLoginAt: user.lastLoginAt ?? null,
  createdAt: user.createdAt,
});
