/**
 * Writes an ISO 20022 camt.053.001.08 statement in the shape Swiss banks and Wise export,
 * reduced to the elements src/parsers/camt053.ts and statement-balances.ts read.
 */

export interface CamtDetail {
  amount: number;
  counterparty: string;
  /** A 27-digit QR reference goes into Strd, any other text into Ustrd. */
  reference?: string;
  text: string;
}

export interface CamtEntry {
  ref: string;
  date: string;
  amount: number;
  direction: 'CRDT' | 'DBIT';
  text: string;
  details: CamtDetail[];
}

export interface CamtStatement {
  id: string;
  created: string;
  iban: string;
  currency: string;
  owner: string;
  institution: string;
  from: string;
  to: string;
  opening: number;
  closing: number;
  entries: CamtEntry[];
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const amt = (n: number) => n.toFixed(2);

function balance(code: 'OPBD' | 'CLBD', amount: number, currency: string, date: string): string {
  return `      <Bal>
        <Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp>
        <Amt Ccy="${currency}">${amt(Math.abs(amount))}</Amt>
        <CdtDbtInd>${amount < 0 ? 'DBIT' : 'CRDT'}</CdtDbtInd>
        <Dt><Dt>${date}</Dt></Dt>
      </Bal>`;
}

function detail(d: CamtDetail, direction: CamtEntry['direction'], currency: string): string {
  const party = direction === 'DBIT' ? 'Cdtr' : 'Dbtr';
  const rmt = d.reference === undefined ? ''
    : /^\d{27}$/.test(d.reference)
      ? `\n            <RmtInf><Strd><CdtrRefInf><Ref>${d.reference}</Ref></CdtrRefInf></Strd></RmtInf>`
      : `\n            <RmtInf><Ustrd>${esc(d.reference)}</Ustrd></RmtInf>`;
  return `          <TxDtls>
            <Amt Ccy="${currency}">${amt(d.amount)}</Amt>
            <RltdPties><${party}><Pty><Nm>${esc(d.counterparty)}</Nm></Pty></${party}></RltdPties>${rmt}
            <AddtlTxInf>${esc(d.text)}</AddtlTxInf>
          </TxDtls>`;
}

function entry(e: CamtEntry, currency: string): string {
  return `      <Ntry>
        <Amt Ccy="${currency}">${amt(e.amount)}</Amt>
        <CdtDbtInd>${e.direction}</CdtDbtInd>
        <RvslInd>false</RvslInd>
        <Sts><Cd>BOOK</Cd></Sts>
        <BookgDt><Dt>${e.date}</Dt></BookgDt>
        <ValDt><Dt>${e.date}</Dt></ValDt>
        <AcctSvcrRef>${e.ref}</AcctSvcrRef>
        <BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>${e.direction === 'DBIT' ? 'ICDT' : 'RCDT'}</Cd><SubFmlyCd>DMCT</SubFmlyCd></Fmly></Domn></BkTxCd>
        <NtryDtls>
${e.details.map((d) => detail(d, e.direction, currency)).join('\n')}
        </NtryDtls>
        <AddtlNtryInf>${esc(e.text)}</AddtlNtryInf>
      </Ntry>`;
}

export function camt053Xml(s: CamtStatement): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt>
    <GrpHdr>
      <MsgId>MSG-${s.id}</MsgId>
      <CreDtTm>${s.created}</CreDtTm>
    </GrpHdr>
    <Stmt>
      <Id>${s.id}</Id>
      <CreDtTm>${s.created}</CreDtTm>
      <FrToDt><FrDtTm>${s.from}T00:00:00</FrDtTm><ToDtTm>${s.to}T23:59:59</ToDtTm></FrToDt>
      <Acct>
        <Id><IBAN>${s.iban}</IBAN></Id>
        <Ccy>${s.currency}</Ccy>
        <Ownr><Nm>${esc(s.owner)}</Nm></Ownr>
        <Svcr><FinInstnId><Nm>${esc(s.institution)}</Nm></FinInstnId></Svcr>
      </Acct>
${balance('OPBD', s.opening, s.currency, s.from)}
${balance('CLBD', s.closing, s.currency, s.to)}
${s.entries.map((e) => entry(e, s.currency)).join('\n')}
    </Stmt>
  </BkToCstmrStmt>
</Document>
`;
}
