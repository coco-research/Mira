import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Persisted state for the Cloud "Hosted LU Workflows" waitlist teaser badge.
 *
 * - `dismissed`: the user clicked "Don't show me again". This is the ONLY way
 *   the badge disappears — closing the popover or clicking outside leaves it.
 *   Persists across app restarts (zustand persist → localStorage `lu_cloud_teaser`).
 * - `submitted`: the user joined the waitlist. The badge intentionally STAYS
 *   (per the plan) but the popover then shows "You're on the list" instead of
 *   the form.
 */
interface CloudTeaserState {
  dismissed: boolean;
  submitted: boolean;
  setDismissed: (v: boolean) => void;
  setSubmitted: (v: boolean) => void;
}

export const useCloudTeaserStore = create<CloudTeaserState>()(
  persist(
    (set) => ({
      dismissed: false,
      submitted: false,
      setDismissed: (v) => set({ dismissed: v }),
      setSubmitted: (v) => set({ submitted: v }),
    }),
    { name: "lu_cloud_teaser" },
  ),
);
