// Unit tests for the delete factory only, with a stub repo function: the
// get-new and update factories are covered at the route level by the
// budgets route tests, which run the real repos against fake SQL, while the
// delete repos run transactions and bulk soft-deletes that the fake-SQL seam
// cannot stage — so the delete composition (auth → id validation → repo
// call) is pinned here instead, with the repo itself stubbed out.
import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { ServerRequest, ServerResponse } from "server";
import type { MaskedUser } from "./postgres/models/user";
import { makeDeleteEntityRoute } from "./entity-routes";

const USER = { user_id: "11111111-1111-1111-1111-111111111111", username: "test" };
const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

for (const noun of ["budget", "category", "section"] as const) {
  describe(`delete-${noun} route`, () => {
    const deleteFn = mock(async (_user: MaskedUser, _id: string) => true);
    const route = makeDeleteEntityRoute(`/${noun}`, deleteFn);

    beforeEach(() => {
      deleteFn.mockClear();
    });

    const makeReq = (
      user?: { user_id: string; username: string },
      query: Record<string, unknown> = { id: UUID },
    ): ServerRequest =>
      ({
        method: "DELETE",
        path: `/${noun}`,
        url: `http://x/api/${noun}`,
        headers: {},
        query,
        body: undefined,
        session: {
          id: "s-1",
          user,
          regenerate() {},
          destroy() {},
        },
        ip: "127.0.0.1",
      }) as unknown as ServerRequest;

    const fakeRes = (): ServerResponse =>
      ({
        statusCode: 200,
        headersSent: false,
        status() {
          return this;
        },
        write() {
          return true;
        },
        end() {},
      }) as unknown as ServerResponse;

    test("an unauthenticated request never reaches the repo", async () => {
      const result = await route.execute(makeReq(undefined), fakeRes());

      expect(result?.status).toBe("failed");
      expect(deleteFn).not.toHaveBeenCalled();
    });

    test("a missing id is refused as a bad request, before any delete", async () => {
      const result = await route.execute(makeReq(USER, {}), fakeRes());

      expect(result?.status).toBe("failed");
      expect((result as { message?: string }).message).toMatch(/id/);
      expect(deleteFn).not.toHaveBeenCalled();
    });

    test("a non-UUID id is refused before it reaches the WHERE clause", async () => {
      const result = await route.execute(makeReq(USER, { id: "not-a-uuid" }), fakeRes());

      expect(result?.status).toBe("failed");
      expect((result as { message?: string }).message).toBe("Field id must be a uuid");
      expect(deleteFn).not.toHaveBeenCalled();
    });

    test("a well-formed request deletes and answers success", async () => {
      const result = await route.execute(makeReq(USER), fakeRes());

      expect(result?.status).toBe("success");
      expect(deleteFn).toHaveBeenCalledWith(USER, UUID);
    });
  });
}
