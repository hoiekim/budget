/**
 * Adjusts the brightness of a given hex color string.
 * @example console.log(adjustBrightness("#FF5733", 20));  // Lighten the color by 20%
 * @example console.log(adjustBrightness("#FF5733", -20)); // Darken the color by 20%
 */
export const adjustBrightness = (hexColor: string, brightness: number) => {
  let color = hexColor.startsWith("#") ? hexColor.slice(1) : hexColor;

  const r = parseInt(color.substring(0, 2), 16);
  const g = parseInt(color.substring(2, 4), 16);
  const b = parseInt(color.substring(4, 6), 16);

  const adjust = (component: number) => {
    const newComponent = Math.round(component * brightness);
    return Math.min(255, Math.max(0, newComponent));
  };

  const newColor = [adjust(r), adjust(g), adjust(b)]
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("");

  return "#" + newColor;
};
