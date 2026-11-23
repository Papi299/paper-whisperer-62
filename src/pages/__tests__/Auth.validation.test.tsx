/**
 * Auth form validation through the rendered page (PAPERLUME-SECURITY-ZOD-4-MIGRATION-001).
 *
 * Zod 4 removed `ZodError.errors`, the alias `Auth.tsx` used to read field
 * errors. Under Zod 4 the old read throws inside the submit handler, so no
 * message renders, and that is how Dependabot's PR #352 failed two auth E2E
 * tests. These tests drive the real page with a mocked Supabase client and pin
 * what a user sees and what reaches Supabase Auth:
 *
 *  • each invalid input shows its exact message, tied to the right field;
 *  • invalid input never calls Supabase Auth, and nothing throws;
 *  • valid input reaches the same Supabase call with the same arguments;
 *  • forgot-password and sign-up validation are unchanged;
 *  • the validated `returnTo` redirect is unchanged, and a validation failure
 *    never navigates.
 *
 * No real authentication: every `supabase.auth` member is a mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import type { Session } from "@supabase/supabase-js";

type AuthCallback = (event: string, session: Session | null) => void;

const { auth, toastMock, authCallbacks } = vi.hoisted(() => {
  const authCallbacks: AuthCallback[] = [];
  return {
    authCallbacks,
    toastMock: vi.fn(),
    auth: {
      onAuthStateChange: vi.fn(),
      getSession: vi.fn(),
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
      resetPasswordForEmail: vi.fn(),
    },
  };
});

vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth } }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

import Auth from "@/pages/Auth";

const EMAIL_ERROR = "Please enter a valid email address";
const PASSWORD_ERROR = "Password must be at least 6 characters";
const FORGOT_EMPTY_ERROR = "Please enter your email address";

const SAFE_RETURN_TO = "/extension-import?kind=pmid&value=12345678";

/**
 * The inputs are `type="email"`, so the browser checks them first: a value
 * like `not-an-email` fails the form's own constraint validation and the
 * submit handler never runs (jsdom implements this, as browsers do). Zod's
 * message is what a user sees for an address the browser accepts but Zod does
 * not, such as one with no dot in the domain.
 */
const BROWSER_VALID_ZOD_INVALID_EMAIL = "user@localhost";

/** Shows where the router is, on the auth page and on any page it navigates to. */
function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function renderAuth(entry = "/auth") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/auth"
          element={
            <>
              <Auth />
              <LocationProbe />
            </>
          }
        />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

const currentLocation = () => screen.getByTestId("location").textContent;

function typeInto(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

function field(id: string): HTMLInputElement {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLInputElement)) throw new Error(`no input #${id}`);
  return el;
}

/** The field is marked invalid and described by exactly this error element. */
function expectFieldError(inputId: string, errorId: string, message: string) {
  const input = field(inputId);
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(input).toHaveAttribute("aria-describedby", errorId);
  const error = document.getElementById(errorId);
  expect(error).not.toBeNull();
  expect(error).toHaveAttribute("role", "alert");
  expect(error).toHaveTextContent(new RegExp(`^${message}$`));
}

function expectFieldValid(inputId: string) {
  const input = field(inputId);
  expect(input).toHaveAttribute("aria-invalid", "false");
  expect(input).not.toHaveAttribute("aria-describedby");
}

function openTab(name: RegExp) {
  const tab = screen.getByRole("tab", { name });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
}

function fakeSession(): Session {
  return { access_token: "test-access-token", user: { id: "user-1" } } as unknown as Session;
}

