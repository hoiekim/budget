import type { FederalIncomeTaxTable, StateIncomeTaxTable } from "./tax";

/**
 * Income tax parameters for a single filer, tax year 2026, used to estimate
 * the projection chart's auto tax rate (`./tax.ts`).
 *
 * Compiled 2026-11-14 from state revenue department releases, legislative
 * fiscal notes, and Tax Foundation's "State Individual Income Tax Rates and
 * Brackets, 2026", including laws passed during 2026 that apply retroactively
 * to January 1 (AR, GA, SC, UT, WV). A state whose figures are from another
 * year says so in `taxYear`; `// source:` comments mark figures that differ
 * from Tax Foundation's January table or that need a second look.
 *
 * Out of scope, by design: local/city/county income taxes (notably MD
 * counties, NYC, and Ohio/Pennsylvania municipalities), phase-outs other than
 * the three modeled below (CT, UT, WI), and Maine's 2% surcharge above $1M.
 * The MA 4% surtax and the CA 1% mental-health surtax are included as top
 * brackets.
 *
 */
export const TAX_YEAR = 2026;

/** IRS Rev. Proc. 2025-32 (2026, as amended by the One Big Beautiful Bill Act). */
export const FEDERAL_INCOME_TAX: FederalIncomeTaxTable = {
  standardDeduction: 16100,
  brackets: [
    [0, 0.1],
    [12400, 0.12],
    [50400, 0.22],
    [105700, 0.24],
    [201775, 0.32],
    [256225, 0.35],
    [640600, 0.37],
  ],
};

