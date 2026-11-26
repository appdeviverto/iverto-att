import { buildTemplate, ImportContext, parseImportRows, readWorkbook } from './import';

const ctx = (over: Partial<ImportContext> = {}): ImportContext => ({
  mode: 'CREATE',
  sites: [{ id: 's1', name: 'Head Office' }],
  departments: [{ id: 'd1', name: 'Sales' }],
  existing: new Map([['emp001', { id: 'e1', structureId: 'st1' }]]),
  categories: [{ code: 'FULL_TIME', label: 'Full time' }],
  structures: [{ id: 'st1', name: 'Standard' }],
  today: '2026-11-18',
  ...over,
});

describe('import parsing', () => {
  it('creates with labels as headers, Indian dates, normalised IDs and a salary', () => {
    const { parsed, missing } = parseImportRows(
      [
        ['Employee code *', 'Full name', 'DOJ', 'Site', 'PAN', 'IFSC', 'Monthly gross (₹)', 'Gender', 'Department'],
        ['EMP002', 'Priya Sharma', '01/04/2026', 'head office', 'abcde1234f', 'hdfc0001234', '35,000', 'female', 'Sales'],
      ],
      ctx(),
    );
    expect(missing).toEqual([]);
    const p = parsed[0];
    expect(p.errors).toEqual([]);
    expect(p.op).toBe('CREATE');
    expect(p.data).toMatchObject({ fullName: 'Priya Sharma', joinedOn: '2026-04-01', siteId: 's1', departmentId: 'd1', pan: 'ABCDE1234F', bankIfsc: 'HDFC0001234', gender: 'FEMALE', mobilePunch: 'NEVER', employmentType: 'FULL_TIME' });
    expect(p.salary).toEqual({ structureId: 'st1', monthlyGross: 3500000, effectiveFrom: '2026-04-01' });
  });

  it('create mode refuses existing codes; update mode keeps blanks and clears "-"', () => {
    const rows = [
      ['employeeCode', 'fullName', 'designation', 'phone', 'managerCode', 'departmentName'],
      ['EMP001', '', 'Lead', '-', '-', ''],
    ];
    expect(parseImportRows(rows, ctx()).parsed[0].errors[0].message).toMatch(/Update mode/);
    const { parsed, missing } = parseImportRows(rows, ctx({ mode: 'UPSERT' }));
    expect(missing).toEqual([]);
    expect(parsed[0]).toMatchObject({ op: 'UPDATE', id: 'e1', errors: [], data: { designation: 'Lead', phone: null }, managerCode: null });
    expect('fullName' in parsed[0].data).toBe(false);
    expect('departmentId' in parsed[0].data).toBe(false);
  });

  it('flags bad IDs, the full Aadhaar number, unknown refs and required clears', () => {
    const { parsed } = parseImportRows(
      [
        ['employeeCode', 'fullName', 'joinedOn', 'pan', 'bankIfsc', 'uan', 'aadhaar', 'siteName', 'salaryStructure'],
        ['EMP009', 'X', '2026-02-30', 'ABC123', 'HDFC1234567', '12345', '1234 5678 9012', 'Nowhere', 'Gold'],
      ],
      ctx(),
    );
    const fields = parsed[0].errors.map((e) => e.field).sort();
    expect(fields).toEqual(['aadhaarLast4', 'bankIfsc', 'joinedOn', 'pan', 'salaryStructure', 'siteName', 'uan']);
    expect(parsed[0].errors.find((e) => e.field === 'aadhaarLast4')!.message).toMatch(/last 4/);
  });

  it('managers may be later rows; unknown or self managers are errors; duplicates flagged', () => {
    const { parsed } = parseImportRows(
      [
        ['employeeCode', 'fullName', 'joinedOn', 'managerCode'],
        ['A1', 'A', '2026-01-01', 'B1'],
        ['B1', 'B', '2026-01-01', 'B1'],
        ['C1', 'C', '2026-01-01', 'ZZ'],
        ['A1', 'A again', '2026-01-01', ''],
      ],
      ctx({ fixedSiteId: 's1' }),
    );
    expect(parsed[0].errors).toEqual([]);
    expect(parsed[1].errors[0].message).toMatch(/themselves/);
    expect(parsed[2].errors[0].message).toMatch(/Unknown manager/);
    expect(parsed[3].errors[0].message).toMatch(/repeated/);
  });

  it('reports missing required columns per mode', () => {
    expect(parseImportRows([['fullName'], ['x']], ctx()).missing).toEqual(['employeeCode', 'joinedOn', 'siteName']);
    expect(parseImportRows([['employeeCode', 'phone'], ['EMP001', '1']], ctx({ mode: 'UPSERT' })).missing).toEqual([]);
  });
});

describe('Excel template', () => {
  it('round-trips: prefilled workbook reads back as rows the parser accepts', async () => {
    const buf = await buildTemplate({
      orgName: 'Acme',
      sites: ['Head Office'],
      departments: ['Sales'],
      categories: [{ code: 'FULL_TIME', label: 'Full time' }],
      structures: ['Standard'],
      managerCodes: ['EMP001'],
      generatedOn: '2026-11-18',
      rows: [
        {
          employeeCode: 'EMP001',
          fullName: 'Priya Sharma',
          joinedOn: '2026-04-01',
          siteName: 'Head Office',
          bankAccountNumber: '001234567890123',
          uan: '100200300400',
          monthlyGross: 35000,
          salaryStructure: 'Standard',
          dateOfBirth: '1995-08-15',
        },
      ],
    });
    const rows = await readWorkbook(buf);
    const header = rows[0];
    const row = rows[1];
    const cell = (label: string) => row[header.indexOf(label)];
    expect(rows).toHaveLength(2);
    expect(cell('Employee code')).toBe('EMP001');
    expect(cell('Joining date')).toBe('2026-04-01');
    expect(cell('Date of birth')).toBe('1995-08-15');
    // Long digit strings survive as text (no 1.2E+15, no lost leading zeros).
    expect(cell('Account number')).toBe('001234567890123');
    expect(cell('Monthly gross (₹)')).toBe('35000');
    const { parsed, missing } = parseImportRows(rows, ctx({ mode: 'UPSERT' }));
    expect(missing).toEqual([]);
    expect(parsed[0].errors).toEqual([]);
    expect(parsed[0].salary).toEqual({ structureId: 'st1', monthlyGross: 3500000, effectiveFrom: '2026-11-01' });
  });
});
