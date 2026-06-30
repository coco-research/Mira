import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * State for the image-tool discovery noti — a small purple "1" badge on the
 * Image entry in the agent-mode Tools dropdown (+ a dot on the Tools button),
 * shown only on image-gen-capable hardware (see lib/hardware).
 *
 * - `seen` (persisted): the user has clicked the Image noti once. This is the
 *   ONLY thing that hides it, and it persists across restarts. Purely visual —
 *   acknowledging the noti does NOT toggle the image tool (David 2026-06-06:
 *   "nichts aktivieren rein optisch").
 * - `eligible` (transient): result of the one-shot hardware probe. `null` = not
 *   checked yet this session; re-probed every launch so a hardware change is
 *   always reflected.
 */
interface ImageNotiState {
  seen: boolean;
  eligible: boolean | null;
  setSeen: (v: boolean) => void;
  setEligible: (v: boolean) => void;
}

export const useImageNotiStore = create<ImageNotiState>()(
  persist(
    (set) => ({
      seen: false,
      eligible: null,
      setSeen: (v) => set({ seen: v }),
      setEligible: (v) => set({ eligible: v }),
    }),
    {
      name: "lu_image_tool_noti",
      // Only the dismissal persists; eligibility is re-probed each launch.
      partialize: (s) => ({ seen: s.seen }),
    },
  ),
);
