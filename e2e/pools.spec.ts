import { test, expect } from "@playwright/test";

test.describe("Pools & Sidebar", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.getByText(/\d+\s+paper/i)).toBeVisible({ timeout: 15_000 });
  });

  test("should display sidebar with projects section", async ({ page }) => {
    await expect(page.getByText(/projects/i).first()).toBeVisible();
  });

  test("should display sidebar with tags section", async ({ page }) => {
    await expect(page.getByText(/tags/i).first()).toBeVisible();
  });

  test("should open keyword pool management", async ({ page }) => {
    // The Settings button is inside a justify-between row containing "Keyword Pool"
    // Structure: div.justify-between > [div > span("Keyword Pool"), button(gear)]
    const gearBtn = page
      .getByText("Keyword Pool")
      .locator("xpath=ancestor::div[contains(@class, 'justify-between')][1]")
      .locator("button");

    await expect(gearBtn).toBeVisible();
    await gearBtn.click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });
  });

  test("should open study type pool management", async ({ page }) => {
    // Same structure as keyword pool
    const gearBtn = page
      .getByText("Study Type Pool")
      .locator("xpath=ancestor::div[contains(@class, 'justify-between')][1]")
      .locator("button");

    await expect(gearBtn).toBeVisible();
    await gearBtn.click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });
  });

  test("should show create project dialog", async ({ page }) => {
    // Deterministic: "Manage projects" is a required sidebar control, so a
    // missing button must fail this test rather than silently skip its body.
    // The previous `[aria-label*="project" i]` guard matched nothing and the
    // assertions below had never actually executed.
    const manageProjects = page
      .getByRole("complementary")
      .getByRole("button", { name: "Manage projects", exact: true });

    await expect(manageProjects).toBeVisible();
    await manageProjects.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "New project name" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("should show create tag dialog", async ({ page }) => {
    // Same deterministic treatment as the projects case above.
    const manageTags = page
      .getByRole("complementary")
      .getByRole("button", { name: "Manage tags", exact: true });

    await expect(manageTags).toBeVisible();
    await manageTags.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByRole("textbox", { name: "New tag name" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("should show export options", async ({ page }) => {
    const exportBtn = page.getByRole("button", { name: /export/i });
    // The control itself is required, so assert it unconditionally; only the
    // menu exercise waits on the export prefetch that gates its enabled state.
    await expect(exportBtn).toBeVisible();
    if (await exportBtn.isEnabled()) {
      await exportBtn.click();
      // Use menuitem role to avoid matching "Risk Factors" tag text
      await expect(
        page.getByRole("menuitem", { name: /csv/i }),
      ).toBeVisible();
      await expect(
        page.getByRole("menuitem", { name: /ris/i }),
      ).toBeVisible();
    }
  });
});
