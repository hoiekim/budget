import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Modal } from "./index";

afterEach(() => {
  cleanup();
});

const renderModal = (onClose: () => void = () => {}) =>
  render(
    <Modal label="Test dialog" title="Test" closeLabel="Close test dialog" onClose={onClose}>
      <button>First</button>
      <button>Second</button>
    </Modal>,
  );

const panel = () => document.querySelector("div.Modal > div.panel") as HTMLDivElement;
const closeButton = () =>
  screen.getByRole("button", { name: "Close test dialog" }) as HTMLButtonElement;
const secondButton = () => screen.getByRole("button", { name: "Second" }) as HTMLButtonElement;

describe("Modal", () => {
  it("moves focus into the dialog on open", () => {
    renderModal();

    expect(document.activeElement).toBe(panel());
  });

  it("wraps Tab from the last control to the first", () => {
    renderModal();

    // Tab order inside the panel: close button, First, Second.
    secondButton().focus();
    fireEvent.keyDown(panel(), { key: "Tab" });

    expect(document.activeElement).toBe(closeButton());
  });

  it("wraps Shift+Tab from the first control to the last", () => {
    renderModal();

    closeButton().focus();
    fireEvent.keyDown(panel(), { key: "Tab", shiftKey: true });

    expect(document.activeElement).toBe(secondButton());
  });

  it("closes on Escape", () => {
    let closed = 0;
    renderModal(() => {
      closed += 1;
    });

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(closed).toBe(1);
  });
});
