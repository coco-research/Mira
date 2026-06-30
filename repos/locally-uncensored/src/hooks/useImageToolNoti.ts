import { useEffect } from "react";
import { useImageNotiStore } from "../stores/imageNotiStore";
import { isImageGenCapable } from "../lib/hardware";

// Module-level guard so the two consumers (Tools button + the dropdown row)
// don't both fire the hardware probe before either resolves.
let probeInFlight = false;

/**
 * Drives the image-tool discovery noti. Returns whether the noti should show
 * right now and a `dismiss()` that hides it for good.
 *
 *   visible = hardware-capable (VRAM≥12 OR RAM≥16) AND not yet clicked
 *
 * The hardware probe runs once per session (cached in the store); `dismiss()`
 * is persisted so the noti never returns after the first click.
 */
export function useImageToolNoti() {
  const seen = useImageNotiStore((s) => s.seen);
  const eligible = useImageNotiStore((s) => s.eligible);
  const setSeen = useImageNotiStore((s) => s.setSeen);

  useEffect(() => {
    if (eligible !== null || probeInFlight) return;
    probeInFlight = true;
    isImageGenCapable()
      .then((ok) => useImageNotiStore.getState().setEligible(ok))
      .catch(() => useImageNotiStore.getState().setEligible(false))
      .finally(() => {
        probeInFlight = false;
      });
  }, [eligible]);

  return {
    visible: eligible === true && !seen,
    dismiss: () => setSeen(true),
  };
}
