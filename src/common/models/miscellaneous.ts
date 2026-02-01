import {
  Holding as PlaidHolding,
  Security as PlaidSecurity,
  Institution as PlaidInstitution,
} from "plaid";

export interface JSONHolding extends PlaidHolding {
  holding_id: string;
}

export interface JSONSecurity extends PlaidSecurity {}

export interface JSONInstitution extends PlaidInstitution {}
