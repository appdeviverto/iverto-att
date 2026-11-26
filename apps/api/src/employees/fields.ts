/**
 * The employee directory's field registry: one list that drives validation,
 * the import engine, the Excel template, the self-service profile edit and the
 * web wizard (GET /employees/import/columns). Add a field here, not in four places.
 */

export type FieldType = 'text' | 'date' | 'int' | 'money' | 'email' | 'enum' | 'ref';

export interface FieldDef {
  key: string;
  label: string;
  section: 'Basics' | 'Job' | 'Personal' | 'Contact & emergency' | 'Statutory IDs' | 'Bank' | 'Salary';
  type: FieldType;
  required?: boolean;
  /** enum: allowed values (stored as-is). */
  values?: readonly string[];
  max?: number;
  pattern?: RegExp;
  patternMessage?: string;
  /** HR/admin and the employee themself only. */
  sensitive?: boolean;
  /** The employee may request a change from the app (applied on HR approval). */
  selfEditable?: boolean;
  /** Not an Employee column: resolved by the import (siteName, departmentName, managerCode, salary). */
  virtual?: boolean;
  /** Excel: keep as text so leading zeros / long digits survive. */
  asText?: boolean;
  /** Header spellings recognised on import (lowercase, alphanumerics only). */
  aka: string[];
  rule: string;
  example: string;
  width?: number;
}

export const MOBILE_PUNCH = ['NEVER', 'REMOTE_DAYS', 'ALWAYS', 'FULL_REMOTE'] as const;
export const GENDERS = ['MALE', 'FEMALE', 'OTHER'] as const;
export const MARITAL = ['SINGLE', 'MARRIED', 'OTHER'] as const;
export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;
export const PAYMENT_MODES = ['BANK', 'CASH', 'CHEQUE'] as const;

export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const UAN_RE = /^[0-9]{12}$/;
export const AADHAAR_LAST4_RE = /^[0-9]{4}$/;

