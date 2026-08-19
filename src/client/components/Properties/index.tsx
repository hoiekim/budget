import { ComponentPropsWithoutRef, ReactNode } from "react";
import "./index.css";

type PropertiesProps = ComponentPropsWithoutRef<"div">;

/**
 * Properties shell. Wrap a screen's property list in `<Properties>` and the
 * children render against the canonical shell styling (#292929 box,
 * 5px radius, label font-sizing, row spacing, etc.).
 *
 * `className` is merged in front of the reserved `"Properties"` token to
 * preserve the existing convention: `<div class="<Foo>Properties Properties">`.
 * Drop in as `<Properties className="HoldingProperties">…</Properties>`.
 *
 * 🔴 Children MUST be direct `<PropertyLabel>` / `<Property>` pairs. Do NOT
 * wrap groups of children in an extra `<div>` — the shell CSS uses
 * `div.Properties > .propertyLabel` and `div.Properties > .property`
 * direct-child selectors, so any intermediate wrapper strips the section
 * frame. Use `<React.Fragment>` if
 * you need to render an array of label/property pairs from a `.map`.
 */
export const Properties = ({ className, children, ...rest }: PropertiesProps) => {
  const merged = className ? `${className} Properties` : "Properties";
  return (
    <div className={merged} {...rest}>
      {children}
    </div>
  );
};

type PropertyLabelProps = ComponentPropsWithoutRef<"div">;

/** A `.propertyLabel` direct child of `<Properties>`. Renders the section
 *  title above its sibling `<Property>` box. */
export const PropertyLabel = ({ className, children, ...rest }: PropertyLabelProps) => {
  const merged = className ? `propertyLabel ${className}` : "propertyLabel";
  return (
    <div className={merged} {...rest}>
      {children}
    </div>
  );
};

type PropertyProps = ComponentPropsWithoutRef<"div">;

/** A `.property` direct child of `<Properties>`. Renders the boxed section
 *  containing rows. Children should be `<Row>` (or any `.row`-classed div). */
export const Property = ({ className, children, ...rest }: PropertyProps) => {
  const merged = className ? `property ${className}` : "property";
  return (
    <div className={merged} {...rest}>
      {children}
    </div>
  );
};

type RowProps = ComponentPropsWithoutRef<"div">;

/** A `.row` inside `<Property>`. `className` is merged AFTER `row` so
 *  variant tokens like `"keyValue"` / `"button"` / `"formError"` compose
 *  naturally: `<Row className="keyValue">` → `<div class="row keyValue">`. */
export const Row = ({ className, children, ...rest }: RowProps) => {
  const merged = className ? `row ${className}` : "row";
  return (
    <div className={merged} {...rest}>
      {children}
    </div>
  );
};

type KeyValueProps = ComponentPropsWithoutRef<"div"> & { name: ReactNode };

/** The canonical labeled property row: a `.propertyName` key span followed by
 *  its value. `name` is the key; `children` is the value. Renders a
 *  `<Row className="keyValue">` so the key/value CSS
 *  (`div.Properties .row.keyValue span.propertyName` / `:last-child`) applies.
 *  Extra `className` composes after `keyValue`. */
export const KeyValue = ({ name, className, children, ...rest }: KeyValueProps) => {
  const merged = className ? `keyValue ${className}` : "keyValue";
  return (
    <Row className={merged} {...rest}>
      <span className="propertyName">{name}</span>
      {children}
    </Row>
  );
};

type ButtonRowProps = ComponentPropsWithoutRef<"button"> & {
  /** Merged onto the inner `<button>`, where the per-site CSS hooks
   *  (`connection`, `notification`, `unpairButton`, …) are selected from.
   *  Not `colored` — that token exists so `div.dragging` can flatten an
   *  element's own *background*, so it needs a background rule of its own to
   *  act on. Text colour is already forced for the whole dragging subtree. */
  buttonClassName?: string;
};

/** The canonical action row: a `<Row className="button">` wrapping one native
 *  `<button>`. `className` composes after the reserved `"button"` token on the
 *  row, like every other primitive here; the button's own hooks go through
 *  `buttonClassName`.
 *
 *  Rows whose child is a button *component* rather than a native `<button>`
 *  (`<DeleteButton>`, `<PlaidLinkButton>`, `<SimpleFinLinkButton>`) render
 *  their own `<button>`, so those keep the raw `<Row className="button">`.
 *
 *  The row box (padding, flex, `> button { width: 100% }`) travels with the
 *  primitive at any depth inside a `<Property>`, so rendering it below a
 *  sub-component's own wrapper — `<CapacitiesInput>` is the one today — is
 *  laid out the same as a direct child. */
export const ButtonRow = ({
  className,
  buttonClassName,
  children,
  ...rest
}: ButtonRowProps) => {
  const merged = className ? `button ${className}` : "button";
  return (
    <Row className={merged}>
      <button className={buttonClassName} {...rest}>
        {children}
      </button>
    </Row>
  );
};
