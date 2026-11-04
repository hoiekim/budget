import {
  CountryCode,
  Holding as PlaidHolding,
  Security as PlaidSecurity,
  Institution as PlaidInstitution,
  Products,
} from "../lib/plaid-enums";

export interface JSONHolding extends PlaidHolding {
  holding_id: string;
}

export interface JSONSecurity extends PlaidSecurity {}

// `products` / `country_codes` are Omit-ted from the SDK interface and
// redeclared with the local unions (see plaid-enums.ts): a local union is
// not assignable to the SDK enum, so inheriting them would make the
// redeclarations below a type error.
export interface JSONInstitution extends Omit<PlaidInstitution, "products" | "country_codes"> {
  products: Products[];
  country_codes: CountryCode[];
}
