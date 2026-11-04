import { deleteCategory, makeDeleteEntityRoute } from "server";

export const deleteCategoryRoute = makeDeleteEntityRoute("/category", deleteCategory);