export const FIELDS: FieldDef[] = [
  // Basics
  { key: 'employeeCode', label: 'Employee code', section: 'Basics', type: 'text', required: true, max: 40, asText: true, aka: ['code', 'empcode', 'employeeid', 'empid', 'staffid', 'empno', 'employeeno', 'employeenumber'], rule: 'Unique, up to 40 characters', example: 'EMP001', width: 14 },
  { key: 'fullName', label: 'Full name', section: 'Basics', type: 'text', required: true, max: 120, aka: ['name', 'employeename', 'employee', 'staffname'], rule: 'As it should appear on reports and payslips', example: 'Priya Sharma', width: 24 },
  { key: 'joinedOn', label: 'Joining date', section: 'Basics', type: 'date', required: true, aka: ['joiningdate', 'dateofjoining', 'doj', 'joined', 'joindate', 'startdate', 'datejoined'], rule: 'A date (DD/MM/YYYY or YYYY-MM-DD)', example: '2026-04-01', width: 14 },
  // Job
  { key: 'siteName', label: 'Site', section: 'Job', type: 'ref', virtual: true, aka: ['site', 'location', 'branch', 'office', 'sitename'], rule: 'An existing site (pick from the list)', example: 'Head Office', width: 18 },
  { key: 'departmentName', label: 'Department', section: 'Job', type: 'ref', virtual: true, aka: ['department', 'dept', 'departmentname'], rule: 'An existing department', example: 'Sales', width: 16 },
  { key: 'designation', label: 'Designation', section: 'Job', type: 'text', max: 80, aka: ['title', 'jobtitle', 'position', 'role'], rule: 'Free text', example: 'Sales Executive', width: 18 },
  { key: 'managerCode', label: 'Manager’s code', section: 'Job', type: 'ref', virtual: true, asText: true, aka: ['manager', 'managerid', 'reportsto', 'reportingmanager', 'managercode'], rule: 'An existing employee, or someone in this file', example: 'EMP000', width: 14 },
  { key: 'employmentType', label: 'Employment type', section: 'Job', type: 'ref', aka: ['type', 'employment', 'employmenttype', 'category'], rule: 'A category from Settings → Organisation', example: 'PERMANENT', width: 16 },
  { key: 'mobilePunch', label: 'Mobile punching', section: 'Job', type: 'enum', values: MOBILE_PUNCH, aka: ['mobilepunching', 'mobilecheckin', 'mobilepunch'], rule: MOBILE_PUNCH.join(' · '), example: 'NEVER', width: 16 },
  { key: 'probationEndOn', label: 'Probation ends', section: 'Job', type: 'date', aka: ['probationend', 'probationenddate', 'probation'], rule: 'A date', example: '2026-10-01', width: 14 },
  { key: 'confirmedOn', label: 'Confirmed on', section: 'Job', type: 'date', aka: ['confirmationdate', 'confirmed', 'dateofconfirmation'], rule: 'A date', example: '', width: 14 },
  { key: 'noticePeriodDays', label: 'Notice period (days)', section: 'Job', type: 'int', aka: ['noticeperiod', 'notice', 'noticedays'], rule: 'Whole number of days, 0–365', example: '30', width: 12 },
  // Personal
  { key: 'dateOfBirth', label: 'Date of birth', section: 'Personal', type: 'date', selfEditable: true, aka: ['dob', 'birthdate', 'birthday', 'dateofbirth'], rule: 'A date', example: '1995-08-15', width: 14 },
  { key: 'gender', label: 'Gender', section: 'Personal', type: 'enum', values: GENDERS, selfEditable: true, aka: ['sex'], rule: GENDERS.join(' · '), example: 'FEMALE', width: 10 },
  { key: 'maritalStatus', label: 'Marital status', section: 'Personal', type: 'enum', values: MARITAL, selfEditable: true, aka: ['marital', 'maritalstatus'], rule: MARITAL.join(' · '), example: 'SINGLE', width: 12 },
  { key: 'bloodGroup', label: 'Blood group', section: 'Personal', type: 'enum', values: BLOOD_GROUPS, selfEditable: true, aka: ['blood', 'bloodgroup'], rule: BLOOD_GROUPS.join(' · '), example: 'O+', width: 10 },
  { key: 'fatherOrSpouseName', label: 'Father’s / spouse’s name', section: 'Personal', type: 'text', max: 120, selfEditable: true, aka: ['fathername', 'spousename', 'fatherorspousename', 'guardian'], rule: 'Needed for PF/ESI forms', example: 'Rakesh Sharma', width: 22 },
  // Contact & emergency
  { key: 'email', label: 'Work email', section: 'Contact & emergency', type: 'email', aka: ['emailaddress', 'mail', 'workemail', 'emailid', 'email'], rule: 'Needed only for app sign-in', example: 'priya@company.in', width: 24 },
  { key: 'phone', label: 'Phone', section: 'Contact & emergency', type: 'text', max: 30, asText: true, aka: ['mobile', 'phonenumber', 'mobilenumber', 'contact', 'contactnumber'], rule: 'Up to 30 characters', example: '+91 98450 12345', width: 16 },
  { key: 'personalEmail', label: 'Personal email', section: 'Contact & emergency', type: 'email', selfEditable: true, aka: ['personalemail', 'privateemail'], rule: 'A valid email', example: 'priya.s@gmail.com', width: 24 },
  { key: 'altPhone', label: 'Alternate phone', section: 'Contact & emergency', type: 'text', max: 30, asText: true, selfEditable: true, aka: ['alternatephone', 'altphone', 'alternatemobile'], rule: 'Up to 30 characters', example: '', width: 16 },
  { key: 'currentAddress', label: 'Current address', section: 'Contact & emergency', type: 'text', max: 500, selfEditable: true, aka: ['address', 'currentaddress', 'presentaddress'], rule: 'Up to 500 characters', example: '12, 4th Cross, Indiranagar, Bengaluru 560038', width: 34 },
  { key: 'permanentAddress', label: 'Permanent address', section: 'Contact & emergency', type: 'text', max: 500, selfEditable: true, aka: ['permanentaddress', 'homeaddress', 'nativeaddress'], rule: 'Up to 500 characters', example: '', width: 34 },
  { key: 'emergencyName', label: 'Emergency contact', section: 'Contact & emergency', type: 'text', max: 120, selfEditable: true, aka: ['emergencycontact', 'emergencyname', 'emergencycontactname'], rule: 'Name', example: 'Rakesh Sharma', width: 20 },
  { key: 'emergencyRelation', label: 'Emergency relation', section: 'Contact & emergency', type: 'text', max: 40, selfEditable: true, aka: ['emergencyrelation', 'relation', 'relationship'], rule: 'e.g. Father, Spouse', example: 'Father', width: 14 },
  { key: 'emergencyPhone', label: 'Emergency phone', section: 'Contact & emergency', type: 'text', max: 30, asText: true, selfEditable: true, aka: ['emergencyphone', 'emergencynumber', 'emergencymobile'], rule: 'Up to 30 characters', example: '+91 98450 54321', width: 16 },
  // Statutory IDs
  { key: 'pan', label: 'PAN', section: 'Statutory IDs', type: 'text', sensitive: true, selfEditable: true, asText: true, pattern: PAN_RE, patternMessage: 'PAN must look like ABCDE1234F', aka: ['pan', 'pannumber', 'panno', 'pancard'], rule: '10 characters, e.g. ABCDE1234F', example: 'ABCDE1234F', width: 14 },
  { key: 'aadhaarLast4', label: 'Aadhaar (last 4)', section: 'Statutory IDs', type: 'text', sensitive: true, selfEditable: true, asText: true, pattern: AADHAAR_LAST4_RE, patternMessage: 'Only the last 4 digits of Aadhaar are stored', aka: ['aadhaar', 'aadhar', 'aadhaarno', 'aadhaarnumber', 'aadhaarlast4', 'uidai'], rule: 'Last 4 digits only — the full number is never stored', example: '1234', width: 12 },
  { key: 'uan', label: 'UAN', section: 'Statutory IDs', type: 'text', sensitive: true, selfEditable: true, asText: true, pattern: UAN_RE, patternMessage: 'UAN must be 12 digits', aka: ['uan', 'uanno', 'uannumber', 'pfuan'], rule: '12 digits (PF Universal Account Number)', example: '100200300400', width: 15 },
  { key: 'esicNumber', label: 'ESIC number', section: 'Statutory IDs', type: 'text', max: 20, sensitive: true, selfEditable: true, asText: true, aka: ['esic', 'esi', 'esino', 'esicno', 'esicnumber', 'ipnumber'], rule: 'ESIC IP number', example: '', width: 15 },
  // Bank
  { key: 'paymentMode', label: 'Payment mode', section: 'Bank', type: 'enum', values: PAYMENT_MODES, sensitive: true, aka: ['paymentmode', 'paymode', 'salarymode'], rule: PAYMENT_MODES.join(' · ') + ' (blank = BANK)', example: 'BANK', width: 12 },
  { key: 'bankAccountName', label: 'Account holder', section: 'Bank', type: 'text', max: 120, sensitive: true, selfEditable: true, aka: ['accountname', 'accountholder', 'bankaccountname', 'nameasperbank'], rule: 'Name as on the bank account', example: 'PRIYA SHARMA', width: 22 },
  { key: 'bankAccountNumber', label: 'Account number', section: 'Bank', type: 'text', sensitive: true, selfEditable: true, asText: true, pattern: /^[0-9]{6,20}$/, patternMessage: 'Account number must be 6–20 digits', aka: ['accountnumber', 'accountno', 'bankaccount', 'bankaccountnumber', 'acno', 'acnumber'], rule: '6–20 digits', example: '012345678901', width: 20 },
  { key: 'bankIfsc', label: 'IFSC', section: 'Bank', type: 'text', sensitive: true, selfEditable: true, asText: true, pattern: IFSC_RE, patternMessage: 'IFSC must look like HDFC0001234', aka: ['ifsc', 'ifsccode', 'bankifsc'], rule: '11 characters, e.g. HDFC0001234', example: 'HDFC0001234', width: 14 },
  { key: 'bankName', label: 'Bank name', section: 'Bank', type: 'text', max: 80, sensitive: true, selfEditable: true, aka: ['bank', 'bankname'], rule: 'Free text', example: 'HDFC Bank', width: 16 },
  // Salary
  { key: 'salaryStructure', label: 'Salary structure', section: 'Salary', type: 'ref', virtual: true, sensitive: true, aka: ['salarystructure', 'structure', 'paystructure'], rule: 'A structure from Payroll → Structures', example: 'Standard', width: 18 },
  { key: 'monthlyGross', label: 'Monthly gross (₹)', section: 'Salary', type: 'money', virtual: true, sensitive: true, aka: ['gross', 'monthlygross', 'grosssalary', 'salary', 'monthlysalary'], rule: 'Rupees per month, before deductions', example: '35000', width: 16 },
  { key: 'salaryEffectiveFrom', label: 'Salary effective from', section: 'Salary', type: 'date', virtual: true, sensitive: true, aka: ['salaryeffectivefrom', 'effectivefrom', 'revisiondate', 'salaryfrom'], rule: 'Blank = joining date (new) or the 1st of this month (update)', example: '', width: 16 },
];

