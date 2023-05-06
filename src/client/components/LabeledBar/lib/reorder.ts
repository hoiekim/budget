import { getIndex } from "common";
import {
  Dispatch,
  DragEventHandler,
  PointerEventHandler,
  TouchEventHandler,
  SetStateAction,
  useState,
} from "react";

interface ReorderHelper {
  onDragStart: DragEventHandler;
  onDragEnter: DragEventHandler;
  onDragEnd: DragEventHandler;
  onGotPointerCapture: PointerEventHandler;
  onPointerEnter: PointerEventHandler;
  onTouchHandleStart: TouchEventHandler;
  onTouchHandleEnd: TouchEventHandler;
  isDragging: boolean;
  /**
   * This variable can be used to prevent unexpected click event firing after
   * reordering is performed. Such cases were found during testing and it's
   * potentially a browser bug.
   */
  isClickAllowed: boolean;
}

let dragStartItem: string | undefined;
let reorderThrottliing = false;
let touching = false;
let isClickAllowed = true;

export const useReorder = (
  dataId: string,
  onSetOrder?: Dispatch<SetStateAction<string[]>>
): ReorderHelper => {
  const [isDragging, setIsDragging] = useState(false);

  const startDragging = () => {
    if (!onSetOrder) return;
    dragStartItem = dataId;
    setIsDragging(true);
  };

  const finishDragging = () => {
    if (!onSetOrder) return;
    dragStartItem = undefined;
    setIsDragging(false);
  };

  const reorderItems = () => {
    if (!onSetOrder || !dragStartItem || dragStartItem === dataId || reorderThrottliing)
      return;

    // Throttling is implemented because redordering differently sized elements can
    // cause another "mouseenter" or "pointerenter" event, resulting in elements
    // infinitely getting reordered in some use cases.
    reorderThrottliing = true;
    setTimeout(() => {
      reorderThrottliing = false;
    }, 100);

    if (touching) isClickAllowed = false;

    onSetOrder((oldOrder) => {
      const newOrder = [...oldOrder];
      const startIndex = getIndex(dragStartItem, newOrder);
      const targetIndex = getIndex(dataId, newOrder);
      if (!dragStartItem || startIndex === targetIndex) return newOrder;
      if (startIndex !== undefined && targetIndex !== undefined) {
        newOrder.splice(startIndex, 1);
        newOrder.splice(targetIndex, 0, dragStartItem);
      }
      return newOrder;
    });
  };

  const onDragStart: DragEventHandler = (e) => {
    e.dataTransfer.effectAllowed = "move";
    startDragging();
  };

  const onDragEnter: DragEventHandler = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    reorderItems();
  };

  const onTouchHandleStart: TouchEventHandler = () => {
    touching = true;
    startDragging();
  };
  const onTouchHandleEnd: TouchEventHandler = () => {
    touching = false;
    setTimeout(() => {
      isClickAllowed = true;
    }, 500);
    finishDragging();
  };

  const onGotPointerCapture: PointerEventHandler = (e) => {
    // This is needed to detect "pointerenter" event with touch input. By default,
    // browsers "capture" the pointer at the first touch so sliding the finger into
    // another element is not detected as an event.
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  };

  return {
    isClickAllowed,
    isDragging,
    onDragStart,
    onDragEnd: finishDragging,
    onDragEnter,
    onTouchHandleStart,
    onTouchHandleEnd,
    onGotPointerCapture,
    onPointerEnter: reorderItems,
  };
};