/** Let the submit handler's promise chain and any rejection surface. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const unhandled: unknown[] = [];
const recordUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(() => {
  vi.clearAllMocks();
  authCallbacks.length = 0;
  unhandled.length = 0;
  process.on("unhandledRejection", recordUnhandled);
  auth.onAuthStateChange.mockImplementation((callback: AuthCallback) => {
    authCallbacks.push(callback);
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
  auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
  auth.signInWithPassword.mockResolvedValue({ data: {}, error: null });
  auth.signUp.mockResolvedValue({ data: {}, error: null });
  auth.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
});

afterEach(() => {
  process.off("unhandledRejection", recordUnhandled);
  // G: a Zod validation failure must never escape as an exception.
  expect(unhandled).toEqual([]);
});

describe("Auth — sign-in validation", () => {
  it("A: rejects an invalid email with the email message only, and sends nothing", async () => {
    renderAuth();
    typeInto(field("signin-email"), BROWSER_VALID_ZOD_INVALID_EMAIL);
    typeInto(field("signin-password"), "secret123");
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
    await settle();

    expectFieldError("signin-email", "signin-email-error", EMAIL_ERROR);
    expectFieldValid("signin-password");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("B: rejects a too-short password with the password message only, and sends nothing", async () => {
    renderAuth();
    typeInto(field("signin-email"), "user@example.com");
    typeInto(field("signin-password"), "12345");
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
    await settle();

    expectFieldError("signin-password", "signin-password-error", PASSWORD_ERROR);
    expectFieldValid("signin-email");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("C/D: an empty form shows both exact messages, each on its own field", async () => {
    renderAuth();
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
    await settle();

    expectFieldError("signin-email", "signin-email-error", EMAIL_ERROR);
    expectFieldError("signin-password", "signin-password-error", PASSWORD_ERROR);
    expect(screen.getAllByRole("alert").map((el) => el.textContent)).toEqual([
      EMAIL_ERROR,
      PASSWORD_ERROR,
    ]);
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("an email the browser itself rejects never reaches validation or Supabase", async () => {
    renderAuth();
    typeInto(field("signin-email"), "not-an-email");
    typeInto(field("signin-password"), "secret123");
    expect(field("signin-email").validity.typeMismatch).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
    await settle();

    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("accepts a password of exactly six characters (the boundary)", async () => {
    renderAuth();
    typeInto(field("signin-email"), "user@example.com");
    typeInto(field("signin-password"), "123456");
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
    await settle();

    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    expect(auth.signInWithPassword).toHaveBeenCalledTimes(1);
  });

  it("E: valid input clears earlier errors and reaches signInWithPassword unchanged", async () => {
    renderAuth();
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
    await settle();
    expect(screen.getAllByRole("alert")).toHaveLength(2);

    typeInto(field("signin-email"), "user@example.com");
    typeInto(field("signin-password"), "secret123");
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
    await settle();

    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    expectFieldValid("signin-email");
    expectFieldValid("signin-password");
    expect(auth.signInWithPassword).toHaveBeenCalledTimes(1);
    expect(auth.signInWithPassword).toHaveBeenCalledWith({
      email: "user@example.com",
      password: "secret123",
    });
    // A successful call with no session event yet does not navigate.
    expect(currentLocation()).toBe("/auth");
  });

  it("F/G: repeated invalid submits never call Supabase Auth or throw", async () => {
    renderAuth();
    for (const [email, password] of [
      ["", ""],
      [BROWSER_VALID_ZOD_INVALID_EMAIL, "secret123"],
      ["user@example.com", "short"],
      ["a@b", "x"],
    ]) {
      typeInto(field("signin-email"), email);
      typeInto(field("signin-password"), password);
      fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
      await settle();
      // Each submit re-validates: the alerts shown are the ones for this input.
      const shown = screen.getAllByRole("alert").map((el) => el.textContent);
      expect(shown).toEqual([
        ...(email === "user@example.com" ? [] : [EMAIL_ERROR]),
        ...(password.length >= 6 ? [] : [PASSWORD_ERROR]),
      ]);
    }
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(auth.signUp).not.toHaveBeenCalled();
    expect(auth.resetPasswordForEmail).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
    expect(currentLocation()).toBe("/auth");
  });
});

describe("Auth — forgot-password validation (H)", () => {
  function openForgot() {
    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    expect(screen.getByRole("button", { name: "Send Reset Link" })).toBeInTheDocument();
  }

  it("requires an email, then a valid one, before sending a reset link", async () => {
    renderAuth();
    openForgot();

    fireEvent.click(screen.getByRole("button", { name: "Send Reset Link" }));
    await settle();
    expectFieldError("forgot-email", "forgot-email-error", FORGOT_EMPTY_ERROR);

    typeInto(field("forgot-email"), BROWSER_VALID_ZOD_INVALID_EMAIL);
    fireEvent.click(screen.getByRole("button", { name: "Send Reset Link" }));
    await settle();
    expectFieldError("forgot-email", "forgot-email-error", EMAIL_ERROR);

    expect(auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("sends the reset link for a valid email with the unchanged redirect", async () => {
    renderAuth();
    openForgot();
    typeInto(field("forgot-email"), "user@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Send Reset Link" }));
    await settle();

    expect(auth.resetPasswordForEmail).toHaveBeenCalledTimes(1);
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith("user@example.com", {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Check your email" }));
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });
});

describe("Auth — sign-up validation (I)", () => {
  it("shows both exact messages on the sign-up fields and sends nothing", async () => {
    renderAuth();
    openTab(/sign up/i);
    typeInto(field("signup-email"), BROWSER_VALID_ZOD_INVALID_EMAIL);
    typeInto(field("signup-password"), "123");
    fireEvent.click(screen.getByRole("button", { name: "Create Account" }));
    await settle();

    expectFieldError("signup-email", "signup-email-error", EMAIL_ERROR);
    expectFieldError("signup-password", "signup-password-error", PASSWORD_ERROR);
    expect(document.getElementById("signin-email-error")).toBeNull();
    expect(document.getElementById("signin-password-error")).toBeNull();
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it("valid input reaches signUp with the unchanged confirmation redirect", async () => {
    renderAuth();
    openTab(/sign up/i);
    typeInto(field("signup-email"), "new.user@example.com");
    typeInto(field("signup-password"), "secret123");
    fireEvent.click(screen.getByRole("button", { name: "Create Account" }));
    await settle();

    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    expect(auth.signUp).toHaveBeenCalledTimes(1);
    expect(auth.signUp).toHaveBeenCalledWith({
      email: "new.user@example.com",
      password: "secret123",
      options: { emailRedirectTo: `${window.location.origin}/` },
    });
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Check your email" }));
  });
});

describe("Auth — safe returnTo handling (J)", () => {
  it("an existing session goes to the validated extension-import path", async () => {
    auth.getSession.mockResolvedValue({ data: { session: fakeSession() }, error: null });
    renderAuth(`/auth?returnTo=${encodeURIComponent(SAFE_RETURN_TO)}`);
    await waitFor(() => expect(currentLocation()).toBe(SAFE_RETURN_TO));
  });

  it.each([
    ["an absolute URL", "https://evil.example/steal"],
    ["a protocol-relative URL", "//evil.example/steal"],
    ["a backslash protocol-relative URL", "/\\evil.example/steal"],
    ["a path outside the allowlist", "/settings"],
  ])("an existing session falls back to / for %s", async (_label, returnTo) => {
    auth.getSession.mockResolvedValue({ data: { session: fakeSession() }, error: null });
    renderAuth(`/auth?returnTo=${encodeURIComponent(returnTo)}`);
    await waitFor(() => expect(currentLocation()).toBe("/"));
  });

  it("a validation failure stays on /auth; a later sign-in event follows the safe path", async () => {
    renderAuth(`/auth?returnTo=${encodeURIComponent(SAFE_RETURN_TO)}`);
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
    await settle();

    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(currentLocation()).toBe(`/auth?returnTo=${encodeURIComponent(SAFE_RETURN_TO)}`);

    typeInto(field("signin-email"), "user@example.com");
    typeInto(field("signin-password"), "secret123");
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
    await settle();
    expect(auth.signInWithPassword).toHaveBeenCalledTimes(1);

    expect(authCallbacks).toHaveLength(1);
    act(() => authCallbacks[0]("SIGNED_IN", fakeSession()));
    await waitFor(() => expect(currentLocation()).toBe(SAFE_RETURN_TO));
  });
});
