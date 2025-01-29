import { ReactNode } from "react";
import { useAppContext, call, useSync, useLocalStorage } from "client";
import { Item, ItemStatus } from "common";

interface Props {
  item?: Item;
  children?: ReactNode;
}

const tokens = new Map<string, string>();
const promisedTokens = new Map<string, Promise<string>>();

const SimpleFinLinkButton = ({ item, children }: Props) => {
  const { user, data } = useAppContext();

  const onClick = () => {};

  return (
    <button disabled onClick={onClick}>
      {children}
    </button>
  );
};

export default SimpleFinLinkButton;
