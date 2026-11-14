import { deleteSection, makeDeleteEntityRoute } from "server";

export const deleteSectionRoute = makeDeleteEntityRoute("/section", deleteSection);
