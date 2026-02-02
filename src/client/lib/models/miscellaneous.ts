import { getRandomId, assign, JSONHolding, JSONSecurity, JSONInstitution } from "common";
import { CountryCode, InstitutionStatus, Products, OptionContract, FixedIncome } from "plaid";

export class Holding implements JSONHolding {
  get id() {
    return this.holding_id;
  }
  set id(_: string) {}

  account_id: string = "";
  security_id: string = "";
  institution_price: number = 0;
  institution_price_as_of: string | null = null;
  institution_price_datetime?: string | null | undefined;
  institution_value: number = 0;
  cost_basis: number | null = null;
  quantity: number = 0;
  iso_currency_code: string | null = null;
  unofficial_currency_code: string | null = null;
  holding_id: string = "";

  constructor(init?: Partial<Holding & JSONHolding> & { account_id: string; security_id: string }) {
    assign(this, init);
    if (!init?.holding_id) this.holding_id = `${this.account_id}_${this.security_id}`;
  }
}

export class Security implements JSONSecurity {
  get id() {
    return this.security_id;
  }
  set id(_: string) {}

  security_id: string = getRandomId();
  isin: string | null = null;
  cusip: string | null = null;
  sedol: string | null = null;
  institution_security_id: string | null = null;
  institution_id: string | null = null;
  proxy_security_id: string | null = null;
  name: string | null = null;
  ticker_symbol: string | null = null;
  is_cash_equivalent: boolean | null = null;
  type: string | null = null;
  close_price: number | null = null;
  close_price_as_of: string | null = null;
  update_datetime?: string | null | undefined = null;
  iso_currency_code: string | null = null;
  unofficial_currency_code: string | null = null;
  market_identifier_code: string | null = null;
  sector: string | null = null;
  industry: string | null = null;
  option_contract: OptionContract | null = null;
  fixed_income: FixedIncome | null = null;

  constructor(init?: Partial<Security | JSONSecurity>) {
    assign(this, init);
  }
}

export class Institution implements JSONInstitution {
  get id() {
    return this.institution_id;
  }

  institution_id: string = getRandomId();
  name: string = "Unknown";
  products: Products[] = [];
  country_codes: CountryCode[] = [];
  url?: string | null | undefined;
  primary_color?: string | null | undefined;
  logo?: string | null | undefined;
  routing_numbers: string[] = [];
  oauth: boolean = false;
  status?: InstitutionStatus | null | undefined;

  constructor(init?: Partial<Institution | JSONInstitution>) {
    assign(this, init);
  }
}

export class Status {
  isInit = false;
  isLoading = false;
  isError = false;
}
