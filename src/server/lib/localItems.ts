import path from "path";
import fs from "fs";
import { Item } from "common";

const localItemsPath = path.resolve(__dirname, "../../../.items");

export const getLocalItems = () => {
  if (fs.existsSync(localItemsPath)) {
    try {
      const localItemsBuffer = fs.readFileSync(localItemsPath);
      const items = JSON.parse(localItemsBuffer.toString());
      return items as Item[];
    } catch (error) {
      console.error("Failed to load local Plaid items.");
    }
  }
  return [];
};

export const saveLocalItems = (items: Item[]) => {
  try {
    const data = JSON.stringify(items.map((e) => ({ ...e, cursor: undefined })));
    fs.writeFileSync(localItemsPath, data);
  } catch (error) {
    console.error("Failed to save local Plaid items.");
  }
};

export const pushLocalItem = (item: Item) => {
  const items = getLocalItems();
  items.push(item);
  saveLocalItems(items);
};

export const removeLocalItem = (item_id: string) => {
  const items = getLocalItems();
  items.find((e, i) => {
    if (e.item_id === item_id) {
      items.splice(i, 1);
      return true;
    }
    return false;
  });
  saveLocalItems(items);
};
