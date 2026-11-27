// Themed collections for travellers and search engines. Each is a rule over offers, so it fills itself as makers join.
export const THEMES = {
  crafts: { art: "pottery", categories: ["pottery", "ikat", "embroidery", "carpet", "wood", "metal"] },
  food: { art: "cooking", categories: ["cooking", "bread"] },
  village: { art: "village", categories: ["village"] },
  valley: { art: "ikat", regions: ["fargona", "andijon", "namangan"] },
  short: { art: "bread", maxMinutes: 120 },
};
/** Whether an offer belongs to a theme. */
export const inTheme = (theme, l) => Boolean(theme) && (!theme.categories || theme.categories.includes(l.category)) && (!theme.regions || theme.regions.includes(l.region)) && (!theme.maxMinutes || l.duration_min <= theme.maxMinutes);
