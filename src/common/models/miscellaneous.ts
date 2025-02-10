import { getRandomId, assign, getDateString } from "common";
import {
  Location as PlaidLocation,
  PaymentMeta as PlaidPaymentMeta,
  Holding as PlaidHolding,
  Security as PlaidSecurity,
  Institution as PlaidInstitution,
  OptionContract as PlaidOptionContract,
  FixedIncome as PlaidFixedIncome,
  YieldRate as PlaidYieldRate,
  CountryCode,
  InstitutionStatus,
  Products,
  YieldRateType,
} from "plaid";

export class Location implements PlaidLocation {
  [key: string]: any;

  address: string | null = null;
  city: string | null = null;
  region: string | null = null;
  postal_code: string | null = null;
  country: string | null = null;
  lat: number | null = null;
  lon: number | null = null;
  store_number: string | null = null;

  constructor(init?: Partial<Location>) {
    assign(this, init);
  }
}

export class PaymentMeta implements PlaidPaymentMeta {
  [key: string]: any;

  reference_number: string | null = null;
  ppd_id: string | null = null;
  payee: string | null = null;
  by_order_of: string | null = null;
  payer: string | null = null;
  payment_method: string | null = null;
  payment_processor: string | null = null;
  reason: string | null = null;

  constructor(init?: Partial<PaymentMeta>) {
    assign(this, init);
  }
}

export class Holding implements PlaidHolding {
  get id() {
    return this.holding_id;
  }
  set id(_: string) {}

  [key: string]: any;

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

  constructor(init?: Partial<Holding> & { account_id: string; security_id: string }) {
    assign(this, init);
    if (!init?.holding_id) this.holding_id = `${this.account_id}_${this.security_id}`;
  }
}

export class Security implements PlaidSecurity {
  get id() {
    return this.security_id;
  }
  set id(_: string) {}

  [key: string]: any;

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

  constructor(init?: Partial<Security>) {
    assign(this, init);
    if (!init?.option_contract) this.option_contract = new OptionContract();
    if (!init?.fixed_income) this.fixed_income = new FixedIncome();
  }
}

export class OptionContract implements PlaidOptionContract {
  contract_type: string = "put";
  expiration_date: string = getDateString();
  strike_price: number = 0;
  underlying_security_ticker: string = "";

  constructor(init?: Partial<OptionContract>) {
    assign(this, init);
  }
}

export class FixedIncome implements PlaidFixedIncome {
  yield_rate: YieldRate | null = null;
  maturity_date: string | null = null;
  issue_date: string | null = null;
  face_value: number | null = null;

  constructor(init?: Partial<FixedIncome> & { account_id: string; security_id: string }) {
    assign(this, init);
    if (init?.yield_rate) this.yield_rate = new YieldRate(init.yield_rate);
  }
}

export class YieldRate implements PlaidYieldRate {
  percentage: number = 0;
  type: YieldRateType | null = null;

  constructor(init?: Partial<YieldRate>) {
    assign(this, init);
  }
}

export class Institution implements PlaidInstitution {
  get id() {
    return this.institution_id;
  }

  [key: string]: any;

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

  constructor(init?: Partial<Institution>) {
    assign(this, init);
  }
}
