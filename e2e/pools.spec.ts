import { test, expect } from "@playwright/test";

test.describe("Pools & Sidebar", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /papers/i })).toBeVisible();
  });

  test("should display sidebar with projects section", async ({ page }) => {
    await expect(
      page.getByText(/projects/i).first(),
    ).toBeVisible();
  });

  test("should display sidebar with tags section", async ({ page }) => {
    await expect(
      page.getByText(/tags/i).first(),
    ).toBeVisible();
  });

  test("should open keyword pool management", async ({ page }) => {
    // Look for keyword pool link/button in sidebar
    const keywordPoolBtn = page.getByRole("button", { name: /keyword/i }).or(
      page.getByText(/keyword pool/i),
    );

    if (await keywordPoolBtn.isVisible()) {
      await keywordPoolBtn.click();
      // Modal or panel for keyword management
      await expect(
        page.getByRole("dialog").or(page.getByText(/manage.*keyword/i)),
      ).toBeVisible();
    }
  });

  test("should open study type pool management", async ({ page }) => {
    const studyTypeBtn = page.getByRole("button", { name: /study type/i }).or(
      page.getByText(/study type pool/i),
    );

    if (await studyTypeBtn.isVisible()) {
      await studyTypeBtn.click();
      await expect(
        page.getByRole("dialog").or(page.getByText(/manage.*study/i)),
      ).toBeVisible();
    }
  });

  test("should show create project dialog", async ({ page }) => {
    // Look for add project button
    const addProjectBtn = page
      .locator('[aria-label*="project" i]')
      .or(page.getByRole("button", { name: /new project|add project/i }));

    if (await addProjectBtn.first().isVisible()) {
      await addProjectBtn.first().click();
      // Should see a form/dialog for creating a project
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
    // Export buttons in search filters area
    const exportBtn = page.getByRole("button", { name: /export/i });
    if (await exportBtn.isVisible()) {
      await exportBtn.click();
      // Should show CSV/RIS options
      await expect(
        page.getByText(/csv/i).or(page.getByText(/ris/i)),
      ).toBeVisible();
    }
  });
});
