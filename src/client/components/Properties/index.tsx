import { ComponentPropsWithoutRef } from "react";
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
 * frame (PR #472 regression caught 2026-06-04). Use `<React.Fragment>` if
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
