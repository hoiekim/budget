import { clamp } from "common";

/**
 * Adjusts the brightness of a given hex color string.
 * @example console.log(adjustBrightness("#FF5733", 1.2)); // Lighten the color by 20%
 * @example console.log(adjustBrightness("#FF5733", 0.8)); // Darken the color by 20%
 */
export const adjustBrightness = (hexColor: string, brightness: number) => {
  let color = hexColor.startsWith("#") ? hexColor.slice(1) : hexColor;

  const r = parseInt(color.substring(0, 2), 16);
  const g = parseInt(color.substring(2, 4), 16);
  const b = parseInt(color.substring(4, 6), 16);

  const adjust = (component: number) => {
    const newComponent = Math.round(component * brightness);
    return clamp(newComponent, 0, 255);
  };

  const newColor = [adjust(r), adjust(g), adjust(b)]
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("");

  return "#" + newColor;
};

export const TRANSPARENT = "#fff0";

export const colors = [
  "#22AB6C",
  "#784E30",
  "#5D9B7E",
  "#786130",
  "#43505D",
  "#2E8089",
  "#AB7E22",
  "#AB5C22",
  "#DE9600",
  "#00DE78",
];
