import { useState } from 'react';

export interface Branding {
  displayName?: string | null;
  legalName?: string | null;
  logoUrl?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  registration?: string | null;
}

/**
 * The company letterhead as it prints on payslips and letters (API hr/pdf-docs.ts `letterhead`):
 * logo — or the name as a wordmark — on the left; name, address lines, contacts and
 * registration numbers on the right; then the brand rule. Paper colours, so it looks the
 * same in dark mode.
 */
export function Letterhead({ branding, fallbackName }: { branding: Branding; fallbackName: string }) {
  const [broken, setBroken] = useState<string>();
  const name = branding.legalName || branding.displayName || fallbackName;
  const logo = branding.logoUrl && broken !== branding.logoUrl ? branding.logoUrl : null;
  const contact = [branding.phone, branding.email, branding.website].filter(Boolean).join('  ·  ');
  const lines = String(branding.address || '').split(/\s*\n\s*/).filter(Boolean);
  return (
    <div>
      <div className="flex items-start justify-between gap-6">
        {logo
          ? <img src={logo} alt="" className="max-h-12 max-w-40 object-contain" onError={() => setBroken(logo)} />
          : <span className="pt-0.5 text-base font-bold leading-tight text-[#cd0447]">{name}</span>}
        <div className="max-w-[62%] text-right text-[10.5px] leading-snug text-[#374151]">
          {logo && <div className="text-[12px] font-semibold text-[#1f2937]">{name}</div>}
          {lines.map((l) => <div key={l}>{l}</div>)}
          {contact && <div className="mt-0.5">{contact}</div>}
          {branding.registration && <div className="text-[9.5px] text-[#6b7280]">{branding.registration}</div>}
        </div>
      </div>
      <div className="mt-2.5 h-0.5 bg-[#cd0447]" />
    </div>
  );
}
