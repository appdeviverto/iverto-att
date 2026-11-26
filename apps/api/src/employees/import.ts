import ExcelJS from 'exceljs';
import { addDays, Ymd } from '../common/time';
import { coerceField, FIELD, FieldDef, fieldForHeader, FIELDS, headerKey, isRealYmd } from './fields';

// ── Parse (pure) ────────────────────────────────────────────────────────────

export type ImportMode = 'CREATE' | 'UPSERT';

export interface ImportContext {
  mode: ImportMode;
  /** The wizard's location step: the site new employees join. */
  fixedSiteId?: string;
  sites: { id: string; name: string }[];
  departments: { id: string; name: string }[];
  /** lowercased employeeCode → existing employee. */
  existing: Map<string, { id: string; structureId?: string | null }>;
  categories: { code: string; label: string }[];
  structures: { id: string; name: string }[];
  /** Today, for an update's default salary date (the 1st of this month). */
  today: Ymd;
  /** The payroll module is off: salary columns are listed as ignored. */
  noSalary?: boolean;
}

export interface CellError {
  field: string;
  message: string;
}

export interface ParsedRow {
  line: number;
  op: 'CREATE' | 'UPDATE';
  id?: string;
  code: string;
  errors: CellError[];
  /** Only the columns given: a value sets it, null clears it (update mode "-"). */
  data: Record<string, string | number | null>;
  /** undefined = untouched, null = clear, string = a code in the DB or this file. */
  managerCode?: string | null;
  salary?: { structureId: string; monthlyGross: number; effectiveFrom: Ymd };
}

const CLEAR = '-';
/** Never clearable in update mode. */
const NOT_CLEARABLE = new Set(['employeeCode', 'fullName', 'joinedOn', 'siteName', 'employmentType', 'mobilePunch', 'salaryStructure', 'monthlyGross', 'salaryEffectiveFrom']);

export function mapHeader(header: string[], noSalary = false) {
  const columns: (FieldDef | undefined)[] = header.map((h) => {
    const f = fieldForHeader(h);
    return noSalary && f?.section === 'Salary' ? undefined : f;
  });
  const ignored = header.filter((h, i) => h.trim() && !columns[i]);
  return { columns, ignored };
}

/**
 * rows[0] is the header. Create mode refuses codes that already exist; update
 * mode (UPSERT) updates them, leaving blank cells untouched and clearing "-".
 */
