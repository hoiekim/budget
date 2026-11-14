import { JSONSection } from "common";
import { createSection, makeGetNewEntityRoute } from "server";

export type NewSectionGetResponse = { section: JSONSection };

export const getNewSectionRoute = makeGetNewEntityRoute("/new-section", createSection, {
  parentField: "budget_id",
  bodyKey: "section",
  failureMessage: "Failed to create section.",
});
