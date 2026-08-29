import { useCallback, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { Project, Tag } from "@/types/database";
import {
  FolderOpen,
  Tag as TagIcon,
  RefreshCw,
  Ban,
  Settings,
  Sparkles,
  FileText,
  BookOpen,
  LogOut,
  User,
  UserCog,
  ShieldCheck,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ManageSynonymsModal } from "@/components/synonyms/ManageSynonymsModal";
import { ManageExclusionsModal } from "@/components/exclusions/ManageExclusionsModal";
import { ManageKeywordPoolModal } from "@/components/keywords/ManageKeywordPoolModal";
import { ManageStudyTypePoolModal } from "@/components/study-types/ManageStudyTypePoolModal";
import { ManageProjectsModal } from "@/components/projects/ManageProjectsModal";
import { ManageTagsModal } from "@/components/tags/ManageTagsModal";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { AccountDialog } from "@/components/account/AccountDialog";
import { usePools } from "@/contexts/PoolsContext";

/**
 * The taxonomy rows are keyed so the desktop rail and the narrow-screen drawer
 * render from ONE list rather than two hand-maintained copies of the same six
 * rows. `manageLabel` is the button's accessible name — six buttons that all
 * announced "Settings" is exactly the defect PFA-C09 set out to fix, so each
 * entry names its own destination.
 */
type ManageKey =
  | "projects"
  | "tags"
  | "keywords"
  | "studyTypes"
  | "synonyms"
  | "exclusions";

const NAV_ITEMS: {
  key: ManageKey;
  label: string;
  manageLabel: string;
  Icon: typeof FolderOpen;
  iconClassName: string;
  /** Whether the count badge renders when the count is 0. */
  alwaysShowCount?: boolean;
}[] = [
  { key: "projects", label: "Projects", manageLabel: "Manage projects", Icon: FolderOpen, iconClassName: "text-indigo-500" },
  { key: "tags", label: "Tags", manageLabel: "Manage tags", Icon: TagIcon, iconClassName: "text-violet-500" },
  { key: "keywords", label: "Keyword Pool", manageLabel: "Manage keyword pool", Icon: Sparkles, iconClassName: "text-amber-500" },
  { key: "studyTypes", label: "Study Type Pool", manageLabel: "Manage study type pool", Icon: FileText, iconClassName: "text-cyan-500" },
  { key: "synonyms", label: "Synonyms", manageLabel: "Manage synonyms", Icon: RefreshCw, iconClassName: "text-muted-foreground", alwaysShowCount: true },
  { key: "exclusions", label: "Exclusions", manageLabel: "Manage exclusions", Icon: Ban, iconClassName: "text-muted-foreground" },
];

/**
 * Sidebar props — reduced from 37+ to 13 by using PoolsContext.
 * Pool data (keywords, study types, synonyms, exclusions) is consumed
 * directly from context instead of being threaded through props.
 */
interface SidebarProps {
  projects: Project[];
  tags: Tag[];
  onCreateProject: (name: string) => void;
  onCreateTag: (name: string) => void;
  onEditProject: (project: Project) => void;
  onDeleteProject: (projectId: string) => void;
  onEditTag: (tag: Tag) => void;
  onDeleteTag: (tagId: string) => void;
  availableKeywords: string[];
  availableStudyTypes: string[];
  // Dashboard wraps these with paper re-evaluation logic
  onDeletePoolStudyType: (id: string) => void;
  onDeleteAllPoolStudyTypes: () => void;
  onStudyTypePoolModalClose?: () => void;
  // Keyword/synonym pool change callbacks for dirty-flag reevaluation
  onKeywordPoolChange?: () => void;
  onKeywordPoolModalClose?: () => void;
  /**
   * Narrow-screen drawer state, owned by Dashboard because the trigger lives in
   * the Dashboard header (the rail itself is `display:none` below `md`, so it
   * cannot host its own trigger).
   */
  mobileNavOpen?: boolean;
  onMobileNavOpenChange?: (open: boolean) => void;
}

/** Counts shown on the taxonomy rows, resolved once per render. */
type NavCounts = Record<ManageKey, number>;

/** Every dialog the sidebar owns: the six taxonomy modals, Settings, Account. */
type ModalKey = ManageKey | "settings" | "account";

/**
 * The navigation body itself — brand, taxonomy rows, Settings and the Account
 * menu. Rendered by both the desktop rail and the narrow-screen drawer so the
 * two never drift; all state (including which modal is open) lives in the
 * parent `Sidebar`, which renders the modals outside both containers.
 */
function SidebarNav({
  counts,
  onManage,
  onOpenSettings,
  onOpenAccount,
  onOpenPrivacy,
}: {
  counts: NavCounts;
  onManage: (key: ManageKey) => void;
  onOpenSettings: () => void;
  onOpenAccount: () => void;
  onOpenPrivacy: () => void;
}) {
  const { user, signOut } = useAuth();

  /**
   * An Account-menu item that opens a dialog or leaves the page runs only once
   * the menu itself has finished closing.
   *
   * Radix returns focus to the menu's trigger from `onCloseAutoFocus`, and it
   * runs this consumer handler *first*, so a state update scheduled here is
   * flushed after that restore. Acting immediately instead would mount the
   * dialog while `document.activeElement` was still the menu item — an element
   * about to be unmounted — so the dialog would record a detached opener and
   * have nowhere to return focus to when it closed.
   *
   * Escape or an outside click leaves nothing parked, so dismissing the menu
   * performs no action.
   */
  const pendingMenuActionRef = useRef<(() => void) | null>(null);
  // Controlled so the Privacy item can close the menu itself: its click default
  // has to be prevented (see below), and a prevented default also suppresses
  // Radix's own "select closes the menu" handler.
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);

  const runAfterMenuClose = useCallback((action: () => void) => {
    pendingMenuActionRef.current = action;
  }, []);

  const handleMenuCloseAutoFocus = useCallback(() => {
    const pending = pendingMenuActionRef.current;
    pendingMenuActionRef.current = null;
    pending?.();
  }, []);

  return (
    <>
      <div className="flex items-center gap-2 px-4 py-4">
        <BookOpen className="h-6 w-6 text-primary" aria-hidden="true" />
        <span className="font-bold text-lg">PaperLume</span>
      </div>
      <ScrollArea className="flex-1 p-4">
        <div className="space-y-4">
          {/* Taxonomy & Settings section header */}
          <div className="px-0 py-2 mt-2">
            <h2 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Taxonomy & Settings</h2>
          </div>

          {NAV_ITEMS.map(({ key, label, manageLabel, Icon, iconClassName, alwaysShowCount }) => {
            const count = counts[key];
            return (
              <div key={key} className="flex items-center justify-between py-1 px-2">
                <div className="flex items-center gap-2">
                  <Icon className={`h-4 w-4 ${iconClassName}`} aria-hidden="true" />
                  <span className="text-sm font-medium text-muted-foreground">{label}</span>
                  {(alwaysShowCount || count > 0) && (
                    <Badge variant="secondary" className="text-xs">
                      {count}
                    </Badge>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  // Kept compact on the desktop rail; relaxed to a comfortable
                  // tap target on narrow screens, where these six controls sit
                  // in a single vertical stack.
                  className="h-9 w-9 md:h-6 md:w-6"
                  aria-label={manageLabel}
                  onClick={() => onManage(key)}
                >
                  <Settings className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            );
          })}

          {/* Settings */}
          <div className="pt-2 border-t">
            <Button variant="ghost" className="w-full justify-start" onClick={onOpenSettings}>
              <Settings className="mr-2 h-4 w-4" aria-hidden="true" />
              Settings
            </Button>
          </div>
        </div>
      </ScrollArea>

      {/* Account menu. The visible trigger stays the signed-in email address —
          it is what identifies *which* account these items act on. */}
      <div className="mt-auto border-t px-4 py-3">
        <DropdownMenu open={accountMenuOpen} onOpenChange={setAccountMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="w-full justify-start gap-2 text-sm"
              aria-label={user?.email ? `Account menu for ${user.email}` : "Account menu"}
            >
              <User className="h-4 w-4" aria-hidden="true" />
              <span className="truncate">{user?.email}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" onCloseAutoFocus={handleMenuCloseAutoFocus}>
            <DropdownMenuItem onSelect={() => runAfterMenuClose(onOpenAccount)}>
              <UserCog className="mr-2 h-4 w-4" aria-hidden="true" />
              Account
            </DropdownMenuItem>
            {/*
              A real <Link>, so the item carries an href — right-click, middle
              click and "open in new tab" all work, and the destination is
              resolved by the router rather than hard-coded to the canonical
              origin, so it is correct on localhost, on a Vercel Preview and in
              Production alike.

              A plain left click is intercepted so the navigation runs only
              after the menu — and, on a narrow screen, the drawer behind it —
              has closed, rather than tearing a modal layer down mid-navigation.
              Preventing the click default also suppresses Radix's own
              select-closes-the-menu handler (it is composed with
              `checkForDefaultPrevented`), which is why the menu is controlled
              and closed explicitly here.
            */}
            <DropdownMenuItem asChild>
              <Link
                to="/privacy"
                onClick={(event) => {
                  // A modified click (new tab/window) is left entirely alone —
                  // the browser handles it and Radix closes the menu as usual.
                  if (
                    event.defaultPrevented ||
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  ) {
                    return;
                  }
                  event.preventDefault();
                  runAfterMenuClose(onOpenPrivacy);
                  setAccountMenuOpen(false);
                }}
              >
                <ShieldCheck className="mr-2 h-4 w-4" aria-hidden="true" />
                Privacy Policy
              </Link>
            </DropdownMenuItem>
            {/* Everything above this line is non-session-ending. */}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={signOut}>
              <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}

export function Sidebar({
  projects,
  tags,
  onCreateProject,
  onCreateTag,
  onEditProject,
  onDeleteProject,
  onEditTag,
  onDeleteTag,
  availableKeywords,
  availableStudyTypes,
  onDeletePoolStudyType,
  onDeleteAllPoolStudyTypes,
  onStudyTypePoolModalClose,
  onKeywordPoolChange,
  onKeywordPoolModalClose,
  mobileNavOpen = false,
  onMobileNavOpenChange,
}: SidebarProps) {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const navigate = useNavigate();

  // Pool data from context (eliminates 24+ props)
  const {
    poolKeywords,
    addKeyword,
    addMultipleKeywords,
    deleteKeyword,
    deleteAllKeywords,
    synonymGroups,
    addSynonymGroup,
    updateSynonymGroup,
    deleteSynonymGroup,
    excludedKeywords,
    excludedStudyTypes,
    addExcludedKeyword,
    deleteExcludedKeyword,
    clearExcludedKeywords,
    addExcludedStudyType,
    deleteExcludedStudyType,
    clearExcludedStudyTypes,
    poolStudyTypes,
    addStudyType,
    addMultipleStudyTypes,
    updateStudyType,
    renameGroup,
    deleteGroup,
  } = usePools();

  const [synonymsModalOpen, setSynonymsModalOpen] = useState(false);
  const [exclusionsModalOpen, setExclusionsModalOpen] = useState(false);
  const [keywordPoolModalOpen, setKeywordPoolModalOpen] = useState(false);
  const [studyTypePoolModalOpen, setStudyTypePoolModalOpen] = useState(false);
  const [projectsModalOpen, setProjectsModalOpen] = useState(false);
  const [tagsModalOpen, setTagsModalOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [accountModalOpen, setAccountModalOpen] = useState(false);

  const totalExclusions = excludedKeywords.length + excludedStudyTypes.length;

  const counts: NavCounts = {
    projects: projects.length,
    tags: tags.length,
    keywords: poolKeywords.length,
    studyTypes: poolStudyTypes.length,
    synonyms: synonymGroups.length,
    exclusions: totalExclusions,
  };

  const openModal = useCallback((key: ModalKey) => {
    switch (key) {
      case "projects":
        setProjectsModalOpen(true);
        break;
      case "tags":
        setTagsModalOpen(true);
        break;
      case "keywords":
        setKeywordPoolModalOpen(true);
        break;
      case "studyTypes":
        setStudyTypePoolModalOpen(true);
        break;
      case "synonyms":
        setSynonymsModalOpen(true);
        break;
      case "exclusions":
        setExclusionsModalOpen(true);
        break;
      case "settings":
        setSettingsModalOpen(true);
        break;
      case "account":
        setAccountModalOpen(true);
        break;
    }
  }, []);

  /**
   * An action triggered from inside the narrow-screen drawer is deferred until
   * the drawer has actually finished closing.
   *
   * Opening a dialog immediately would stack a Dialog focus trap on top of a
   * Sheet focus trap, and — worse — the Dialog would capture its "opener" while
   * that opener was a button inside the closing drawer. Once the drawer
   * unmounted, that element was detached, so closing the Dialog had nowhere to
   * return focus to and it fell to `<body>`. Navigating away immediately has
   * the mirror-image problem: the drawer is torn down mid-close rather than
   * dismissed, leaving a modal layer that was never cleanly closed behind the
   * destination page.
   *
   * Instead the action is parked here and run from the Sheet's own
   * `onCloseAutoFocus` — a public Radix event fired at unmount, not a guessed
   * delay. Our `SheetContent` wrapper runs this consumer handler *before* it
   * restores focus, and the state update it schedules is flushed after that
   * restore, so by the time a Dialog mounts and records its opener the focused
   * element is the Dashboard navigation trigger: visible, connected, and still
   * mounted when the Dialog later closes.
   *
   * It holds a thunk rather than a modal key so that the one mechanism covers
   * every deferred outcome — the six taxonomy modals, Settings, the Account
   * dialog, and the client-side navigation to `/privacy`.
   */
  const pendingActionRef = useRef<(() => void) | null>(null);

  const runOrDefer = useCallback(
    (action: () => void) => {
      if (isMobile && mobileNavOpen) {
        pendingActionRef.current = action;
        onMobileNavOpenChange?.(false);
        return;
      }
      action();
    },
    [isMobile, mobileNavOpen, onMobileNavOpenChange],
  );

  const handleDrawerCloseAutoFocus = useCallback(() => {
    const pending = pendingActionRef.current;
    pendingActionRef.current = null;
    pending?.();
  }, []);

  const handleManage = useCallback(
    (key: ManageKey) => runOrDefer(() => openModal(key)),
    [openModal, runOrDefer],
  );
  const handleOpenSettings = useCallback(
    () => runOrDefer(() => openModal("settings")),
    [openModal, runOrDefer],
  );
  const handleOpenAccount = useCallback(
    () => runOrDefer(() => openModal("account")),
    [openModal, runOrDefer],
  );
  // Router navigation, not a hard-coded absolute URL: the same control has to
  // resolve `/privacy` on localhost, on a Vercel Preview and in Production.
  const handleOpenPrivacy = useCallback(
    () => runOrDefer(() => navigate("/privacy")),
    [navigate, runOrDefer],
  );

  const nav = (
    <SidebarNav
      counts={counts}
      onManage={handleManage}
      onOpenSettings={handleOpenSettings}
      onOpenAccount={handleOpenAccount}
      onOpenPrivacy={handleOpenPrivacy}
    />
  );

  return (
    <>
      {/* Desktop rail. Hidden below `md` via CSS (not JS) so a narrow first
          paint never flashes a 16rem rail, and `shrink-0` stops the flex row
          from squeezing it at intermediate widths. */}
      <aside className="hidden w-64 shrink-0 flex-col border-r bg-muted/30 md:flex">{nav}</aside>

      {/* Narrow-screen drawer. Mounted only below `md`, so the same controls
          are never present twice in one accessibility tree. Radix owns the
          focus trap, Escape handling and focus return to the header trigger. */}
      {isMobile && (
        <Sheet open={mobileNavOpen} onOpenChange={onMobileNavOpenChange}>
          <SheetContent
            side="left"
            className="flex w-[85vw] max-w-[20rem] flex-col gap-0 p-0 sm:max-w-[20rem]"
            onCloseAutoFocus={handleDrawerCloseAutoFocus}
          >
            <SheetHeader className="sr-only">
              <SheetTitle>PaperLume navigation</SheetTitle>
              <SheetDescription>
                Taxonomy, settings and account actions for your paper library.
              </SheetDescription>
            </SheetHeader>
            {nav}
          </SheetContent>
        </Sheet>
      )}

      {/* Modals live outside both the rail and the drawer: opening one from the
          drawer closes the drawer, and a modal nested inside it would unmount
          mid-interaction. */}
      <ManageProjectsModal
        open={projectsModalOpen}
        onOpenChange={setProjectsModalOpen}
        projects={projects}
        onCreateProject={onCreateProject}
        onEditProject={onEditProject}
        onDeleteProject={onDeleteProject}
      />
      <ManageTagsModal
        open={tagsModalOpen}
        onOpenChange={setTagsModalOpen}
        tags={tags}
        onCreateTag={onCreateTag}
        onEditTag={onEditTag}
        onDeleteTag={onDeleteTag}
      />
      <ManageSynonymsModal
        open={synonymsModalOpen}
        onOpenChange={(open) => {
          setSynonymsModalOpen(open);
          if (!open) onKeywordPoolModalClose?.();
        }}
        synonymGroups={synonymGroups}
        onAdd={async (...args) => { await addSynonymGroup(...args); onKeywordPoolChange?.(); }}
        onUpdate={async (...args) => { await updateSynonymGroup(...args); onKeywordPoolChange?.(); }}
        onDelete={async (id) => { await deleteSynonymGroup(id); onKeywordPoolChange?.(); }}
      />
      <ManageExclusionsModal
        open={exclusionsModalOpen}
        onOpenChange={setExclusionsModalOpen}
        excludedKeywords={excludedKeywords}
        excludedStudyTypes={excludedStudyTypes}
        onAddExcludedKeyword={addExcludedKeyword}
        onDeleteExcludedKeyword={deleteExcludedKeyword}
        onClearExcludedKeywords={clearExcludedKeywords}
        onAddExcludedStudyType={addExcludedStudyType}
        onDeleteExcludedStudyType={deleteExcludedStudyType}
        onClearExcludedStudyTypes={clearExcludedStudyTypes}
      />
      <ManageKeywordPoolModal
        open={keywordPoolModalOpen}
        onOpenChange={(open) => {
          setKeywordPoolModalOpen(open);
          if (!open) onKeywordPoolModalClose?.();
        }}
        poolKeywords={poolKeywords}
        availableKeywords={availableKeywords}
        onAddKeyword={async (kw) => { const r = await addKeyword(kw); onKeywordPoolChange?.(); return r; }}
        onAddMultipleKeywords={async (kws) => { const r = await addMultipleKeywords(kws); onKeywordPoolChange?.(); return r; }}
        onDeleteKeyword={(id) => { deleteKeyword(id); onKeywordPoolChange?.(); }}
        onDeleteAllKeywords={() => { deleteAllKeywords(); onKeywordPoolChange?.(); }}
      />
      <ManageStudyTypePoolModal
        open={studyTypePoolModalOpen}
        onOpenChange={(open) => {
          setStudyTypePoolModalOpen(open);
          if (!open) onStudyTypePoolModalClose?.();
        }}
        poolStudyTypes={poolStudyTypes}
        availableStudyTypes={availableStudyTypes}
        onAddStudyType={addStudyType}
        onAddMultipleStudyTypes={addMultipleStudyTypes}
        onUpdateStudyType={updateStudyType}
        onDeleteStudyType={onDeletePoolStudyType}
        onDeleteAllStudyTypes={onDeleteAllPoolStudyTypes}
        onRenameGroup={renameGroup}
        onDeleteGroup={deleteGroup}
      />
      <SettingsDialog
        open={settingsModalOpen}
        onOpenChange={setSettingsModalOpen}
        userId={user?.id}
      />
      <AccountDialog
        open={accountModalOpen}
        onOpenChange={setAccountModalOpen}
        userId={user?.id}
      />
    </>
  );
}