export const FIELD = Object.fromEntries(FIELDS.map((f) => [f.key, f])) as Record<string, FieldDef>;

/** Employee columns from the registry (excludes virtual import-only columns). */
export const DIRECTORY_KEYS = FIELDS.filter((f) => !f.virtual && !['employeeCode', 'fullName', 'joinedOn', 'designation', 'employmentType', 'mobilePunch', 'email', 'phone'].includes(f.key)).map((f) => f.key);
export const SENSITIVE_KEYS = FIELDS.filter((f) => f.sensitive && !f.virtual).map((f) => f.key);
export const SELF_EDITABLE_KEYS = FIELDS.filter((f) => f.selfEditable).map((f) => f.key);
export const DATE_KEYS = FIELDS.filter((f) => f.type === 'date').map((f) => f.key);

/** Lowercase alphanumerics: how header cells are matched. */
export const headerKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function fieldForHeader(header: string): FieldDef | undefined {
  const k = headerKey(header.replace(/\*$/, ''));
  return FIELDS.find((f) => headerKey(f.key) === k || headerKey(f.label) === k || f.aka.includes(k));
}

/** YYYY-MM-DD that is also a calendar date (rejects 2026-02-30). */
export const isRealYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, YYYY/MM/DD → YYYY-MM-DD (Indian day-first). Leaves anything else as-is. */
export function normaliseDate(v: string): string {
  const s = v.trim();
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return s;
}