export function parseImportRows(rows: string[][], ctx: ImportContext) {
  const { columns, ignored } = mapHeader(rows[0] ?? [], ctx.noSalary);
  const has = (key: string) => columns.some((c) => c?.key === key);
  const missing = ['employeeCode', ...(ctx.mode === 'CREATE' ? ['fullName', 'joinedOn', ...(ctx.fixedSiteId ? [] : ['siteName'])] : [])].filter((k) => !has(k));
  const byName = <T extends { name: string }>(list: T[], v: string) => list.find((x) => x.name.trim().toLowerCase() === v.trim().toLowerCase());
  const categoryOf = (cell: string) =>
    ctx.categories.find((c) => c.code === cell.toUpperCase().replace(/[\s-]+/g, '_') || c.label.toLowerCase() === cell.toLowerCase())?.code;
  const seen = new Set<string>();

  const parsed: ParsedRow[] = rows.slice(1).map((r, i) => {
    const cell = (key: string) => {
      const at = columns.findIndex((c) => c?.key === key);
      return at >= 0 ? (r[at] ?? '').trim() : '';
    };
    const errors: CellError[] = [];
    const fail = (field: string, message: string) => errors.push({ field, message });
    const code = cell('employeeCode');
    const known = ctx.existing.get(code.toLowerCase());
    const op: ParsedRow['op'] = known && ctx.mode === 'UPSERT' ? 'UPDATE' : 'CREATE';
    const row: ParsedRow = { line: i + 2, op, id: op === 'UPDATE' ? known!.id : undefined, code, errors, data: {} };

    if (!code) fail('employeeCode', 'Employee code is required');
    else if (code.length > 40) fail('employeeCode', 'Employee code is longer than 40 characters');
    if (known && ctx.mode === 'CREATE') fail('employeeCode', 'Employee code already exists — switch to Update mode to change existing employees');
    if (code && seen.has(code.toLowerCase())) fail('employeeCode', 'Employee code repeated in this file');
    seen.add(code.toLowerCase());

    let structureId: string | undefined;
    let gross: number | undefined;
    let salaryFrom: string | undefined;
    for (const f of columns) {
      if (!f || f.key === 'employeeCode') continue;
      const raw = cell(f.key);
      if (!raw) continue;
      if (raw === CLEAR) {
        if (op === 'CREATE') continue; // nothing to clear on a new employee
        if (NOT_CLEARABLE.has(f.key)) fail(f.key, `${f.label} cannot be cleared`);
        else if (f.key === 'managerCode') row.managerCode = null;
        else if (f.key === 'departmentName') row.data.departmentId = null;
        else row.data[f.key] = null;
        continue;
      }
      switch (f.key) {
        case 'siteName': {
          // By name (CSV) or by id (public API bulk upsert).
          const site = ctx.sites.find((x) => x.id === raw) ?? byName(ctx.sites, raw);
          if (!site) fail(f.key, `Unknown site "${raw}"`);
          else row.data.siteId = site.id;
          break;
        }
        case 'departmentName': {
          const dept = ctx.departments.find((x) => x.id === raw) ?? byName(ctx.departments, raw);
          if (!dept) fail(f.key, `Unknown department "${raw}"`);
          else row.data.departmentId = dept.id;
          break;
        }
        case 'managerCode':
          row.managerCode = raw;
          break;
        case 'employmentType': {
          const t = categoryOf(raw);
          if (!t) fail(f.key, `Employment type must be ${ctx.categories.map((c) => c.code).join(', ')}`);
          else row.data.employmentType = t;
          break;
        }
        case 'salaryStructure': {
          const s = byName(ctx.structures, raw);
          if (!s) fail(f.key, `Unknown salary structure "${raw}"`);
          else structureId = s.id;
          break;
        }
        default: {
          const out = coerceField(f, raw);
          if ('error' in out) fail(f.key, out.error);
          else if (f.key === 'monthlyGross') gross = out.value as number;
          else if (f.key === 'salaryEffectiveFrom') salaryFrom = out.value as string;
          else row.data[f.key] = out.value;
        }
      }
    }

    if (op === 'CREATE') {
      if (!row.data.fullName && !errors.some((e) => e.field === 'fullName')) fail('fullName', 'Full name is required');
      if (!row.data.joinedOn && !errors.some((e) => e.field === 'joinedOn')) fail('joinedOn', 'Joining date is required');
      // The location step decides where new people join; a siteName cell is only needed without it.
      if (ctx.fixedSiteId) row.data.siteId = ctx.fixedSiteId;
      else if (!row.data.siteId && !errors.some((e) => e.field === 'siteName')) fail('siteName', 'Site is required');
      row.data.mobilePunch ??= 'NEVER';
      row.data.employmentType ??= ctx.categories[0]?.code ?? null;
    }

    if (gross !== undefined) {
      const sid = structureId ?? known?.structureId ?? (ctx.structures.length === 1 ? ctx.structures[0].id : undefined);
      const from = salaryFrom ?? (op === 'CREATE' ? (row.data.joinedOn as string | undefined) : `${ctx.today.slice(0, 7)}-01`);
      if (!sid) fail('salaryStructure', ctx.structures.length ? 'Choose a salary structure for this salary' : 'Create a salary structure in Payroll → Structures first');
      else if (from && isRealYmd(from)) row.salary = { structureId: sid, monthlyGross: gross, effectiveFrom: from };
    } else if (structureId || salaryFrom) {
      fail('monthlyGross', 'Monthly gross is needed to set a salary');
    }
    return row;
  });

  // Managers may be existing employees or rows in this same file.
  const fileCodes = new Set(parsed.map((p) => p.code.toLowerCase()));
  for (const p of parsed) {
    if (!p.managerCode) continue;
    const m = p.managerCode.toLowerCase();
    if (m === p.code.toLowerCase()) p.errors.push({ field: 'managerCode', message: 'An employee cannot manage themselves' });
    else if (!ctx.existing.has(m) && !fileCodes.has(m)) p.errors.push({ field: 'managerCode', message: `Unknown manager code "${p.managerCode}"` });
  }
  return { parsed, missing, ignored };
}

