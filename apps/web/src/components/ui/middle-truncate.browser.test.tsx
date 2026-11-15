import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { MiddleTruncate } from "./middle-truncate";

import "~/index.css";

const narrow = (value: string) => (
  <div style={{ width: 80 }}>
    <MiddleTruncate value={value} className="w-full" />
  </div>
);

describe("MiddleTruncate", () => {
  it("does not clip a short value that replaces a truncated one", async () => {
    await using screen = await render(narrow("t3/investigate-release-build-times"));
    const label = () => screen.container.querySelector("[title] > span");
    await expect.poll(() => label()?.hasAttribute("data-overflow")).toBe(true);

    await screen.rerender(narrow("main"));

    expect(label()).toHaveTextContent("main");
    expect(label()).not.toHaveAttribute("data-overflow");
    expect(label()).toHaveStyle({ clipPath: "none" });
  });

  it("fits every head mounted in the same commit", async () => {
    const values = ["t3/investigate-release-build-times", "t3/remove-stale-worktree-branches"];
    await using screen = await render(
      <>
        {values.map((value) => (
          <div key={value}>{narrow(value)}</div>
        ))}
      </>,
    );
    const heads = () => [
      ...screen.container.querySelectorAll<HTMLElement>("[title] > span:first-child"),
    ];

    await vi.waitFor(() =>
      expect(heads().filter((head) => head.hasAttribute("data-overflow"))).toHaveLength(2),
    );
  });

  it.each([
    ["Fix the sidebar", 7],
    ["report\u2003\u2003draft.txt", 9],
  ])("renders %j split as wide as whole", async (value, tail) => {
    await using screen = await render(
      <div>
        <MiddleTruncate value={value} tail={tail} data-testid="split" />
        <span data-testid="whole" className="whitespace-nowrap">
          {value}
        </span>
      </div>,
    );
    const width = (id: string) => screen.getByTestId(id).element().getBoundingClientRect().width;

    expect(width("split")).toBeCloseTo(width("whole"), 0);
  });

  it("never clips the tail when its text fits but its text and the ellipsis do not", async () => {
    const value = "gap-acquisition-plan-docs/operations";
    const boxed = (width: number) => (
      <div data-testid="box" style={{ width }}>
        <MiddleTruncate value={value} tail={11} className="w-full" />
      </div>
    );
    await using screen = await render(boxed(600));
    const tail = () => screen.container.querySelector<HTMLElement>("[title] > span:last-child")!;
    const tailWidth = tail().getBoundingClientRect().width;

    // Narrower than the tail with its marker, wider than the tail alone.
    await screen.rerender(boxed(Math.ceil(tailWidth) + 3));
    const head = screen.container.querySelector("[title] > span:first-child")!;
    await expect.poll(() => head.hasAttribute("data-overflow")).toBe(true);

    const box = screen.getByTestId("box").element().getBoundingClientRect();
    expect(tail().getBoundingClientRect().right).toBeLessThanOrEqual(box.right + 0.5);

    // With room for the head, the ellipsis keeps its full width however far the value overflows.
    const ellipsisWidth = () =>
      screen.container.querySelector("[title] > span:nth-child(2)")!.getBoundingClientRect().width;
    await screen.rerender(boxed(Math.ceil(tailWidth) + 60));
    await expect.poll(() => ellipsisWidth()).toBeGreaterThan(4);
    const roomy = ellipsisWidth();
    await screen.rerender(boxed(Math.ceil(tailWidth) + 25));
    await expect.poll(() => ellipsisWidth()).toBeCloseTo(roomy, 1);
  });

  it("keeps the raw value's tail when collapsing its spaces", async () => {
    await using screen = await render(<MiddleTruncate value={"longprefix a  b.txt"} />);

    expect(screen.container.querySelector("[title] > span:last-child")?.textContent).toBe(
      "x a b.txt",
    );
  });
});