/** Keyed by USPS code. An empty `brackets` list means no tax on wage income. */
export const STATE_INCOME_TAX: Record<string, StateIncomeTaxTable> = {
  AK: { brackets: [], standardDeduction: 0, personalExemption: 0, personalCredit: 0 },
  AL: { brackets: [[0, 0.02], [500, 0.04], [3000, 0.05]], standardDeduction: 3000, personalExemption: 1500, personalCredit: 0 },
  // source: Act 2 of 2026 1st Extraordinary Session (SB1, signed 2026-05-06) cut the top rate 3.9% -> 3.7%, retroactive to 2026-01-01 (DFA fiscal note).
  // Uses the table for net income <= $94,700; above that AR uses 2% on the first $4,700 and 3.7% on the rest (about $290 more tax).
  AR: { brackets: [[0, 0], [5600, 0.02], [11200, 0.03], [16000, 0.034], [26400, 0.037]], standardDeduction: 2470, personalExemption: 0, personalCredit: 29 },
  AZ: { brackets: [[0, 0.025]], standardDeduction: 16100, personalExemption: 0, personalCredit: 0 },
  // source: FTB Tax News Oct 2026 (2026 indexing +3.4%: std ded $5,900, exemption credit $158, first bracket $11,456).
  // The 4th-6th thresholds were computed from the 2025 figures with the 3.4% factor. The top entry is the 1% mental-health surtax above $1M.
  CA: { brackets: [[0, 0.01], [11456, 0.02], [27157, 0.04], [42861, 0.06], [59498, 0.08], [75197, 0.093], [384109, 0.103], [460927, 0.113], [768213, 0.123], [1000000, 0.133]], standardDeduction: 5900, personalExemption: 0, personalCredit: 158 },
  CO: { brackets: [[0, 0.044]], standardDeduction: 16100, personalExemption: 0, personalCredit: 0 },
  // source: the $15,000 exemption drops $1,000 per $1,000 of income over $30,000, so it is gone at $45,000.
  CT: { brackets: [[0, 0.02], [10000, 0.045], [50000, 0.055], [100000, 0.06], [200000, 0.065], [250000, 0.069], [500000, 0.0699]], standardDeduction: 0, personalExemption: 15000, personalCredit: 0, phaseOut: { allowance: "personalExemption", from: 30000, to: 45000 } },
  // source: OTR 2026 D-40ES worksheet uses $16,100. DC's OBBBA decoupling was repealed by Congress (H.J.Res. 142, Feb 2026); some sources still show $15,000.
  DC: { brackets: [[0, 0.04], [10000, 0.06], [40000, 0.065], [60000, 0.085], [250000, 0.0925], [500000, 0.0975], [1000000, 0.1075]], standardDeduction: 16100, personalExemption: 0, personalCredit: 0 },
  DE: { brackets: [[0, 0], [2000, 0.022], [5000, 0.039], [10000, 0.048], [20000, 0.052], [25000, 0.0555], [60000, 0.066]], standardDeduction: 3250, personalExemption: 0, personalCredit: 110 },
  FL: { brackets: [], standardDeduction: 0, personalExemption: 0, personalCredit: 0 },
  // source: HB 463 (2026) cut the rate 5.19% -> 4.99% and raised the std ded $12,000 -> $15,000, retroactive to 2026-01-01 (GA DOR "Important Tax Updates").
  GA: { brackets: [[0, 0.0499]], standardDeduction: 15000, personalExemption: 0, personalCredit: 0 },
  // source: HI DoTax announcement on Act 46 (2024): std ded $8,000 effective TY2026, brackets unchanged from 2025.
  HI: { brackets: [[0, 0.014], [9600, 0.032], [14400, 0.055], [19200, 0.064], [24000, 0.068], [36000, 0.072], [48000, 0.076], [125000, 0.079], [175000, 0.0825], [225000, 0.09], [275000, 0.10], [325000, 0.11]], standardDeduction: 8000, personalExemption: 1144, personalCredit: 0 },
  IA: { brackets: [[0, 0.038]], standardDeduction: 16100, personalExemption: 0, personalCredit: 40 },
  ID: { brackets: [[0, 0], [4811, 0.053]], standardDeduction: 16100, personalExemption: 0, personalCredit: 0 },
  IL: { brackets: [[0, 0.0495]], standardDeduction: 0, personalExemption: 2925, personalCredit: 0 },
  IN: { brackets: [[0, 0.0295]], standardDeduction: 0, personalExemption: 1000, personalCredit: 0 },
  KS: { brackets: [[0, 0.052], [23000, 0.0558]], standardDeduction: 3605, personalExemption: 9160, personalCredit: 0 },
  KY: { brackets: [[0, 0.035]], standardDeduction: 3360, personalExemption: 0, personalCredit: 0 },
  LA: { brackets: [[0, 0.03]], standardDeduction: 12875, personalExemption: 0, personalCredit: 0 },
  // source: MA DOR certified the 2026 surtax threshold of $1,107,750 on 2025-11-20 (5% + 4% surtax = 9% above it).
  MA: { brackets: [[0, 0.05], [1107750, 0.09]], standardDeduction: 0, personalExemption: 4400, personalCredit: 0 },
  // source: std ded $3,400 = 2025's $3,350 indexed (Comptroller 2026 withholding, per a secondary source). Not confirmed on an official page; $3,350 is possible.
  MD: { brackets: [[0, 0.02], [1000, 0.03], [2000, 0.04], [3000, 0.0475], [100000, 0.05], [125000, 0.0525], [150000, 0.055], [250000, 0.0575], [500000, 0.0625], [1000000, 0.065]], standardDeduction: 3400, personalExemption: 3200, personalCredit: 0 },
  // source: MRS 2026 rate schedule (rev. 2026-05-20). Std ded $15,300 per Withum; a few sources say $15,700.
  // Maine's new 2% surcharge above $1M is not modeled (see the file header).
  ME: { brackets: [[0, 0.058], [27400, 0.0675], [64850, 0.0715]], standardDeduction: 15300, personalExemption: 5300, personalCredit: 0 },
  MI: { brackets: [[0, 0.0425]], standardDeduction: 0, personalExemption: 5900, personalCredit: 0 },
  MN: { brackets: [[0, 0.0535], [33310, 0.068], [109430, 0.0785], [203150, 0.0985]], standardDeduction: 15300, personalExemption: 0, personalCredit: 0 },
  MO: { brackets: [[0, 0], [1348, 0.02], [2696, 0.025], [4044, 0.03], [5392, 0.035], [6740, 0.04], [8088, 0.045], [9436, 0.047]], standardDeduction: 16100, personalExemption: 0, personalCredit: 0 },
  MS: { brackets: [[0, 0], [10000, 0.04]], standardDeduction: 2300, personalExemption: 6000, personalCredit: 0 },
  MT: { brackets: [[0, 0.047], [47500, 0.0565]], standardDeduction: 16100, personalExemption: 0, personalCredit: 0 },
  NC: { brackets: [[0, 0.0399]], standardDeduction: 12750, personalExemption: 0, personalCredit: 0 },
  ND: { brackets: [[0, 0], [49575, 0.0195], [250400, 0.025]], standardDeduction: 16100, personalExemption: 0, personalCredit: 0 },
  NE: { brackets: [[0, 0.0246], [4130, 0.0351], [24760, 0.0455]], standardDeduction: 8850, personalExemption: 0, personalCredit: 176 },
  NH: { brackets: [], standardDeduction: 0, personalExemption: 0, personalCredit: 0 },
  NJ: { brackets: [[0, 0.014], [20000, 0.0175], [35000, 0.035], [40000, 0.05525], [75000, 0.0637], [500000, 0.0897], [1000000, 0.1075]], standardDeduction: 0, personalExemption: 1000, personalCredit: 0 },
  NM: { brackets: [[0, 0.015], [5500, 0.032], [16500, 0.043], [33500, 0.047], [66500, 0.049], [210000, 0.059]], standardDeduction: 16100, personalExemption: 0, personalCredit: 0 },
  NV: { brackets: [], standardDeduction: 0, personalExemption: 0, personalCredit: 0 },
  NY: { brackets: [[0, 0.039], [8500, 0.044], [11700, 0.0515], [13900, 0.054], [80650, 0.059], [215400, 0.0685], [1077550, 0.0965], [5000000, 0.103], [25000000, 0.109]], standardDeduction: 8000, personalExemption: 0, personalCredit: 0 },
  OH: { brackets: [[0, 0], [26050, 0.0275]], standardDeduction: 0, personalExemption: 2400, personalCredit: 0 },
  OK: { brackets: [[0, 0], [3750, 0.025], [4900, 0.035], [7200, 0.045]], standardDeduction: 6350, personalExemption: 1000, personalCredit: 0 },
  OR: { brackets: [[0, 0.0475], [4550, 0.0675], [11400, 0.0875], [125000, 0.099]], standardDeduction: 2910, personalExemption: 0, personalCredit: 263 },
  PA: { brackets: [[0, 0.0307]], standardDeduction: 0, personalExemption: 0, personalCredit: 0 },
  RI: { brackets: [[0, 0.0375], [82050, 0.0475], [186450, 0.0599]], standardDeduction: 11200, personalExemption: 5250, personalCredit: 0 },
  // source: H.4216 / Act 110 (2026), retroactive to TY2026: 1.99% up to $30,000, 5.21% above. The SC Income Adjusted Deduction ($15,000 single) replaces the federal std ded and phases out with income.
  // The phase-out schedule was not found, so the full deduction is applied at every income (understates tax at higher incomes).
  SC: { brackets: [[0, 0.0199], [30000, 0.0521]], standardDeduction: 15000, personalExemption: 0, personalCredit: 0 },
  SD: { brackets: [], standardDeduction: 0, personalExemption: 0, personalCredit: 0 },
  TN: { brackets: [], standardDeduction: 0, personalExemption: 0, personalCredit: 0 },
  TX: { brackets: [], standardDeduction: 0, personalExemption: 0, personalCredit: 0 },
  // source: SB 60 (2026) cut the rate 4.5% -> 4.45%, retroactive to 2026-01-01. personalCredit = taxpayer tax credit, 6% x $16,100 federal std ded.
  // The credit shrinks by 1.3% of income above about $18k (single), so it is $0 above roughly $92k — modeled as a linear phase-out.
  UT: { brackets: [[0, 0.0445]], standardDeduction: 0, personalExemption: 0, personalCredit: 966, phaseOut: { allowance: "personalCredit", from: 18000, to: 92300 } },
  VA: { brackets: [[0, 0.02], [3000, 0.03], [5000, 0.05], [17000, 0.0575]], standardDeduction: 8750, personalExemption: 930, personalCredit: 0 },
  // source: VT has not published its indexed 2026 figures (sources conflict), so these are the 2025 brackets, std ded and exemption.
  VT: { brackets: [[0, 0.0335], [49400, 0.066], [119700, 0.076], [249700, 0.0875]], standardDeduction: 7650, personalExemption: 5300, personalCredit: 0, taxYear: 2025 },
  WA: { brackets: [], standardDeduction: 0, personalExemption: 0, personalCredit: 0 },
  // source: The max sliding-scale std ded is $13,960, which phases out (modeled linearly) between about $20k and $136k of income.
  WI: { brackets: [[0, 0.035], [15110, 0.044], [51950, 0.053], [332720, 0.0765]], standardDeduction: 13960, personalExemption: 700, personalCredit: 0, phaseOut: { allowance: "standardDeduction", from: 20000, to: 136000 } },
  // source: SB 392 (2026) cut all rates 5%, retroactive to 2026-01-01 (2.22/2.96/3.33/4.44/4.82 -> 2.11/2.81/3.16/4.22/4.58).
  WV: { brackets: [[0, 0.0211], [10000, 0.0281], [25000, 0.0316], [40000, 0.0422], [60000, 0.0458]], standardDeduction: 0, personalExemption: 2000, personalCredit: 0 },
  WY: { brackets: [], standardDeduction: 0, personalExemption: 0, personalCredit: 0 },
};
