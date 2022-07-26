import { Route, GetResponse, createSection, updateSection } from "server";

const getResponse: GetResponse<{ section_id: string }> = async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  try {
    let response:
      | Awaited<ReturnType<typeof updateSection>>
      | Awaited<ReturnType<typeof createSection>>;
    if (req.body) response = await updateSection(req.body);
    else response = await createSection(user);
    return { status: "success", data: { section_id: response._id } };
  } catch (error: any) {
    console.error(`Failed to update(create) a section: ${req.body.section_id}`);
    throw new Error(error);
  }
};

const route = new Route("POST", "/section", getResponse);

export default route;
