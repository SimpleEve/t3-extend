import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { useLatched } from "./useLoopbackGatewayState";

function Probe(props: { readonly value: boolean }) {
  return <p>{useLatched(props.value) ? "open" : "closed"}</p>;
}

describe("latched gate", () => {
  it("opens when its value turns true and stays open when it turns false again", async () => {
    await using screen = await render(<Probe value={false} />, { router: false });
    expect(screen.container.textContent).toBe("closed");
    await screen.rerender(<Probe value={true} />);
    expect(screen.container.textContent).toBe("open");
    await screen.rerender(<Probe value={false} />);
    expect(screen.container.textContent).toBe("open");
  });
});
