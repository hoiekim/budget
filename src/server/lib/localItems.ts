import path from "path";
import fs from "fs";
import { Item } from "server";

const localItemsPath = path.resolve(__dirname, "../../../.items");

export const getLocalItems = () => {
  if (fs.existsSync(localItemsPath)) {
    try {
      const localItemsBuffer = fs.readFileSync(localItemsPath);
      const items = JSON.parse(localItemsBuffer.toString());
      console.error("Successfully loaded Plaid items from local disk.");
      return items as Item[];
    } catch (error) {
      console.error("Failed to load local Plaid items.");
    }
  }
  return [];
};

export const saveLocalItems = (items: Item[]) => {
  try {
    const data = JSON.stringify(items);
    fs.writeFileSync(localItemsPath, data);
    console.error("Successfully saved Plaid items to local disk.");
  } catch (error) {
    console.error("Failed to save local Plaid items.");
  }
};
