import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import {
  accountDeletionMessage,
  DELETE_ACCOUNT_FUNCTION,
  readDeletionErrorCode,
  redirectToAuthPage,
} from "@/lib/accountDeletion";

/**
 * Orchestration + UI state for PFA-C04 self-service account deletion.
 *
 * The hook owns invocation, failure normalization, duplicate-click prevention
 * and post-success local cleanup. It owns **no** authorization: the destructive
 * decision belongs entirely to the `delete-account` Edge Function, which
 * re-validates the confirmation phrase and derives the deleted user from the
 * authenticated bearer token.
 *
 * Deliberately absent from the request body: any user id. `userId` is accepted
 * only so the UI can stay disabled during an auth transition — it is never
 * sent, so a tampered client cannot aim the deletion at another account.
 *
 * Success path, in order:
 *   1. clear this browser's Supabase session (local scope — the account is
 *      already gone server-side, so a global sign-out would only fail);
 *   2. drop every cached query so no deleted-account row survives in memory;
 *   3. hard-navigate to /auth, discarding the whole JavaScript context.
 *
 * Failure path: the session is left untouched (the account still exists) and
 * only a bounded, user-safe message is shown.
 */

export interface AccountDeletionState {
  /** Invoke the deletion. Resolves whether it succeeded or failed. */
  deleteAccount: (confirmation: string) => Promise<void>;
  isDeleting: boolean;
  /** False during an auth transition; the destructive action stays disabled. */
  canDelete: boolean;
}

export function useAccountDeletion(userId: string | null | undefined): AccountDeletionState {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isDeleting, setIsDeleting] = useState(false);
  // A ref, not the state flag: two clicks in the same tick would both read the
  // pre-update state value and both invoke the function.
  const runningRef = useRef(false);

  const deleteAccount = useCallback(
    async (confirmation: string) => {
      if (!userId || runningRef.current) return;

      runningRef.current = true;
      setIsDeleting(true);

      try {
        // Body carries the confirmation phrase and nothing else. No user id.
        const { error } = await supabase.functions.invoke(DELETE_ACCOUNT_FUNCTION, {
          body: { confirmation },
        });

        if (error) {
          const code = await readDeletionErrorCode(error);
          toast({
            title: "Account not deleted",
            description: accountDeletionMessage(code),
            variant: "destructive",
          });
          return;
        }

        // Server-side deletion succeeded. Everything below is local cleanup.
        await supabase.auth.signOut({ scope: "local" });
        queryClient.clear();
        redirectToAuthPage();
      } catch {
        // Network/transport failure: the account may well still exist, so the
        // session is deliberately NOT cleared and no raw detail is surfaced.
        toast({
          title: "Account not deleted",
          description: accountDeletionMessage(null),
          variant: "destructive",
        });
      } finally {
        runningRef.current = false;
        setIsDeleting(false);
      }
    },
    [userId, queryClient, toast],
  );

  return { deleteAccount, isDeleting, canDelete: !!userId };
}
