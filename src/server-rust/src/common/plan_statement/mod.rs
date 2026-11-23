//! `src/common/plan-statement/`: reading a recordkeeper's plan statement,
//! planning the investment transactions it imports, and previewing what the
//! import does to the account.
//!
//! Statement rows, daily closes, fund mappings, planned transactions and
//! everything else that is an object in the TypeScript is a JSON object with
//! the same keys in the same order. The few results that are only containers
//! of those (`ParsedStatement`, `ImportPlan`, `PlanStatementPreview`) are
//! structs of their members with a `to_json()` that writes the TypeScript's
//! object. Where the TypeScript throws on a row of the wrong shape (a label
//! that is not text, an amount that is not a number), the function returns
//! an error.

pub mod parse;
pub mod plan;
pub mod preview;
pub mod reinvest;

pub use parse::*;
pub use plan::*;
pub use preview::*;
pub use reinvest::*;