// ── Excel template ──────────────────────────────────────────────────────────

const BRAND = 'FFCD0447';
const BRAND_DARK = 'FF9F0337';
const SECTION_TONE: Record<FieldDef['section'], { fill: string; font: string }> = {
  Basics: { fill: 'FFFCE7EF', font: 'FF9F0337' },
  Job: { fill: 'FFEFF6FF', font: 'FF1D4ED8' },
  Personal: { fill: 'FFF5F3FF', font: 'FF6D28D9' },
  'Contact & emergency': { fill: 'FFECFDF5', font: 'FF047857' },
  'Statutory IDs': { fill: 'FFFFFBEB', font: 'FFB45309' },
  Bank: { fill: 'FFF0F9FF', font: 'FF0369A1' },
  Salary: { fill: 'FFF3F4F6', font: 'FF374151' },
};
const HEADER_ROW = 4;
const FIRST_DATA_ROW = HEADER_ROW + 1;
const solid = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = { style: 'thin' as const, color: { argb: 'FFE5E7EB' } };

export interface TemplateInput {
  orgName: string;
  sites: string[];
  departments: string[];
  categories: { code: string; label: string }[];
  structures: string[];
  managerCodes: string[];
  /** Prefill: one record per employee, keyed by field key (dates YYYY-MM-DD, money in rupees). */
  rows?: Record<string, string | number | null>[];
  /** Leave the site column out (the wizard's location step picks it). */
  hideSite?: boolean;
  /** Leave the salary section out (payroll module off). */
  hideSalary?: boolean;
  generatedOn: Ymd;
}

const ymdToDate = (s: string) => new Date(`${s}T00:00:00Z`);

