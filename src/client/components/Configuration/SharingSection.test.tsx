import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import type { Sharing } from "server";
import { Data, Properties, globalData } from "client";
import { buildContext, renderWithContext, resetDom, stubFetch, type FetchStubRoute } from "test-render";
import { SharingSection } from "./SharingSection";

const ME = { user_id: "u-me", username: "me" };
const ANN = { user_id: "u-ann", username: "ann" };
const BEN = { user_id: "u-ben", username: "ben" };
const CAT = { user_id: "u-cat", username: "cat" };

const SUCCESS = { status: "success" };

/** Button labels are set with non-breaking spaces, which an accessible name keeps. */
const nb = (label: string) => label.replace(/ /g, "\u00a0");

let fetchStub: ReturnType<typeof stubFetch> | undefined;
let spies: { mockRestore: () => void }[] = [];

afterEach(() => {
  cleanup();
  fetchStub?.restore();
  fetchStub = undefined;
  spies.forEach((spy) => spy.mockRestore());
  spies = [];
  globalData.update(new Data());
  resetDom();
});

/** Lets the debounced refetches that follow an action run and settle. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

interface Rendered {
  /** `"METHOD url"` for every request, in order. */
  requests: () => string[];
  /** The JSON bodies sent, in order. */
  bodies: unknown[];
  /** The sharing state the app holds after whatever refetches ran. */
  sharing: () => Sharing;
}

const renderSection = (
  sharing: Sharing,
  routes: FetchStubRoute[] = [],
  user = ME,
): Rendered => {
  fetchStub = stubFetch(routes);
  const bodies: unknown[] = [];
  const stubbed = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
    return stubbed(input, init);
  }) as typeof globalThis.fetch;

  let data = new Data({ sharing });
  globalData.update(data);
  renderWithContext(
    <Properties>
      <SharingSection />
    </Properties>,
    buildContext({
      user,
      data,
      // As the app's own `setData` does, keep the tab-wide mirror in step.
      setData: (next) => {
        data = typeof next === "function" ? next(data) : next;
        globalData.update(data);
      },
    }),
  );
  return {
    requests: () => fetchStub!.calls.requests.map(({ method, url }) => `${method} ${url}`),
    bodies,
    sharing: () => data.sharing,
  };
};

const answerConfirm = (answer: boolean) => {
  const confirm = spyOn(window, "confirm").mockImplementation(() => answer);
  spies.push(confirm);
  return confirm;
};

const NOBODY: Sharing = { members: [], invitations: [] };

