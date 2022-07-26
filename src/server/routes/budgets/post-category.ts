import { Route, GetResponse, createCategory, updateCategory } from "server";

const getResponse: GetResponse<{ category_id: string }> = async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  try {
    let response:
      | Awaited<ReturnType<typeof updateCategory>>
      | Awaited<ReturnType<typeof createCategory>>;
    if (req.body) response = await updateCategory(req.body);
    else response = await createCategory(user);
    return { status: "success", data: { category_id: response._id } };
  } catch (error: any) {
    console.error(`Failed to update(create) a category: ${req.body.category_id}`);
    throw new Error(error);
  }
};

const route = new Route("POST", "/category", getResponse);

export default route;
