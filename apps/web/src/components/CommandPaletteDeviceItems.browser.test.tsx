import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render, stubGlobal } from "../../test/render";

const mocks = vi.hoisted(() => ({ navigate: vi.fn(async () => undefined) }));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => mocks.navigate) as never,
}));

import { useDeviceInviteRequests } from "../fork/deviceKeysStore";
import { useCommandPaletteDeviceItems } from "./CommandPaletteDeviceItems";

function Probe() {
  const items = useCommandPaletteDeviceItems();
  const requests = useDeviceInviteRequests();
  return (
    <div>
      <p>requests: {requests}</p>
      {items.map((item) => (
        <button key={item.value} type="button" onClick={() => void item.run()}>
          {item.title}
        </button>
      ))}
    </div>
  );
}

describe("the Invite a device palette action", () => {
  it("is offered in the desktop app, opens the Devices section and asks for an invite", async () => {
    mocks.navigate.mockClear();
    using _bridge = stubGlobal("desktopBridge", {});
    await using _screen = await render(<Probe />, { router: false });
    await expect.element(page.getByText("requests: 0")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Invite a device" }));
    await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: "/settings/access" }));
    await expect.element(page.getByText("requests: 1")).toBeVisible();
  });

  it("is not offered in a browser", async () => {
    await using screen = await render(<Probe />, { router: false });
    expect(screen.container.querySelectorAll("button")).toHaveLength(0);
  });
});
