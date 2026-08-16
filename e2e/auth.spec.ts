import { test, expect, type Browser, type Locator, type Page } from "@playwright/test";

/** Helper: wait for dashboard to fully render after auth */
const waitForDashboard = async (page: import("@playwright/test").Page) => {
  await expect(page.getByText(/\d+\s+paper/i)).toBeVisible({ timeout: 15_000 });
};

/** Helper: open /auth in a signed-out context. */
const openAuthPage = async (browser: Browser) => {
  const context = await browser.newContext({ storageState: undefined });
  const page = await context.newPage();
  await page.goto("/auth", { waitUntil: "networkidle" });
  await expect(page.getByText("Manage your scientific paper collections")).toBeVisible({
    timeout: 10_000,
  });
  return { context, page };
};

/**
 * Helper: prove a field is programmatically associated with its own visible
 * validation error, resolving `aria-describedby` the way assistive technology
 * would rather than trusting the error's colour or position.
 */
const expectAssociatedError = async (
  page: Page,
  field: Locator,
  expectedErrorId: string,
  expectedMessage: string,
) => {
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toHaveAttribute("aria-describedby", expectedErrorId);

  const describedBy = await field.getAttribute("aria-describedby");
  const errorNode = page.locator(`#${describedBy}`);
  await expect(errorNode).toBeVisible();
  await expect(errorNode).toHaveAttribute("role", "alert");
  await expect(errorNode).toHaveText(expectedMessage);
};

const EMAIL_ERROR = "Please enter a valid email address";
const PASSWORD_ERROR = "Password must be at least 6 characters";
const FORGOT_EMAIL_ERROR = "Please enter your email address";

test.describe("Authentication", () => {
  test("should display auth page when not logged in", async ({ browser }) => {
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();

    await page.goto("/", { waitUntil: "networkidle" });
    // Should redirect to auth
    await expect(page).toHaveURL(/\/auth/, { timeout: 10_000 });
    await expect(page.getByText("Manage your scientific paper collections")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByPlaceholder("you@example.com")).toBeVisible();
    await expect(page.getByPlaceholder("••••••••")).toBeVisible();

    await context.close();
  });

  test("should not mark untouched sign in fields as invalid", async ({ browser }) => {
    const { context, page } = await openAuthPage(browser);

    const email = page.getByLabel("Email");
    const password = page.getByLabel("Password");

    await expect(email).toHaveAttribute("aria-invalid", "false");
    await expect(password).toHaveAttribute("aria-invalid", "false");

    // No stale description pointing at an error element that does not exist.
    await expect(email).not.toHaveAttribute("aria-describedby");
    await expect(password).not.toHaveAttribute("aria-describedby");
    await expect(page.getByRole("alert")).toHaveCount(0);

    await context.close();
  });

  test("should show validation errors for empty form", async ({ browser }) => {
    const { context, page } = await openAuthPage(browser);

    // Empty input fails client-side validation, so no auth request is made.
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page.getByText(/valid email/i)).toBeVisible({ timeout: 5_000 });

    await expectAssociatedError(page, page.getByLabel("Email"), "signin-email-error", EMAIL_ERROR);
    await expectAssociatedError(
      page,
      page.getByLabel("Password"),
      "signin-password-error",
      PASSWORD_ERROR,
    );

    await context.close();
  });

  test("should expose sign up validation errors with sign up associations", async ({ browser }) => {
    const { context, page } = await openAuthPage(browser);

    await page.getByRole("tab", { name: /sign up/i }).click();
    await page.getByRole("button", { name: /create account/i }).click();

    await expectAssociatedError(page, page.getByLabel("Email"), "signup-email-error", EMAIL_ERROR);
    await expectAssociatedError(
      page,
      page.getByLabel("Password"),
      "signup-password-error",
      PASSWORD_ERROR,
    );

    // The Sign Up controls must not borrow the Sign In error elements.
    await expect(page.locator("#signin-email-error")).toHaveCount(0);
    await expect(page.locator("#signin-password-error")).toHaveCount(0);

    await context.close();
  });

  test("should expose forgot password validation error", async ({ browser }) => {
    const { context, page } = await openAuthPage(browser);

    await page.getByRole("button", { name: /forgot password/i }).click();
    await expect(page.getByRole("button", { name: /send reset link/i })).toBeVisible();

    // Empty input short-circuits before resetPasswordForEmail is called.
    await page.getByRole("button", { name: /send reset link/i }).click();

    await expectAssociatedError(
      page,
      page.getByLabel("Email"),
      "forgot-email-error",
      FORGOT_EMAIL_ERROR,
    );

    await context.close();
  });

  test("should show sign up tab", async ({ browser }) => {
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();

    await page.goto("/auth", { waitUntil: "networkidle" });
    await expect(page.getByText("Manage your scientific paper collections")).toBeVisible({ timeout: 10_000 });
    await page.getByRole("tab", { name: /sign up/i }).click();

    await expect(
      page.getByRole("button", { name: /create account/i }),
    ).toBeVisible();

    await context.close();
  });

  test("should be signed in and on the dashboard", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForDashboard(page);
  });

  test("should show Add Papers button on dashboard", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: /add papers/i })).toBeVisible({
      timeout: 15_000,
    });
  });
});
