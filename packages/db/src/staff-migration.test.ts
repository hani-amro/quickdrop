import { describe, expect, it } from "vitest";
import { mapWaflowRole } from "./staff-migration.js";

// §23/R-09 — خريطة أدوار WaFlow → QuickDrop: نقية، الأضيق أماناً عند الشك.
describe("mapWaflowRole", () => {
  it("owner→owner, admin→dispatcher, agent→support", () => {
    expect(mapWaflowRole("owner")).toBe("owner");
    expect(mapWaflowRole("admin")).toBe("dispatcher");
    expect(mapWaflowRole("agent")).toBe("support");
  });
  it("مجهول → support (أقل صلاحية — لا owner/accountant بالخطأ)", () => {
    expect(mapWaflowRole("superuser")).toBe("support");
    expect(mapWaflowRole("")).toBe("support");
  });
});
