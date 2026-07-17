import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { TestRowPopover } from "@/components/TestRowPopover";

describe("TestRowPopover", () => {
  it("renders method + endpoint when open", () => {
    const ref = createRef<HTMLSpanElement>();
    render(
      <>
        <span ref={ref}>Get Users</span>
        <TestRowPopover anchorRef={ref} method="GET" endpoint="/api/v1/users" open />
      </>
    );
    expect(screen.getByText("GET")).toBeInTheDocument();
    expect(screen.getByText("/api/v1/users")).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    const ref = createRef<HTMLSpanElement>();
    render(<TestRowPopover anchorRef={ref} method="GET" endpoint="/x" open={false} />);
    expect(screen.queryByText("/x")).not.toBeInTheDocument();
  });
});
