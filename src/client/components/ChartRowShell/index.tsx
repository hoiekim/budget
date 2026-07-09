import { KeyboardEvent, MouseEvent, MouseEventHandler, ReactNode, Dispatch, SetStateAction } from "react";
import { useReorder } from "client";
import { ChartRowTitle } from "client/components";

interface ChartLike {
  id: string;
  name: string;
}

interface Props {
  /** Per-row class name applied to the outer div — e.g.
   * `"BalanceChartRow"`. Consumers keep their existing CSS scoping. */
  className: string;
  chart: ChartLike;
  /** Renders `<ChartRowTitle>` with `chart.name` + the reorder touch
   * handles inside the shell. Defaults to `true`; a chart-detail page
   * that already renders its own title passes `false`. */
  showTitle?: boolean;
  onClick?: MouseEventHandler<HTMLDivElement>;
  /** Threaded into `useReorder` so drag-reorder writes back through the
   * caller's state setter. */
  onSetOrder?: Dispatch<SetStateAction<string[]>>;
  children: ReactNode;
}

/**
 * Outer wrapper shared across `<BalanceChartRow>`, `<ProjectionChartRow>`,
 * and `<FlowChartRow>` — same drag/reorder wiring, same
 * `chart.name`-titled header, same click affordance. Pulling this out
 * fixes an a11y inconsistency where only `<ProjectionChartRow>` carried
 * `role="button"` + `tabIndex={0}` + `onKeyDown`; now every clickable
 * chart row surfaces the same keyboard-and-screen-reader contract.
 */
export const ChartRowShell = ({
  className,
  chart,
  showTitle = true,
  onClick,
  onSetOrder,
  children,
}: Props) => {
  const {
    onDragStart,
    onDragEnd,
    onDragEnter,
    onGotPointerCapture,
    onTouchHandleStart,
    onTouchHandleEnd,
    onPointerEnter,
    isDragging,
  } = useReorder(chart.id, onSetOrder);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key === "Enter" || e.key === " ") && onClick) {
      e.preventDefault();
      onClick(e as unknown as MouseEvent<HTMLDivElement>);
    }
  };

  const classes = [className];
  if (isDragging) classes.push("dragging");

  return (
    <div
      className={classes.join(" ")}
      onClick={onClick}
      onKeyDown={onClick ? onKeyDown : undefined}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      // Gate `aria-label` on `onClick` too — a plain `<div>` with an
      // `aria-label` but no `role` isn't announced by most screen
      // readers, and pairing the label with the same predicate that
      // gates role/tabIndex reads cleanly.
      aria-label={onClick ? chart.name : undefined}
      draggable={true}
      onDragStart={onDragStart}
      onDragEnter={onDragEnter}
      onPointerEnter={onPointerEnter}
      onDragEnd={onDragEnd}
    >
      {showTitle && (
        <ChartRowTitle
          name={chart.name}
          onTouchHandleStart={onTouchHandleStart}
          onTouchHandleEnd={onTouchHandleEnd}
          onGotPointerCapture={onGotPointerCapture}
        />
      )}
      {children}
    </div>
  );
};
