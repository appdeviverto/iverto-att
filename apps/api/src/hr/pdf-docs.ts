import pdfmake from 'pdfmake';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { C, fetchLogo, registerFonts } from '../reports/pdf';

export interface Brand {
  orgName: string;
  /** Legal name for the letterhead; falls back to orgName. */
  legalName?: string | null;
  logoUrl?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  registration?: string | null;
}

export const brandOf = (tenant: { name: string; settings: unknown }): Brand => {
  const b = ((tenant.settings as Record<string, any>) ?? {}).branding ?? {};
  return {
    orgName: b.displayName || tenant.name,
    legalName: b.legalName || null,
    logoUrl: b.logoUrl ?? null,
    address: b.address || null,
    phone: b.phone || null,
    email: b.email || null,
    website: b.website || null,
    registration: b.registration || null,
  };
};

/** "Phone · email · website" for one-line contact strips. */
export const contactLine = (b: Brand) => [b.phone, b.email, b.website].filter(Boolean).join('  ·  ');

/**
 * The company letterhead: logo (or the name as a wordmark) on the left, the
 * legal name, address, contact line and registration numbers on the right,
 * then the brand rule. Width is the printable width.
 */
export function letterhead(brand: Brand, logo: string | null, width: number): Content {
  const name = brand.legalName || brand.orgName;
  // The address keeps the line breaks HR typed (street / city), each line on its own.
  const details = [
    ...(logo ? [{ text: name, bold: true, fontSize: 11, color: C.body }] : []),
    ...(brand.address ? brand.address.split(/\s*\n\s*/).filter(Boolean).map((line, i) => ({ text: line, fontSize: 8, color: C.secondary, margin: [0, i ? 0 : 2, 0, 0] })) : []),
    ...(contactLine(brand) ? [{ text: contactLine(brand), fontSize: 8, color: C.secondary, margin: [0, 2, 0, 0] }] : []),
    ...(brand.registration ? [{ text: brand.registration, fontSize: 7, color: C.muted, margin: [0, 1, 0, 0] }] : []),
  ];
  return {
    stack: [
      {
        columns: [
          logo
            ? { image: 'logo', fit: [150, 46], width: '*' }
            : { width: '*', text: name, bold: true, fontSize: 16, color: C.brand, margin: [0, 4, 0, 0] },
          { width: 270, alignment: 'right', stack: details },
        ],
      },
      { canvas: [{ type: 'line', x1: 0, y1: 0, x2: width, y2: 0, lineWidth: 2, lineColor: C.brand }], margin: [0, 8, 0, 0] },
    ],
  } as Content;
}

/** A4 portrait with the org letterhead (logo or wordmark + brand rule) and a footer line. */
export async function renderBranded(brand: Brand, content: Content[], footer: string): Promise<Buffer> {
  registerFonts();
  const logo = await fetchLogo(brand.logoUrl);
  const lines = (brand.address?.split(/\s*\n\s*/).filter(Boolean).length ?? 0) + [contactLine(brand), brand.registration].filter(Boolean).length;
  const doc: TDocumentDefinitions = {
    pageSize: 'A4',
    // The letterhead grows with the details it carries.
    pageMargins: [48, 92 + lines * 10, 48, 60],
    defaultStyle: { font: 'Poppins', fontSize: 10, color: C.body, lineHeight: 1.35 },
    ...(logo ? { images: { logo } } : {}),
    header: (): Content => ({ margin: [48, 30, 48, 0], stack: [letterhead(brand, logo, 499)] }) as Content,
    footer: (page: number, pages: number) => ({
      margin: [48, 14, 48, 0],
      stack: [
        { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 499, y2: 0, lineWidth: 0.5, lineColor: C.line }] },
        {
          margin: [0, 5, 0, 0],
          columns: [
            { text: footer, fontSize: 7, color: C.muted },
            { text: `${page} / ${pages}`, alignment: 'right', fontSize: 7, color: C.muted, width: 40 },
          ],
        },
      ],
    }) as Content,
    content,
  };
  return pdfmake.createPdf(doc).getBuffer();
}

/** Indian grouping, rupees from paise: 3512345 → "35,123.45". */
export const rupees = (paise: number) =>
  (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const two = (n: number) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`);
const three = (n: number) => [n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred` : '', two(n % 100)].filter(Boolean).join(' ');

/** Indian system (lakh, crore): 3512345 paise → "Rupees Thirty Five Thousand One Hundred Twenty Three and Forty Five Paise Only". */
export function rupeesInWords(paise: number): string {
  const total = Math.round(Math.abs(paise));
  let n = Math.floor(total / 100);
  const p = total % 100;
  const tail = p ? ` and ${two(p)} Paise Only` : ' Only';
  if (n === 0) return `Rupees Zero${tail}`;
  const parts: string[] = [];
  const crore = Math.floor(n / 1e7);
  n %= 1e7;
  const lakh = Math.floor(n / 1e5);
  n %= 1e5;
  const thousand = Math.floor(n / 1e3);
  n %= 1e3;
  if (crore) parts.push(`${three(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (n) parts.push(three(n));
  return `Rupees ${parts.join(' ')}${tail}`;
}