/**
 * Validate and normalise one value for a field. Returns the stored value
 * (string | number | null) or an error message. '' = not given.
 */
export function coerceField(f: FieldDef, raw: string): { value: string | number | null } | { error: string } {
  let v = raw.trim();
  if (v === '') return { value: null };
  switch (f.type) {
    case 'date':
      v = normaliseDate(v);
      return isRealYmd(v) ? { value: v } : { error: `${f.label} must be a real date (DD/MM/YYYY or YYYY-MM-DD)` };
    case 'int': {
      const n = Number(v);
      return Number.isInteger(n) && n >= 0 && n <= 365 ? { value: n } : { error: `${f.label} must be a whole number 0–365` };
    }
    case 'money': {
      const n = Number(v.replace(/[₹,\s]/g, ''));
      return Number.isFinite(n) && n >= 0 && n < 1e8 ? { value: Math.round(n * 100) } : { error: `${f.label} must be an amount in rupees` };
    }
    case 'email':
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? { value: v.toLowerCase() } : { error: `${f.label} is not a valid email` };
    case 'enum': {
      const hit = f.values!.find((x) => x.toLowerCase() === v.toLowerCase().replace(/[\s-]+/g, '_') || x.toLowerCase() === v.toLowerCase());
      return hit ? { value: hit } : { error: `${f.label} must be one of ${f.values!.join(', ')}` };
    }
    default: {
      if (f.key === 'aadhaarLast4' && /^\d{12}$/.test(v.replace(/\s/g, ''))) {
        return { error: 'Give only the last 4 digits of Aadhaar — the full number is not stored' };
      }
      if (f.pattern) {
        // IDs are compared without spaces and in capitals (PAN, IFSC).
        v = v.replace(/\s/g, '').toUpperCase();
        if (!f.pattern.test(v)) return { error: f.patternMessage ?? `${f.label} is not valid` };
      }
      if (f.max && v.length > f.max) return { error: `${f.label} is longer than ${f.max} characters` };
      return { value: v };
    }
  }
}
