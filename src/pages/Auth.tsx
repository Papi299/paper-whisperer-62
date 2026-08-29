import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { BookOpen, Loader2 } from "lucide-react";
import { z } from "zod";
import { DEFAULT_POST_AUTH_PATH, parseSafeReturnTo } from "@/lib/safeReturnTo";

const authSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

const Auth = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [forgotMode, setForgotMode] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();

  /**
   * Where a successful sign-in goes.
   *
   * `returnTo` is attacker-reachable — anyone can send `/auth?returnTo=…` — so
   * it is validated against a narrow allowlist and the destination is REBUILT
   * from the validated parts rather than echoed back. An absent or rejected
   * value falls through to the pre-existing `/` behaviour, so ordinary sign-in
   * is unchanged. See `src/lib/safeReturnTo.ts`.
   */
  const postAuthPath = useMemo(
    () =>
      parseSafeReturnTo(new URLSearchParams(location.search).get("returnTo")) ??
      DEFAULT_POST_AUTH_PATH,
    [location.search],
  );

  // Held in a ref so the redirect effect does not re-subscribe to auth state
  // when the query string is re-parsed; the value it needs is always current.
  const postAuthPathRef = useRef(postAuthPath);
  postAuthPathRef.current = postAuthPath;

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (session) {
          navigate(postAuthPathRef.current, { replace: true });
        }
      }
    );

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        navigate(postAuthPathRef.current, { replace: true });
      }
    });

    return () => subscription.unsubscribe();
  }, [navigate]);

  const validateForm = () => {
    const result = authSchema.safeParse({ email, password });
    if (!result.success) {
      const fieldErrors: { email?: string; password?: string } = {};
      result.error.errors.forEach((err) => {
        if (err.path[0] === "email") fieldErrors.email = err.message;
        if (err.path[0] === "password") fieldErrors.password = err.message;
      });
      setErrors(fieldErrors);
      return false;
    }
    setErrors({});
    return true;
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateForm()) return;

    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (error) {
      toast({
        title: "Sign in failed",
        description: error.message === "Invalid login credentials" 
          ? "Invalid email or password. Please try again." 
          : error.message,
        variant: "destructive",
      });
    }
    setLoading(false);
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateForm()) return;

    setLoading(true);
    // Sign-up confirmation deliberately still returns to `/`. Carrying the
    // handoff through an emailed confirmation link would mean adding the
    // parameterised URL to the Supabase Auth redirect allow-list, which is a
    // dashboard configuration change outside this phase. A new user therefore
    // lands on their library and can import from there; an existing user — the
    // case the handoff is actually for — signs in and returns to the intent.
    const redirectUrl = `${window.location.origin}/`;

    const { error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        emailRedirectTo: redirectUrl,
      },
    });

    if (error) {
      if (error.message.includes("already registered")) {
        toast({
          title: "Account exists",
          description: "This email is already registered. Please sign in instead.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Sign up failed",
          description: error.message,
          variant: "destructive",
        });
      }
    } else {
      toast({
        title: "Check your email",
        description: "We've sent you a confirmation link to verify your email address.",
      });
    }
    setLoading(false);
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setErrors({ email: "Please enter your email address" });
      return;
    }
    const emailResult = z.string().email().safeParse(trimmedEmail);
    if (!emailResult.success) {
      setErrors({ email: "Please enter a valid email address" });
      return;
    }
    setErrors({});
    setLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(trimmedEmail, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setLoading(false);
    if (error) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    } else {
      toast({
        title: "Check your email",
        description: "If an account exists with this email, you'll receive a password reset link.",
      });
      setForgotMode(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="flex w-full max-w-md flex-col items-center">
        <Card className="w-full">
          <CardHeader className="space-y-1 text-center">
            <div className="flex justify-center mb-4">
              <div className="rounded-full bg-primary/10 p-3">
                <BookOpen className="h-8 w-8 text-primary" />
              </div>
            </div>
            <CardTitle className="text-2xl font-bold">PaperLume</CardTitle>
            <CardDescription>
              Manage your scientific paper collections
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="signin" className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="signin">Sign In</TabsTrigger>
                <TabsTrigger value="signup">Sign Up</TabsTrigger>
              </TabsList>
              <TabsContent value="signin">
                {forgotMode ? (
                  <form onSubmit={handleForgotPassword} className="space-y-4">
                    <p className="text-sm text-muted-foreground">
                      Enter your email address and we'll send you a link to reset your password.
                    </p>
                    <div className="space-y-2">
                      <Label htmlFor="forgot-email">Email</Label>
                      <Input
                        id="forgot-email"
                        type="email"
                        placeholder="you@example.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        disabled={loading}
                        aria-invalid={!!errors.email}
                        aria-describedby={errors.email ? "forgot-email-error" : undefined}
                      />
                      {errors.email && (
                        <p id="forgot-email-error" role="alert" className="text-sm text-destructive">{errors.email}</p>
                      )}
                    </div>
                    <Button type="submit" className="w-full" disabled={loading}>
                      {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Send Reset Link
                    </Button>
                    <div className="text-center">
                      <button
                        type="button"
                        onClick={() => { setForgotMode(false); setErrors({}); }}
                        className="text-sm text-muted-foreground hover:text-primary underline"
                      >
                        Back to Sign In
                      </button>
                    </div>
                  </form>
                ) : (
                  <form onSubmit={handleSignIn} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="signin-email">Email</Label>
                      <Input
                        id="signin-email"
                        type="email"
                        placeholder="you@example.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        disabled={loading}
                        aria-invalid={!!errors.email}
                        aria-describedby={errors.email ? "signin-email-error" : undefined}
                      />
                      {errors.email && (
                        <p id="signin-email-error" role="alert" className="text-sm text-destructive">{errors.email}</p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="signin-password">Password</Label>
                      <Input
                        id="signin-password"
                        type="password"
                        placeholder="••••••••"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        disabled={loading}
                        aria-invalid={!!errors.password}
                        aria-describedby={errors.password ? "signin-password-error" : undefined}
                      />
                      {errors.password && (
                        <p id="signin-password-error" role="alert" className="text-sm text-destructive">{errors.password}</p>
                      )}
                    </div>
                    <Button type="submit" className="w-full" disabled={loading}>
                      {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Sign In
                    </Button>
                    <div className="text-center">
                      <button
                        type="button"
                        onClick={() => { setForgotMode(true); setErrors({}); }}
                        className="text-sm text-muted-foreground hover:text-primary underline"
                      >
                        Forgot password?
                      </button>
                    </div>
                  </form>
                )}
              </TabsContent>
              <TabsContent value="signup">
                <form onSubmit={handleSignUp} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="signup-email">Email</Label>
                    <Input
                      id="signup-email"
                      type="email"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      disabled={loading}
                      aria-invalid={!!errors.email}
                      aria-describedby={errors.email ? "signup-email-error" : undefined}
                    />
                    {errors.email && (
                      <p id="signup-email-error" role="alert" className="text-sm text-destructive">{errors.email}</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="signup-password">Password</Label>
                    <Input
                      id="signup-password"
                      type="password"
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={loading}
                      aria-invalid={!!errors.password}
                      aria-describedby={errors.password ? "signup-password-error" : undefined}
                    />
                    {errors.password && (
                      <p id="signup-password-error" role="alert" className="text-sm text-destructive">{errors.password}</p>
                    )}
                  </div>
                  <Button type="submit" className="w-full" disabled={loading}>
                    {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Create Account
                  </Button>
                </form>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
        {/* Legal footer. The Privacy Policy is public, so this is the surface a
            signed-out visitor — or a Chrome Web Store reviewer following the
            listing's privacy URL — can reach it from. */}
        <footer className="mt-6">
          <Link
            to="/privacy"
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-primary"
          >
            Privacy Policy
          </Link>
        </footer>
      </div>
    </div>
  );
};

export default Auth;
