import { ComponentPropsWithoutRef } from "react";

import "./index.css";

interface Props extends ComponentPropsWithoutRef<"div"> {}

/**
 * Standard page shell. Owns the design convention every page-level container
 * shares — currently the `padding: 0 10px` applied to its direct-child
 * sections (see index.css). Use it as the outermost element of a page so the
 * convention is inherited automatically instead of re-declared per page:
 *
 *   <Page className="MyPage">…</Page>
 *
 * The page-specific className is preserved alongside "Page", so existing
 * page-scoped CSS (`div.MyPage .foo`) keeps working unchanged.
 */
export const Page = ({ className, children, ...rest }: Props) => {
  const mergedClassName = className ? `Page ${className}` : "Page";
  return (
    <div className={mergedClassName} {...rest}>
      {children}
    </div>
  );
};
