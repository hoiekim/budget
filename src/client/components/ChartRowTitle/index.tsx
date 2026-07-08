import { PointerEventHandler, ReactNode, TouchEventHandler } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "client/components";
import "./index.css";

interface Props {
  name: ReactNode;
  onTouchHandleStart: TouchEventHandler<HTMLButtonElement>;
  onTouchHandleEnd: TouchEventHandler<HTMLButtonElement>;
  onGotPointerCapture: PointerEventHandler<HTMLButtonElement>;
}

export const ChartRowTitle = ({
  name,
  onTouchHandleStart,
  onTouchHandleEnd,
  onGotPointerCapture,
}: Props) => (
  <h3 className="chartRowTitle">
    <span>{name}</span>
    <button
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onTouchStart={onTouchHandleStart}
      onTouchEnd={onTouchHandleEnd}
      onGotPointerCapture={onGotPointerCapture}
      style={{ touchAction: "none" }}
    >
      <div className="reorderIcon">
        <ChevronUpIcon size={8} />
        <ChevronDownIcon size={8} />
      </div>
    </button>
  </h3>
);