export async function buildTemplate(t: TemplateInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Iverto Attendance';
  wb.created = new Date();
  const fields = FIELDS.filter((f) => !(t.hideSite && f.key === 'siteName') && !(t.hideSalary && f.section === 'Salary'));
  const prefill = Boolean(t.rows);
  const capacity = Math.max(500, (t.rows?.length ?? 0) + 200);
  const lastData = FIRST_DATA_ROW + capacity - 1;

  // Lists (hidden): every dropdown reads a column here, so long lists don't hit Excel's 255-character inline limit.
  const lists = wb.addWorksheet('Lists', { state: 'veryHidden' });
  const listCols: Record<string, string[]> = {
    siteName: t.sites,
    departmentName: t.departments,
    employmentType: t.categories.map((c) => c.code),
    salaryStructure: t.structures,
    managerCode: t.managerCodes,
    ...Object.fromEntries(fields.filter((f) => f.type === 'enum').map((f) => [f.key, [...f.values!]])),
  };
  const listRef: Record<string, string> = {};
  Object.entries(listCols).forEach(([key, values], i) => {
    const col = lists.getColumn(i + 1);
    col.values = [key, ...values];
    if (values.length) listRef[key] = `Lists!$${col.letter}$2:$${col.letter}$${values.length + 1}`;
  });

  const ws = wb.addWorksheet('Employees', {
    views: [{ state: 'frozen', xSplit: 2, ySplit: HEADER_ROW, showGridLines: false }],
    properties: { tabColor: { argb: BRAND } },
  });
  ws.columns = fields.map((f) => ({ key: f.key, width: f.width ?? 16 }));
  const lastCol = ws.getColumn(fields.length).letter;

  // 1–2: title band
  ws.mergeCells(`A1:${lastCol}1`);
  Object.assign(ws.getCell('A1'), {
    value: `${t.orgName} · Employee ${prefill ? 'update' : 'import'}`,
    font: { name: 'Calibri', size: 16, bold: true, color: { argb: 'FFFFFFFF' } },
    fill: solid(BRAND),
    alignment: { vertical: 'middle', indent: 1 },
  });
  ws.getRow(1).height = 32;
  ws.mergeCells(`A2:${lastCol}2`);
  Object.assign(ws.getCell('A2'), {
    value: prefill
      ? `Your current employees as of ${t.generatedOn}. Edit cells and upload in Update mode — a blank cell keeps the value, "-" clears it. Hover a header for its rule.`
      : `One row per employee, from row ${FIRST_DATA_ROW}. Columns marked * are required. Hover a header for its rule; pick from the dropdowns where there is one. See the Instructions sheet.`,
    font: { italic: true, size: 10, color: { argb: 'FF4B5563' } },
    fill: solid('FFF9FAFB'),
    alignment: { vertical: 'middle', indent: 1, wrapText: true },
  });
  ws.getRow(2).height = 30;

  // 3: section bands, 4: headers
  let start = 0;
  fields.forEach((f, i) => {
    if (i + 1 < fields.length && fields[i + 1].section === f.section) return;
    const from = ws.getColumn(start + 1).letter;
    const to = ws.getColumn(i + 1).letter;
    if (from !== to) ws.mergeCells(`${from}3:${to}3`);
    const tone = SECTION_TONE[f.section];
    Object.assign(ws.getCell(`${from}3`), {
      value: f.section.toUpperCase(),
      font: { bold: true, size: 9, color: { argb: tone.font } },
      fill: solid(tone.fill),
      alignment: { horizontal: 'center', vertical: 'middle' },
      border: { left: { style: 'medium', color: { argb: 'FFFFFFFF' } } },
    });
    start = i + 1;
  });
  ws.getRow(3).height = 18;
  const header = ws.getRow(HEADER_ROW);
  header.height = 34;
  fields.forEach((f, i) => {
    const c = header.getCell(i + 1);
    c.value = f.required ? `${f.label} *` : f.label;
    c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    c.fill = solid(f.required ? BRAND_DARK : BRAND);
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.border = { right: { style: 'thin', color: { argb: 'FFFFFFFF' } } };
    c.note = { texts: [{ text: `${f.label}${f.required ? ' (required)' : ''}\n`, font: { bold: true } }, { text: `${f.rule}${f.example ? `\nExample: ${f.example}` : ''}` }], margins: { insetmode: 'auto' } } as ExcelJS.Comment;
  });
  ws.autoFilter = { from: { row: HEADER_ROW, column: 1 }, to: { row: HEADER_ROW, column: fields.length } };

  // Column formats + validation over the data area.
  const dv = (ws as unknown as { dataValidations: { add(range: string, v: ExcelJS.DataValidation): void } }).dataValidations;
  fields.forEach((f, i) => {
    const col = ws.getColumn(i + 1);
    const range = `${col.letter}${FIRST_DATA_ROW}:${col.letter}${lastData}`;
    const err = (msg: string) => ({ showErrorMessage: true, errorStyle: 'stop' as const, errorTitle: f.label, error: msg, showInputMessage: true, promptTitle: f.label, prompt: f.rule.slice(0, 250) });
    if (f.type === 'date') {
      col.numFmt = 'dd-mmm-yyyy';
      dv.add(range, { type: 'date', operator: 'between', allowBlank: true, formulae: [new Date('1940-01-01'), new Date('2100-12-31')], ...err('Enter a date, e.g. 15-08-2026') });
    } else if (f.type === 'money') {
      col.numFmt = '"₹"#,##0';
      dv.add(range, { type: 'decimal', operator: 'between', allowBlank: true, formulae: [0, 99999999], ...err('Enter an amount in rupees') });
    } else if (f.type === 'int') {
      dv.add(range, { type: 'whole', operator: 'between', allowBlank: true, formulae: [0, 365], ...err('Enter a whole number of days') });
    } else if (listRef[f.key]) {
      if (f.asText) col.numFmt = '@';
      // Manager codes are a suggestion list (the file may add new managers), so warn instead of stop.
      const soft = f.key === 'managerCode';
      dv.add(range, { type: 'list', allowBlank: true, formulae: [listRef[f.key]], ...err(soft ? 'Not an existing employee code — fine if this manager is in this file' : `Pick a value from the list`), ...(soft ? { errorStyle: 'warning' as const } : {}) });
    } else {
      if (f.asText) col.numFmt = '@';
      if (f.key === 'pan') dv.add(range, { type: 'textLength', operator: 'equal', allowBlank: true, formulae: [10], ...err('PAN is 10 characters, e.g. ABCDE1234F') });
      if (f.key === 'bankIfsc') dv.add(range, { type: 'textLength', operator: 'equal', allowBlank: true, formulae: [11], ...err('IFSC is 11 characters, e.g. HDFC0001234') });
      if (f.key === 'uan') dv.add(range, { type: 'textLength', operator: 'equal', allowBlank: true, formulae: [12], ...err('UAN is 12 digits') });
      if (f.key === 'aadhaarLast4') dv.add(range, { type: 'textLength', operator: 'equal', allowBlank: true, formulae: [4], ...err('Only the last 4 digits of Aadhaar') });
    }
  });

  // Prefilled rows, then light banding across the whole data area.
  (t.rows ?? []).forEach((rec, r) => {
    const row = ws.getRow(FIRST_DATA_ROW + r);
    fields.forEach((f, i) => {
      const v = rec[f.key];
      if (v === null || v === undefined || v === '') return;
      row.getCell(i + 1).value = f.type === 'date' && typeof v === 'string' && isRealYmd(v) ? ymdToDate(v) : f.type === 'money' ? Number(v) : f.asText ? String(v) : v;
    });
  });
  for (let r = FIRST_DATA_ROW; r <= lastData; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= fields.length; c++) {
      const cell = row.getCell(c);
      if ((r - FIRST_DATA_ROW) % 2 === 1) cell.fill = solid('FFFAFAFB');
      cell.border = { bottom: thin, right: thin };
      if (c <= 2) cell.font = { bold: c === 1 };
    }
  }

  buildInstructions(wb, fields, t, prefill);
  wb.views = [{ x: 0, y: 0, width: 20000, height: 12000, firstSheet: 0, activeTab: 1, visibility: 'visible' }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function buildInstructions(wb: ExcelJS.Workbook, fields: FieldDef[], t: TemplateInput, prefill: boolean) {
  const ws = wb.addWorksheet('Instructions', { views: [{ showGridLines: false }], properties: { tabColor: { argb: 'FF6B7280' } } });
  ws.columns = [{ width: 26 }, { width: 12 }, { width: 22 }, { width: 58 }, { width: 22 }];
  ws.mergeCells('A1:E1');
  Object.assign(ws.getCell('A1'), { value: 'How to fill the employee sheet', font: { size: 16, bold: true, color: { argb: 'FFFFFFFF' } }, fill: solid(BRAND), alignment: { vertical: 'middle', indent: 1 } });
  ws.getRow(1).height = 32;
  const steps = [
    `Fill the Employees sheet from row ${FIRST_DATA_ROW}, one employee per row. Leave the title and header rows as they are.`,
    'Required columns are marked * and have a darker header. Hover any header for its rule and an example.',
    'Use the dropdowns for sites, departments, categories and salary structures — they list what is set up in your account today.',
    'Create mode adds new employees; an employee code that already exists is flagged.',
    'Update mode changes existing employees matched by employee code: a blank cell keeps the current value, a single "-" clears it. Codes not found are added as new employees.',
    'IDs (PAN, UAN, bank account) are text cells so Excel keeps leading zeros. Store only the last 4 digits of Aadhaar; upload the card itself to the employee’s documents.',
    'Salary: give a monthly gross in rupees and pick a structure. Blank effective date = the joining date for new employees, the 1st of this month for updates.',
    'Upload the file in Employees → Import. Every row is checked before anything is saved, and you can fix problems in the wizard.',
  ];
  steps.forEach((s, i) => {
    const r = ws.getRow(3 + i);
    r.getCell(1).value = `${i + 1}.`;
    r.getCell(1).alignment = { horizontal: 'right', vertical: 'top' };
    r.getCell(1).font = { bold: true, color: { argb: BRAND } };
    ws.mergeCells(`B${3 + i}:E${3 + i}`);
    r.getCell(2).value = s;
    r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    r.height = 30;
  });
  const top = 4 + steps.length;
  ws.mergeCells(`A${top}:E${top}`);
  Object.assign(ws.getCell(`A${top}`), { value: 'Column dictionary', font: { size: 13, bold: true }, alignment: { vertical: 'middle' } });
  ws.getRow(top).height = 26;
  const head = ws.getRow(top + 1);
  ['Column', 'Required', 'Section', 'Rule', 'Example'].forEach((h, i) => {
    const c = head.getCell(i + 1);
    c.value = h;
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = solid('FF374151');
  });
  fields.forEach((f, i) => {
    const r = ws.getRow(top + 2 + i);
    r.values = [f.label, f.required ? 'Yes' : '', f.section, f.rule, f.example];
    r.getCell(4).alignment = { wrapText: true, vertical: 'top' };
    for (let c = 1; c <= 5; c++) {
      r.getCell(c).border = { bottom: thin };
      if (i % 2) r.getCell(c).fill = solid('FFF9FAFB');
    }
    if (f.required) r.getCell(2).font = { bold: true, color: { argb: BRAND } };
    const tone = SECTION_TONE[f.section];
    r.getCell(3).font = { color: { argb: tone.font } };
  });
  ws.getCell(`A${top + 3 + fields.length}`).value = `${t.orgName} · generated ${t.generatedOn}${prefill ? ' · contains personal data — share only with HR' : ''}`;
  ws.getCell(`A${top + 3 + fields.length}`).font = { italic: true, size: 9, color: { argb: 'FF6B7280' } };
}

// ── Read an uploaded workbook ───────────────────────────────────────────────

/** Excel's 1900 date system serial → YYYY-MM-DD. */
const serialToYmd = (n: number) => addDays('1899-12-30', Math.floor(n));

function cellText(v: ExcelJS.CellValue, f: FieldDef | undefined): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    if (f?.type === 'date' && v > 10000 && v < 80000) return serialToYmd(v);
    // Integers as plain digits (no 1.2E+15); money keeps its decimals.
    return Number.isInteger(v) ? v.toFixed(0) : String(v);
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((p) => p.text).join('');
    if ('text' in v) return String(v.text);
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue, f);
  }
  return String(v);
}