describe("SharingSection", () => {
  it("offers only the invitation form to someone sharing with nobody", () => {
    renderSection(NOBODY);
    expect(screen.getByText("Share Data")).toBeTruthy();
    expect(screen.queryByText("Sharing With")).toBeNull();
    expect(screen.queryByText("Invitation To Share")).toBeNull();
    expect(screen.queryByText("Sent Invitation")).toBeNull();
    expect(screen.queryByRole("button", { name: nb("Stop Sharing") })).toBeNull();
  });

  it("shows the demo account nothing", () => {
    renderSection(
      { members: [ME, ANN], invitations: [] },
      [],
      { user_id: ME.user_id, username: "demo" },
    );
    expect(screen.queryByText("Share Data")).toBeNull();
    expect(screen.queryByText("ann")).toBeNull();
  });

  it("lists the person the user shares with, and not the user", () => {
    renderSection({ members: [ANN, ME], invitations: [] });
    expect(screen.getByText("Sharing With")).toBeTruthy();
    expect(screen.getByText("ann")).toBeTruthy();
    expect(screen.queryByText("me")).toBeNull();
    expect(screen.queryByRole("button", { name: nb("Stop Sharing With Everyone") })).toBeNull();
  });

  it("numbers the people when there are several", () => {
    renderSection({ members: [ANN, BEN, ME], invitations: [] });
    expect(screen.getByText("Sharing With 1")).toBeTruthy();
    expect(screen.getByText("Sharing With 2")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: nb("Stop Sharing") })).toHaveLength(2);
  });

  it("stops sharing with one person only after the user confirms", async () => {
    const rendered = renderSection({ members: [ANN, BEN, ME], invitations: [] }, [
      { path: "/api/sharing/member", response: SUCCESS },
    ]);
    const confirm = answerConfirm(false);
    const [, stopBen] = screen.getAllByRole("button", { name: nb("Stop Sharing") });
    fireEvent.click(stopBen);
    await settle();
    expect(confirm.mock.calls[0]?.[0]).toContain("ben");
    expect(rendered.requests()).toEqual([]);

    confirm.mockImplementation(() => true);
    fireEvent.click(stopBen);
    await settle();
    expect(rendered.requests()[0]).toBe("DELETE /api/sharing/member?user_id=u-ben");
  });

  it("leaves a group of several by removing the user", async () => {
    const rendered = renderSection({ members: [ANN, BEN, ME], invitations: [] }, [
      { path: "/api/sharing/member", response: SUCCESS },
    ]);
    answerConfirm(true);
    fireEvent.click(screen.getByRole("button", { name: nb("Stop Sharing With Everyone") }));
    await settle();
    expect(rendered.requests()[0]).toBe("DELETE /api/sharing/member?user_id=u-me");
  });

  it("refetches everything once sharing has stopped", async () => {
    const rendered = renderSection({ members: [ANN, ME], invitations: [] }, [
      { path: "/api/sharing/member", response: SUCCESS },
    ]);
    answerConfirm(true);
    fireEvent.click(screen.getByRole("button", { name: nb("Stop Sharing") }));
    await settle();
    const requests = rendered.requests();
    expect(requests).toContain("GET /api/accounts");
    expect(requests).toContain("GET /api/sharing");
  });

  it("accepts an invitation only after the user confirms, then refetches everything", async () => {
    const invitation = { invitation_id: "inv-1", inviter: ANN, invitee: ME };
    const rendered = renderSection({ members: [], invitations: [invitation] }, [
      { path: "/api/sharing/member", response: SUCCESS },
    ]);
    expect(screen.getByText("Invitation To Share")).toBeTruthy();
    expect(screen.getByText("ann")).toBeTruthy();

    const confirm = answerConfirm(false);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await settle();
    expect(confirm.mock.calls[0]?.[0]).toContain("ann");
    expect(rendered.requests()).toEqual([]);

    confirm.mockImplementation(() => true);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await settle();
    expect(rendered.requests()[0]).toBe("POST /api/sharing/member");
    expect(rendered.bodies).toEqual([{ invitation_id: "inv-1" }]);
    expect(rendered.requests()).toContain("GET /api/accounts");
  });

  it("says why an invitation could not be accepted", async () => {
    const invitation = { invitation_id: "inv-1", inviter: ANN, invitee: ME };
    const rendered = renderSection({ members: [], invitations: [invitation] }, [
      { path: "/api/sharing/member", response: { status: "failed", message: "No longer open." } },
      { path: "/api/sharing", response: { status: "success", body: NOBODY } },
    ]);
    answerConfirm(true);
    const alert = spyOn(window, "alert").mockImplementation(() => {});
    spies.push(alert);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await settle();
    expect(alert.mock.calls).toEqual([["No longer open."]]);
    expect(rendered.requests()).not.toContain("GET /api/accounts");
    expect(rendered.sharing()).toEqual(NOBODY);
  });

  it("declines an invitation without asking, and drops it from the page's data", async () => {
    const invitation = { invitation_id: "inv-1", inviter: ANN, invitee: ME };
    const rendered = renderSection({ members: [], invitations: [invitation] }, [
      { path: "/api/sharing/invitation", response: SUCCESS },
      { path: "/api/sharing", response: { status: "success", body: NOBODY } },
    ]);
    const confirm = answerConfirm(true);
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    await settle();
    expect(confirm.mock.calls).toEqual([]);
    expect(rendered.requests()).toEqual([
      "DELETE /api/sharing/invitation?id=inv-1",
      "GET /api/sharing",
    ]);
    expect(rendered.sharing()).toEqual(NOBODY);
  });

  it("shows an invitation the user sent, and withdraws it", async () => {
    const invitation = { invitation_id: "inv-2", inviter: ME, invitee: CAT };
    const rendered = renderSection({ members: [], invitations: [invitation] }, [
      { path: "/api/sharing/invitation", response: SUCCESS },
      { path: "/api/sharing", response: { status: "success", body: NOBODY } },
    ]);
    expect(screen.getByText("Sent Invitation")).toBeTruthy();
    expect(screen.getByText("cat")).toBeTruthy();
    expect(screen.queryByText("From")).toBeNull();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    await settle();
    expect(rendered.requests()[0]).toBe("DELETE /api/sharing/invitation?id=inv-2");
  });

  it("names who sent an invitation when it was someone else in the group", () => {
    const invitation = { invitation_id: "inv-3", inviter: ANN, invitee: CAT };
    renderSection({ members: [ANN, ME], invitations: [invitation] });
    expect(screen.getByText("Sent Invitation")).toBeTruthy();
    expect(screen.getByText("From")).toBeTruthy();
    expect(screen.getByText("cat")).toBeTruthy();
  });

  it("sends an invitation to the trimmed username, then clears the form and shows the invitation", async () => {
    const invitation = { invitation_id: "inv-4", inviter: ME, invitee: CAT };
    const afterwards: Sharing = { members: [], invitations: [invitation] };
    const rendered = renderSection(NOBODY, [
      { path: "/api/sharing/invitation", response: { status: "success", body: { invitation } } },
      { path: "/api/sharing", response: { status: "success", body: afterwards } },
    ]);
    const input = screen.getByLabelText("Username or email address to share data with") as HTMLInputElement;
    const send = screen.getByRole("button", { name: nb("Send Invitation") }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "  cat " } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await settle();

    expect(rendered.requests()).toEqual(["POST /api/sharing/invitation", "GET /api/sharing"]);
    expect(rendered.bodies).toEqual([{ username: "cat" }]);
    expect(input.value).toBe("");
    expect(rendered.sharing()).toEqual(afterwards);
  });

  it("keeps what was typed and says why when the invitation is refused", async () => {
    const rendered = renderSection(NOBODY, [
      {
        path: "/api/sharing/invitation",
        response: { status: "failed", message: "No user has that username." },
      },
    ]);
    const input = screen.getByLabelText("Username or email address to share data with") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "nobody" } });
    fireEvent.click(screen.getByRole("button", { name: nb("Send Invitation") }));
    await settle();

    expect(screen.getByText("No user has that username.")).toBeTruthy();
    expect(input.value).toBe("nobody");
    expect(rendered.requests()).toEqual(["POST /api/sharing/invitation"]);
  });

  it("sends text with an @ in it as an email address, and shows the invitation by its address", async () => {
    const invitation = {
      invitation_id: "inv-5",
      inviter: ME,
      invitee: { email: "friend@example.com" },
      expires_at: "2099-12-22T12:00:00.000Z",
    };
    const afterwards: Sharing = { members: [], invitations: [invitation] };
    const rendered = renderSection(NOBODY, [
      { path: "/api/sharing/invitation", response: { status: "success", body: { invitation } } },
      { path: "/api/sharing", response: { status: "success", body: afterwards } },
    ]);
    const input = screen.getByLabelText("Username or email address to share data with") as HTMLInputElement;
    fireEvent.change(input, { target: { value: " Friend@Example.com " } });
    fireEvent.click(screen.getByRole("button", { name: nb("Send Invitation") }));
    await settle();

    expect(rendered.bodies).toEqual([{ email: "Friend@Example.com" }]);
    expect(input.value).toBe("");
    expect(rendered.sharing()).toEqual(afterwards);
  });

  it("shows an open invitation to an address by the address and when it lapses", () => {
    const invitation = {
      invitation_id: "inv-5",
      inviter: ME,
      invitee: { email: "friend@example.com" },
      expires_at: "2099-12-22T12:00:00.000Z",
    };
    renderSection({ members: [], invitations: [invitation] });

    expect(screen.getByText("Sent Invitation")).toBeTruthy();
    expect(screen.getByText("friend@example.com")).toBeTruthy();
    expect(screen.getByText("Expires")).toBeTruthy();
    expect(screen.getByText("Dec 22, 2099")).toBeTruthy();
    expect(screen.queryByRole("button", { name: nb("Send Again") })).toBeNull();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeTruthy();
  });

  it("an invitation that reached the user through their address is one to accept or decline", () => {
    const invitation = {
      invitation_id: "inv-6",
      inviter: ANN,
      invitee: ME,
      expires_at: "2099-12-22T12:00:00.000Z",
    };
    renderSection({ members: [], invitations: [invitation] });

    expect(screen.getByText("Invitation To Share")).toBeTruthy();
    expect(screen.getByText("ann")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
    expect(screen.queryByText("Sent Invitation")).toBeNull();
  });

  it("says an invitation to an address has lapsed, and sends it again on request", async () => {
    const invitation = {
      invitation_id: "inv-7",
      inviter: ME,
      invitee: { email: "friend@example.com" },
      expires_at: "2020-01-15T12:00:00.000Z",
    };
    const rendered = renderSection({ members: [], invitations: [invitation] }, [
      { path: "/api/sharing/invitation", response: { status: "success", body: { invitation } } },
      { path: "/api/sharing", response: { status: "success", body: NOBODY } },
    ]);
    expect(screen.getByText("Expired")).toBeTruthy();
    expect(screen.getByText("Jan 15, 2020")).toBeTruthy();
    expect(screen.queryByText("Expires")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: nb("Send Again") }));
    await settle();

    expect(rendered.requests()[0]).toBe("POST /api/sharing/invitation");
    expect(rendered.bodies).toEqual([{ email: "friend@example.com" }]);
  });

  it("offers to send again only an invitation the user sent, not one another member did", () => {
    const invitation = {
      invitation_id: "inv-9",
      inviter: ANN,
      invitee: { email: "friend@example.com" },
      expires_at: "2020-01-15T12:00:00.000Z",
    };
    renderSection({ members: [ANN, ME], invitations: [invitation] });

    expect(screen.getByText("Expired")).toBeTruthy();
    expect(screen.queryByRole("button", { name: nb("Send Again") })).toBeNull();
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeTruthy();
  });

  it("an invitation to a user has no lapse time to show", () => {
    renderSection({ members: [], invitations: [{ invitation_id: "inv-8", inviter: ME, invitee: CAT }] });
    expect(screen.queryByText("Expires")).toBeNull();
    expect(screen.queryByText("Expired")).toBeNull();
  });

  it("does not offer to send a blank username", () => {
    renderSection(NOBODY);
    fireEvent.change(screen.getByLabelText("Username or email address to share data with"), {
      target: { value: "   " },
    });
    const send = screen.getByRole("button", { name: nb("Send Invitation") }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });
});
