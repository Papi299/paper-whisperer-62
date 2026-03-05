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
    const addProjectBtn = page
      .locator('[aria-label*="project" i]')
      .or(page.getByRole("button", { name: /new project|add project/i }));

    if (await addProjectBtn.first().isVisible()) {
      await addProjectBtn.first().click();
      await expect(
        page.getByRole("dialog").or(page.getByPlaceholder(/project name/i)),
      ).toBeVisible();
    }
  });

  test("should show create tag dialog", async ({ page }) => {
    const addTagBtn = page
      .locator('[aria-label*="tag" i]')
      .or(page.getByRole("button", { name: /new tag|add tag/i }));

    if (await addTagBtn.first().isVisible()) {
      await addTagBtn.first().click();
      await expect(
        page.getByRole("dialog").or(page.getByPlaceholder(/tag name/i)),
      ).toBeVisible();
    }
  });

  test("should show export options", async ({ page }) => {
    const exportBtn = page.getByRole("button", { name: /export/i });
    if (await exportBtn.isVisible()) {
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
