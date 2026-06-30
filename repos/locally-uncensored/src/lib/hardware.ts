/**
 * Hardware capability probes for UI gating (e.g. the image-tool discovery noti).
 *
 * Sources, both already shipped + registered as Tauri commands:
 *  - `detect_gpus`  → DetectedGpu[] with `memory_mib` (nvidia-smi / rocm-smi /
 *                     lspci / wmic → covers NVIDIA, AMD, Intel). Max across GPUs.
 *  - `system_info`  → `{ totalMemory: <bytes> }` (sysinfo). Total physical RAM.
 *
 * Both fail-soft to 0 (e.g. dev/browser where the command isn't wired, or a
 * machine with no vendor tool) so a probe failure simply means "not capable" —
 * the noti then stays hidden, which is the desired "sonst keine noti" behaviour.
 */

import { backendCall } from "../api/backend";

interface DetectedGpu {
  index: number;
  vendor: string;
  name: string;
  memory_mib: number | null;
  source: string;
}

/**
 * Pure threshold for "is image generation worth surfacing on this machine?".
 * David 2026-06-06: show the image-tool noti only when there is ≥12 GB VRAM
 * OR ≥16 GB system RAM — otherwise no noti.
 */
export function meetsImageGenThreshold(maxVramGb: number, totalRamGb: number): boolean {
  return maxVramGb >= 12 || totalRamGb >= 16;
}

/** Largest single-GPU VRAM in GB across all detected GPUs (0 if none/unknown). */
export async function getMaxVramGb(): Promise<number> {
  try {
    const gpus = await backendCall<DetectedGpu[]>("detect_gpus");
    const mibs = (Array.isArray(gpus) ? gpus : []).map((g) => g.memory_mib ?? 0);
    return mibs.length ? Math.max(...mibs) / 1024 : 0;
  } catch {
    return 0;
  }
}

/** Total physical RAM in GB (0 if unknown). */
export async function getTotalRamGb(): Promise<number> {
  try {
    const info = await backendCall<{ totalMemory?: number }>("system_info");
    const bytes = typeof info?.totalMemory === "number" ? info.totalMemory : 0;
    return bytes / 1_073_741_824;
  } catch {
    return 0;
  }
}

/** True when the machine clears the image-gen hardware bar (VRAM≥12 OR RAM≥16). */
export async function isImageGenCapable(): Promise<boolean> {
  const [vram, ram] = await Promise.all([getMaxVramGb(), getTotalRamGb()]);
  return meetsImageGenThreshold(vram, ram);
}