/**
 * The first visible sheet that has a header row (a row naming the employee code
 * column), from that header down; title and band rows above it are skipped.
 */
export async function readWorkbook(buf: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  for (const ws of wb.worksheets) {
    if (ws.state !== 'visible') continue;
    let headerAt = 0;
    for (let r = 1; r <= Math.min(ws.rowCount, 20) && !headerAt; r++) {
      const row = ws.getRow(r);
      for (let c = 1; c <= row.cellCount; c++) {
        if (fieldForHeader(cellText(row.getCell(c).value, undefined))?.key === 'employeeCode') {
          headerAt = r;
          break;
        }
      }
    }
    if (!headerAt) continue;
    const width = ws.getRow(headerAt).cellCount;
    const header = Array.from({ length: width }, (_, i) => cellText(ws.getRow(headerAt).getCell(i + 1).value, undefined).replace(/\s*\*$/, '').trim());
    const fields = header.map((h) => fieldForHeader(h));
    const out: string[][] = [header];
    for (let r = headerAt + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cells = Array.from({ length: width }, (_, i) => cellText(row.getCell(i + 1).value, fields[i]).trim());
      if (cells.some(Boolean)) out.push(cells);
    }
    return out;
  }
  return [];
}

/** For the web wizard: the registry minus server-only bits. */
export const importColumns = (noSalary = false) =>
  FIELDS.filter((f) => !(noSalary && f.section === 'Salary')).map((f) => ({ key: f.key, label: f.label, section: f.section, required: Boolean(f.required), rule: f.rule, example: f.example, aka: [...f.aka, headerKey(f.label)], type: f.type, values: f.values ?? null, virtual: Boolean(f.virtual), sensitive: Boolean(f.sensitive), selfEditable: Boolean(f.selfEditable) }));

export { FIELD };
