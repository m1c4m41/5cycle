/**
 * What counts in the Checklist. Every catalog class in the plan counts, and so
 * does hand-entered credit (transfer, AP, summer…). The one exception is a 📌
 * pinned "want to take" class (kind "planned": no section yet): it is shown only
 * in the planner's What if. Adding a real catalog class for it replaces the pin,
 * and from then on the class counts in the Checklist.
 */
export const isPinnedPlan = (kind: string): boolean => kind === "planned";
